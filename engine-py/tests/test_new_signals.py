from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.signals.breakout import BreakoutStrategy
from engine.signals.regime import TrendRegimeStrategy
from engine.signals.registry import build_strategies
from engine.signals.xsmom import XSMomStrategy
from test_no_lookahead import _row, make_dataset

COMMON = {"market": "perp", "vol_target_annual": 0.2, "vol_lookback_days": 10, "max_gross_leverage": 2.0,
          "max_weight_per_asset": 0.25}
BREAKOUT = dict(COMMON, lookbacks_days=[5, 10, 20], rebalance_hours=24, allow_short=True)
XSMOM = dict(COMMON, formation_days=10, skip_days=1, rebalance_hours=24)
REGIME = dict(COMMON, lookbacks_days=[5, 10, 20], rebalance_hours=24, allow_short=True)
STRATS = [BreakoutStrategy(BREAKOUT), XSMomStrategy(XSMOM), TrendRegimeStrategy(REGIME)]


@pytest.mark.parametrize("strat", STRATS, ids=lambda s: s.name)
def test_causal(strat) -> None:
    data = make_dataset()
    full = strat.target_weights(data)
    rng = np.random.default_rng(1)
    nonzero = 0
    for t in rng.choice(full.perp.index, size=25, replace=False):
        t = pd.Timestamp(t)
        a, b = _row(full, t), _row(strat.target_weights(data.truncate(t)), t)
        pd.testing.assert_series_equal(a, b, check_names=False)
        nonzero += int((a.abs() > 0).any())
    assert nonzero > 3


@pytest.mark.parametrize("strat", STRATS, ids=lambda s: s.name)
def test_bounded(strat) -> None:
    w = strat.target_weights(make_dataset(3)).perp.fillna(0.0)
    assert np.isfinite(w.to_numpy()).all()
    assert (w.abs() <= 0.25 + 1e-12).all().all()
    assert (w.abs().sum(axis=1) <= 2.0 + 1e-9).all()


def test_xsmom_dollar_neutral() -> None:
    w = XSMomStrategy(XSMOM).target_weights(make_dataset(5)).perp.fillna(0.0)
    assert (w.abs().sum(axis=1) > 0).sum() > 10
    assert (w.sum(axis=1).abs() < 1e-9).all()


def test_registry_new() -> None:
    cfg = {"strategies": {"breakout": dict(BREAKOUT, enabled=True), "xsmom": dict(XSMOM, enabled=True),
                          "trend_regime": dict(REGIME, enabled=False)}}
    assert [s.name for s in build_strategies(cfg)] == ["breakout", "xsmom"]
