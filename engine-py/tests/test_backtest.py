from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import pytest

from engine.backtest.engine import run_backtest
from engine.backtest.portfolio import benchmark_buy_hold, combine
from engine.contracts import CostBreakdown, Dataset, MarketData, TargetWeights


@dataclass
class StubCost:
    fee_rate: float = 0.0

    def trade_cost(self, symbol, market, notional_abs, price, adv_quote, daily_vol) -> CostBreakdown:
        return CostBreakdown(fees=self.fee_rate * notional_abs)


def _md(opens: dict[str, list[float]], closes: dict[str, list[float]], idx) -> MarketData:
    o = pd.DataFrame(opens, index=idx, dtype=float)
    c = pd.DataFrame(closes, index=idx, dtype=float)
    z = pd.DataFrame(1e9, index=idx, columns=o.columns)
    return MarketData(open=o, high=c, low=c, close=c, volume=z, quote_volume=z,
                      is_filled=pd.DataFrame(False, index=idx, columns=o.columns))


def _idx(n: int) -> pd.DatetimeIndex:
    return pd.date_range("2024-01-01", periods=n, freq="h", tz="UTC")


def _ds(spot_o, spot_c, perp_o=None, perp_c=None, funding=None, n=None) -> Dataset:
    idx = _idx(n or len(next(iter(spot_c.values()))))
    empty = pd.DataFrame(index=idx)
    perp = _md(perp_o, perp_c, idx) if perp_o else MarketData(*([empty] * 7))
    return Dataset(spot=_md(spot_o, spot_c, idx), perp=perp,
                   funding=funding if funding is not None else pd.DataFrame())


@dataclass
class Fixed:
    spot: pd.DataFrame
    perp: pd.DataFrame
    name: str = "fixed"

    def target_weights(self, data: Dataset) -> TargetWeights:
        return TargetWeights(spot=self.spot, perp=self.perp)


def _none(idx) -> pd.DataFrame:
    return pd.DataFrame(index=idx[:0])


def test_fill_at_next_open_not_same_bar():
    # decision at bar 0; jump happens between bar0 close (100) and bar1 open (200)
    ds = _ds({"X": [100, 200, 200, 200]}, {"X": [100, 200, 200, 200]})
    idx = ds.spot.close.index
    s = Fixed(pd.DataFrame({"X": [1.0]}, index=idx[:1]), _none(idx))
    r = run_backtest(s, ds, StubCost(), 1000.0)
    assert r.trades.iloc[0]["ts"] == idx[1]
    assert r.trades.iloc[0]["price"] == 200
    assert np.allclose(r.equity.to_numpy(), 1000.0)  # bought after the jump: no gain


def test_constant_long_reproduces_asset_return():
    c = [100.0, 101, 99, 105, 110, 108]
    o = [100.0, 100.5, 101, 99, 105, 110]
    ds = _ds({"X": o}, {"X": c})
    idx = ds.spot.close.index
    s = Fixed(pd.DataFrame({"X": [1.0]}, index=idx[:1]), _none(idx))
    r = run_backtest(s, ds, StubCost(), 1000.0)
    # from bar 1 on, equity = 1000 * close / open[1]
    exp = 1000.0 * np.array(c[1:]) / o[1]
    assert np.allclose(r.equity.to_numpy()[1:], exp)
    assert r.costs.to_numpy().sum() == 0


def test_costs_reduce_equity_exactly():
    ds = _ds({"X": [100.0] * 4}, {"X": [100.0] * 4})
    idx = ds.spot.close.index
    s = Fixed(pd.DataFrame({"X": [1.0, 0.0]}, index=idx[[0, 1]]), _none(idx))
    r = run_backtest(s, ds, StubCost(fee_rate=0.001), 1000.0)
    buy_fee = 0.001 * 1000.0
    sell_fee = 0.001 * 1000.0  # full 1000 notional bought; fee paid from cash
    assert r.trades["fee"].tolist() == pytest.approx([buy_fee, sell_fee])
    assert r.equity.iloc[-1] == pytest.approx(1000.0 - buy_fee - sell_fee)
    assert r.costs["fees"].sum() == pytest.approx(buy_fee + sell_fee)


def test_short_perp_positive_funding_gains():
    n = 12
    idx = _idx(n)
    p = {"X": [100.0] * n}
    funding = pd.DataFrame({"X": [0.001]}, index=idx[[8]])
    ds = _ds({"Y": [1.0] * n}, {"Y": [1.0] * n}, p, p, funding)
    s = Fixed(_none(idx), pd.DataFrame({"X": [-1.0]}, index=idx[:1]))
    r = run_backtest(s, ds, StubCost(), 1000.0)
    assert r.costs["funding"].sum() == pytest.approx(-1.0)  # received 0.1% of 1000 notional
    assert r.equity.iloc[-1] == pytest.approx(1001.0)


def test_delisting_forced_exit():
    nan = float("nan")
    ds = _ds({"X": [100, 100, 120, nan, nan]}, {"X": [100, 100, 120, nan, nan]})
    idx = ds.spot.close.index
    s = Fixed(pd.DataFrame({"X": [1.0]}, index=idx[:1]), _none(idx))
    r = run_backtest(s, ds, StubCost(fee_rate=0.001), 1000.0)
    fx = r.trades[r.trades["side"] == "forced_exit"]
    assert len(fx) == 1 and fx.iloc[0]["price"] == 120 and fx.iloc[0]["ts"] == idx[3]
    held = 1000.0 * 1.2  # cash = -1 (buy fee)
    assert fx.iloc[0]["fee"] == pytest.approx(2 * 0.001 * held)
    assert r.positions["spot"]["X"].iloc[-1] == 0
    assert r.equity.iloc[-1] == pytest.approx(held - 1.0 - 2 * 0.001 * held)


def test_stale_fill_bar_is_skipped_and_retried():
    # frozen/stale bar at the fill time: the trade must be skipped (not filled at a stale price) and
    # retried at the next decision. Exercises the clean.py frozen-bar fix flowing into execution.
    idx = _idx(5)
    o = pd.DataFrame({"X": [100.0, 100, 100, 100, 100]}, index=idx)
    c = o.copy()
    z = pd.DataFrame(1e9, index=idx, columns=["X"])
    fil = pd.DataFrame({"X": [False, True, False, False, False]}, index=idx)  # bar 1 is stale
    spot = MarketData(open=o, high=c, low=c, close=c, volume=z, quote_volume=z, is_filled=fil)
    empty = pd.DataFrame(index=idx)
    ds = Dataset(spot=spot, perp=MarketData(*([empty] * 7)), funding=pd.DataFrame())
    # decide at bar 0 (fills at stale bar 1 -> skipped) and again at bar 2 (fills at real bar 3)
    s = Fixed(pd.DataFrame({"X": [1.0, 1.0]}, index=idx[[0, 2]]), _none(idx))
    r = run_backtest(s, ds, StubCost(), 1000.0)
    assert r.meta["n_skipped_stale"] == 1
    assert len(r.trades) == 1 and r.trades.iloc[0]["ts"] == idx[3]


def test_negative_spot_weight_raises():
    ds = _ds({"X": [100.0] * 3}, {"X": [100.0] * 3})
    idx = ds.spot.close.index
    s = Fixed(pd.DataFrame({"X": [-0.5]}, index=idx[:1]), _none(idx))
    with pytest.raises(ValueError):
        run_backtest(s, ds, StubCost(), 1000.0)


def test_combine_sums_sleeves():
    ds = _ds({"X": [100.0, 100, 110, 121]}, {"X": [100.0, 110, 121, 121]})
    idx = ds.spot.close.index
    long_ = Fixed(pd.DataFrame({"X": [1.0]}, index=idx[:1]), _none(idx))
    flat = Fixed(_none(idx), _none(idx))
    a = run_backtest(long_, ds, StubCost(), 600.0)
    b = run_backtest(flat, ds, StubCost(), 400.0)
    comb = combine({"a": a, "b": b}, {"a": 0.6, "b": 0.4}, 1000.0)
    assert np.allclose(comb.equity.to_numpy(), (a.equity + b.equity).to_numpy())
    bh = benchmark_buy_hold(ds, "X", "spot", 1000.0, StubCost())
    assert bh.equity.iloc[-1] == pytest.approx(1000.0 * 121 / 100)


def test_equity_never_negative():
    p = {"X": [100.0, 100, 300, 400, 500]}
    idx = _idx(5)
    ds = _ds({"Y": [1.0] * 5}, {"Y": [1.0] * 5}, p, p)
    s = Fixed(_none(idx), pd.DataFrame({"X": [-1.0]}, index=idx[:1]))
    r = run_backtest(s, ds, StubCost(), 1000.0)
    assert r.meta["ruined"] is True
    assert (r.equity >= 0).all()
    assert r.equity.iloc[-1] == 0
