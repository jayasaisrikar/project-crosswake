from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from engine.contracts import MarketData
from engine.costs import CostModel, rolling_adv_and_vol

CFG = {"fee_bps": {"spot": 10.0, "perp": 5.0}, "half_spread_bps": {"BTC": 0.5, "default": 2.0},
       "impact_y": 0.7, "stress_multiplier": 1.0}


def test_fee_and_spread_linear() -> None:
    m = CostModel.from_config(CFG)
    a = m.trade_cost("BTC", "spot", 1000, 50000, 1e12, 0.03)
    b = m.trade_cost("BTC", "spot", 2000, 50000, 1e12, 0.03)
    assert a.fees == pytest.approx(1.0)
    assert a.spread == pytest.approx(0.05)
    assert b.fees == pytest.approx(2 * a.fees)
    assert b.spread == pytest.approx(2 * a.spread)
    c = m.trade_cost("XYZ", "perp", 1000, 1, 1e12, 0.03)
    assert c.spread == pytest.approx(0.2)
    assert c.fees == pytest.approx(0.5)


def test_impact_sqrt_scaling() -> None:
    m = CostModel.from_config(CFG)
    a = m.trade_cost("BTC", "perp", 1e4, 1, 1e8, 0.03)
    b = m.trade_cost("BTC", "perp", 4e4, 1, 1e8, 0.03)
    assert a.impact == pytest.approx(0.7 * 0.03 * math.sqrt(1e-4) * 1e4)
    assert b.impact / 4e4 == pytest.approx(2 * a.impact / 1e4)


def test_multiplier_scales_all() -> None:
    base = CostModel.from_config(CFG).trade_cost("ETH", "spot", 5e4, 1, 1e7, 0.04)
    s = CostModel.from_config(CFG, multiplier=2.0).trade_cost("ETH", "spot", 5e4, 1, 1e7, 0.04)
    assert s.fees == pytest.approx(2 * base.fees)
    assert s.spread == pytest.approx(2 * base.spread)
    assert s.impact == pytest.approx(2 * base.impact)
    assert s.total == pytest.approx(2 * base.total)


@pytest.mark.parametrize("adv", [None, 0.0, float("nan")])
def test_missing_adv_is_conservative(adv) -> None:
    m = CostModel.from_config(CFG)
    liquid = m.trade_cost("ETH", "perp", 1e4, 1, 1e8, 0.04)
    missing = m.trade_cost("ETH", "perp", 1e4, 1, adv, 0.04)
    assert missing.impact > 10 * liquid.impact
    assert missing.impact == pytest.approx(0.7 * 0.04 * 1e4)


def test_rolling_adv_vol_causal() -> None:
    idx = pd.date_range("2024-01-01", periods=500, freq="h", tz="UTC")
    rng = np.random.default_rng(0)
    close = pd.DataFrame({"A": 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 500)))}, index=idx)
    qv = pd.DataFrame({"A": rng.uniform(1, 2, 500)}, index=idx)
    filled = pd.DataFrame(False, index=idx, columns=["A"])
    md = MarketData(close, close, close, close, qv, qv, filled)
    adv, vol = rolling_adv_and_vol(md, days=5)
    t = idx[300]
    adv2, vol2 = rolling_adv_and_vol(md.truncate(t), days=5)
    assert adv.loc[t, "A"] == adv2.loc[t, "A"]
    assert vol.loc[t, "A"] == vol2.loc[t, "A"]
    qv3 = qv.copy()
    qv3.loc[t, "A"] = 1e9  # bar t itself must not leak into the value at t
    md3 = MarketData(close, close, close, close, qv3, qv3, filled)
    assert rolling_adv_and_vol(md3, days=5)[0].loc[t, "A"] == adv.loc[t, "A"]
    assert adv.loc[t, "A"] == pytest.approx(qv["A"].iloc[300 - 120:300].mean() * 24)


def test_impact_units_daily_participation() -> None:
    # $1m order vs $100m/day ADV at 4% daily vol: 0.7 * 0.04 * sqrt(0.01) = 28 bps of notional
    m = CostModel.from_config(CFG)
    assert m.participation(1e6, 1e8) == pytest.approx(0.01)
    c = m.trade_cost("BTC", "perp", 1e6, 1, 1e8, 0.04)
    assert c.impact / 1e6 * 1e4 == pytest.approx(28.0)
    assert m.participation(5e8, 1e8) == 1.0  # capped


def test_spread_resolution_order(tmp_path) -> None:
    import json

    f = tmp_path / "spreads.json"
    f.write_text(json.dumps({"perp": {"BTC": {"median": 0.1, "p75": 0.2, "p95": 0.9, "source": "bookTicker"}},
                             "spot": {"ETH": {"median": 3.0, "p75": 4.0, "p95": 9.0}}}))
    cfg = {**CFG, "spreads_file": str(f), "half_spread_override_bps": {"spot": {"ETH": 1.5}}}
    m = CostModel.from_config(cfg)
    assert m.half_spread("BTC", "perp") == pytest.approx(0.2)    # measured p75
    assert m.half_spread("BTC", "spot") == pytest.approx(0.5)    # config fallback (flat)
    assert m.half_spread("ETH", "spot") == pytest.approx(1.5)    # override beats measured
    assert m.half_spread("XYZ", "perp") == pytest.approx(2.0)    # default
    assert m.half_spread("BTC") == pytest.approx(0.5)            # legacy call without market
    assert m.trade_cost("BTC", "perp", 1e4, 1, 1e12, 0.03).spread == pytest.approx(0.2)
    assert m.with_multiplier(2.0).half_spread("BTC", "perp") == pytest.approx(0.2)
    m95 = CostModel.from_config({**cfg, "spread_stat": "p95"})
    assert m95.half_spread("BTC", "perp") == pytest.approx(0.9)


def test_missing_spreads_file_falls_back(tmp_path) -> None:
    m = CostModel.from_config({**CFG, "spreads_file": str(tmp_path / "nope.json")})
    assert m.half_spread("BTC", "perp") == pytest.approx(0.5)


def test_config_spreads_file_relative_to_base_dir(tmp_path) -> None:
    import json

    (tmp_path / "s.json").write_text(json.dumps({"perp": {"SOL": {"p75": 1.25}}}))
    m = CostModel.from_config({**CFG, "spreads_file": "s.json"}, base_dir=tmp_path)
    assert m.half_spread("SOL", "perp") == pytest.approx(1.25)
