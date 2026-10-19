from __future__ import annotations

import numpy as np
import pandas as pd

from engine.signals.carry import CarryStrategy
from test_no_lookahead import _row, make_dataset

P = {"entry_funding_annual": 0.10, "exit_funding_annual": 0.02, "funding_lookback_hours": 72,
     "max_weight_per_asset": 0.2, "max_gross": 1.0, "rebalance_hours": 24, "max_positions": 5,
     "no_trade_band": 0.25, "min_hold_days": 14, "entry_cost_margin": 2.0}


def test_trailing_apr_interval_agnostic() -> None:
    s = CarryStrategy(P)
    t0 = pd.Timestamp("2024-01-01", tz="UTC")
    i8 = pd.date_range(t0, periods=40, freq="8h")
    i1 = pd.date_range(t0, periods=320, freq="1h")
    t = i1[-1]
    a8 = s.trailing_apr(pd.DataFrame({"A": 0.0001}, index=i8), t)["A"]
    a1 = s.trailing_apr(pd.DataFrame({"A": 0.0001 / 8}, index=i1), t)["A"]
    assert np.isclose(a8, 0.0001 * 3 * 365) and np.isclose(a1, a8)


def test_fixed_weight_and_cost_gate() -> None:
    s = CarryStrategy(P)
    assert s.weight == 0.1
    assert not s.entry_ok(0.12)        # 0.12*14/365 = 0.46% < 2 * 0.38% round trip
    assert s.entry_ok(0.30)


def test_weights_not_renormalised() -> None:
    tw = CarryStrategy(P).target_weights(make_dataset())
    w = tw.spot
    assert set(np.round(np.unique(w.to_numpy()), 12)) <= {0.0, 0.1}
    assert (w.abs().sum(axis=1) <= 0.5 + 1e-12).all()
    assert (w.index.hour == 0).all()


def test_carry_causal_with_cost_params() -> None:
    data = make_dataset()
    strat = CarryStrategy(P)
    full = strat.target_weights(data)
    rng = np.random.default_rng(3)
    for t in rng.choice(full.spot.index, size=15, replace=False):
        t = pd.Timestamp(t)
        pd.testing.assert_series_equal(_row(full, t), _row(strat.target_weights(data.truncate(t)), t),
                                       check_names=False)
