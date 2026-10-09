from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
import pandas as pd
import pytest

from engine.backtest.engine import run_backtest
from engine.contracts import BacktestResult, Dataset, MarketData, TargetWeights
from engine.costs import CostModel
from engine.validation.reconcile import reconcile

CFG = {"fee_bps": {"spot": 10.0, "perp": 5.0},
       "half_spread_bps": {"perp": {"BTC": 0.3}, "BTC": 0.5, "default": 2.0},
       "impact_y": 0.7, "stress_multiplier": 1.5}


def _md(n: int, syms: list[str], seed: int, delist: str | None = None) -> MarketData:
    idx = pd.date_range("2024-01-01", periods=n, freq="h", tz="UTC")
    rng = np.random.default_rng(seed)
    c = pd.DataFrame({s: 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n))) for s in syms}, index=idx)
    o = c.shift(1) * np.exp(rng.normal(0, 0.002, c.shape))
    o.iloc[0] = c.iloc[0]
    qv = pd.DataFrame(rng.uniform(1e5, 5e5, c.shape), index=idx, columns=syms)
    if delist:
        for f in (c, o, qv):
            f.loc[idx[-40]:, delist] = np.nan
    filled = pd.DataFrame(False, index=idx, columns=syms)
    return MarketData(o, np.maximum(o, c), np.minimum(o, c), c, qv / c, qv, filled)


@dataclass
class Fixed:
    w_spot: pd.DataFrame
    w_perp: pd.DataFrame
    name: str = "fixed"

    def target_weights(self, data: Dataset) -> TargetWeights:
        return TargetWeights(spot=self.w_spot, perp=self.w_perp)


def _setup() -> tuple[BacktestResult, CostModel, Dataset]:
    n = 300
    spot = _md(n, ["BTC", "ETH"], 1)
    perp = _md(n, ["BTC", "ETH"], 2, delist="ETH")
    idx = spot.close.index
    fidx = idx[8::8]
    funding = pd.DataFrame({"BTC": 1e-4, "ETH": -5e-5}, index=fidx)
    ds = Dataset(spot, perp, funding)
    rng = np.random.default_rng(3)
    dec = idx[24::12]
    ws = pd.DataFrame(rng.uniform(0, 0.4, (len(dec), 2)), index=dec, columns=["BTC", "ETH"])
    wp = pd.DataFrame(rng.uniform(-0.4, 0.4, (len(dec), 2)), index=dec, columns=["BTC", "ETH"])
    model = CostModel.from_config(CFG)
    res = run_backtest(Fixed(ws, wp), ds, model, 1e6)
    return res, model, ds


def test_clean_result_reconciles_exactly() -> None:
    res, model, ds = _setup()
    assert len(res.trades) > 20
    assert (res.trades["side"] == "forced_exit").any()
    assert res.costs["funding"].abs().sum() > 0
    out = reconcile(res, model, data=ds)
    assert out["ok"], out["discrepancies"]
    assert out["n_discrepancies"] == 0
    t = out["totals"]
    assert t["net_pnl"] == pytest.approx(t["gross_pnl"] - t["fees"] - t["spread"] - t["impact"]
                                         - t["funding_paid"], abs=1e-4)


def test_without_data_still_checks_fees_and_identity() -> None:
    res, model, _ = _setup()
    out = reconcile(res, model)
    assert out["ok"]
    assert "per_trade_max_impact_diff" not in set(out["table"]["check"])


def test_corrupted_cost_table_flagged() -> None:
    res, model, ds = _setup()
    costs = res.costs.copy()
    costs.iloc[100, costs.columns.get_loc("fees")] += 50.0  # costs reported but never charged
    out = reconcile(replace(res, costs=costs), model, data=ds)
    assert not out["ok"]
    bad = set(out["discrepancies"]["check"])
    assert {"total_fees", "identity_max_bar_residual"} <= bad


def test_corrupted_trade_fee_flagged() -> None:
    res, model, ds = _setup()
    tr = res.trades.copy()
    tr.loc[0, "fee"] *= 0.5  # under-charged leg
    out = reconcile(replace(res, trades=tr), model, data=ds)
    assert "per_trade_max_fee_diff" in set(out["discrepancies"]["check"])


def test_wrong_cost_model_flagged() -> None:
    res, _, ds = _setup()
    other = CostModel.from_config({**CFG, "impact_y": 0.35, "fee_bps": {"spot": 7.5, "perp": 4.5}})
    bad = set(reconcile(res, other, data=ds)["discrepancies"]["check"])
    assert {"per_trade_max_fee_diff", "per_trade_max_impact_diff"} <= bad


def test_corrupted_equity_flagged() -> None:
    res, model, ds = _setup()
    eq = res.equity.copy()
    eq.iloc[150:] += 10.0
    assert "identity_max_bar_residual" in set(reconcile(replace(res, equity=eq), model,
                                                        data=ds)["discrepancies"]["check"])
