"""Audit attribution / ledger helpers on synthetic data."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.audit import core
from engine.backtest.engine import run_backtest
from engine.contracts import Dataset, MarketData, TargetWeights
from engine.costs import CostModel

IDX = pd.date_range("2022-12-31 20:00", periods=8, freq="h", tz="UTC")


def _frame(vals: list[float]) -> pd.DataFrame:
    return pd.DataFrame({"X": vals}, index=IDX)


def test_leg_pnl_long_short_flip() -> None:
    close = _frame([100, 110, 120, 100, 90, 90, 80, 80])
    open_ = close.shift(1).fillna(100.0)
    open_.iloc[3] = 115.0  # gap: bar 3 opens at 115 (prev close 120), closes at 100
    # long 1 unit from bar 1, flip to short 2 units at the open of bar 3, flat from bar 6
    q = _frame([0, 1, 1, -2, -2, -2, 0, 0])
    pos = q * close
    legs = core.leg_pnl(pos, open_, close)
    # long leg: bar 1 (+10), bar 2 (+10), bar 3 old units 115-120 = -5
    assert legs["long"]["X"].sum() == pytest.approx(10 + 10 - 5)
    # short leg: bar 3 new units -2*(100-115)=+30, bar 4 -2*(90-100)=+20, bar 5 0, bar 6 exit at open 90: 0
    assert legs["short"]["X"].sum() == pytest.approx(30 + 20)
    np.testing.assert_allclose(legs["gross"]["X"], legs["long"]["X"] + legs["short"]["X"])


def test_ledger_gross_matches_price_split() -> None:
    close = _frame([100, 110, 120, 100, 90, 90, 80, 80])
    open_ = close.shift(1).fillna(100.0)
    q = _frame([0, 1, 1, -2, -2, -2, 0, 0])
    pos = q * close
    dq = q.diff().fillna(q)
    trades = pd.DataFrame({"ts": IDX, "symbol": "X", "market": "perp",
                           "qty_notional": (dq["X"] * open_["X"]).to_numpy(), "fee": 0.0, "spread": 0.0,
                           "impact": 0.0})
    trades = trades[trades["qty_notional"] != 0]
    led = core.ledger_gross(pos, trades, "perp")
    legs = core.leg_pnl(pos, open_, close)
    np.testing.assert_allclose(led["X"].to_numpy(), legs["gross"]["X"].to_numpy(), atol=1e-9)


def test_attribution_table_years_costs_funding() -> None:
    close = _frame([100, 110, 120, 100, 90, 90, 80, 80])
    open_ = close.shift(1).fillna(100.0)
    q = _frame([0, 1, 1, -2, -2, -2, 0, 0])
    pos = q * close
    dq = q.diff().fillna(q)
    trades = pd.DataFrame({"ts": IDX, "symbol": "X", "market": "perp",
                           "qty_notional": (dq["X"] * open_["X"]).to_numpy(), "fee": 1.0, "spread": 0.5,
                           "impact": 0.25})
    trades = trades[trades["qty_notional"] != 0]
    fund = _frame([0, 0, 0, 0, 0.0, -3.0, 0, 0])  # received 3 (short, positive rate) in 2023
    tab = core.attribution_table(pos, open_, close, trades, fund, "perp")
    assert set(tab.index.get_level_values("year")) == {2022, 2023}
    tot = tab.sum()
    assert tot["gross_long"] == pytest.approx(20.0)          # +10 on bars 1 and 2 (2022)
    assert tab.loc[(2022, "X"), "gross_long"] == pytest.approx(20.0)
    assert tot["gross_short"] == pytest.approx(60.0)         # -2*(100-120) on bar 3, -2*(90-100) on bar 4
    assert tot["costs"] == pytest.approx(3 * 1.75)
    assert tot["funding"] == pytest.approx(-3.0)
    assert tot["net"] == pytest.approx(tot["gross"] - 3 * 1.75 + 3.0)
    assert tab["residual_vs_ledger"].abs().max() < 1e-9


def _md(close: pd.DataFrame) -> MarketData:
    o = close.shift(1).fillna(close.iloc[0])
    f = pd.DataFrame(False, index=close.index, columns=close.columns)
    hi, lo = np.maximum(o, close), np.minimum(o, close)
    return MarketData(o, hi, lo, close, close * 0 + 1e6, close * 0 + 1e8, f)


class _Fixed:
    name = "fixed"

    def __init__(self, w: pd.DataFrame) -> None:
        self.w = w

    def target_weights(self, data: Dataset) -> TargetWeights:
        return TargetWeights(spot=pd.DataFrame(index=self.w.index), perp=self.w)


def test_engine_funding_and_identity_match_independent_ledger() -> None:
    idx = pd.date_range("2024-01-01", periods=48, freq="h", tz="UTC")
    rng = np.random.default_rng(3)
    c = pd.DataFrame({"X": 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 48)))}, index=idx)
    md = _md(c)
    fts = pd.DatetimeIndex([idx[8], idx[16], idx[20], idx[24], idx[40]]) + pd.Timedelta(milliseconds=3)
    funding = pd.DataFrame({"X": [0.001, -0.002, 0.0005, 0.001, 0.003]}, index=fts)
    data = Dataset(md, md, funding)
    w = pd.DataFrame({"X": [-0.5, 0.8, 0.0]}, index=[idx[2], idx[18], idx[30]])
    cm = CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.7)
    res = run_backtest(_Fixed(w), data, cm, 10_000.0)
    led = core.funding_ledger(res.positions["perp"], funding, core.bar_index(data))
    assert float(led["paid"].sum()) == pytest.approx(float(res.costs["funding"].sum()), abs=1e-9)
    assert len(led) == 4  # idx[40] event: flat by then
    assert core.equity_identity(res).abs().max() < 1e-8


def test_frozen_mask_and_runs() -> None:
    c = pd.Series([1.0, 2.0, 2.0, 2.0, 2.0, 3.0], index=IDX[:6])
    v = pd.Series([5.0, 5.0, 0.0, 0.0, 0.0, 5.0], index=IDX[:6])
    fz = core.frozen_mask(c, c, c, c, v)
    assert fz.tolist() == [False, False, True, True, True, False]
    r = core.runs(fz, 2)
    assert len(r) == 1 and r["n"].iloc[0] == 3
