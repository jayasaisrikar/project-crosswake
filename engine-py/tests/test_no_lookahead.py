"""CAUSALITY RULE: f(data.truncate(t)).loc[t] == f(data).loc[t]."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData, TargetWeights
from engine.signals.carry import CarryStrategy
from engine.signals.trend import TrendStrategy

SYMS = ["AAA", "BBB", "CCC", "DDD"]
N = 2000


def _market(close: pd.DataFrame, rng: np.random.Generator) -> MarketData:
    vol = pd.DataFrame(rng.uniform(10, 100, close.shape), index=close.index, columns=close.columns)
    vol = vol.where(close.notna())
    filled = pd.DataFrame(False, index=close.index, columns=close.columns)
    filled.iloc[700:740, 1] = True  # a stale stretch > 24 bars
    return MarketData(open=close, high=close * 1.001, low=close * 0.999, close=close, volume=vol,
                      quote_volume=vol * close, is_filled=filled)


def make_dataset(seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2022-01-01", periods=N, freq="h", tz="UTC")
    rets = rng.normal(0.0002, 0.01, (N, len(SYMS)))
    close = pd.DataFrame(100 * np.exp(np.cumsum(rets, axis=0)), index=idx, columns=SYMS)
    close.iloc[:600, 2] = np.nan     # CCC listed late
    close.iloc[1500:, 3] = np.nan    # DDD delisted early
    spot_close = close * (1 + rng.normal(0, 1e-4, close.shape))
    fidx = idx[idx.hour % 8 == 0]
    base = np.array([0.0003, 0.00005, 0.0002, -0.0001])
    fund = pd.DataFrame(base + rng.normal(0, 0.0002, (len(fidx), len(SYMS))), index=fidx, columns=SYMS)
    fund = fund.where(close.reindex(fidx).notna())
    return Dataset(spot=_market(spot_close, rng), perp=_market(close, rng), funding=fund)


TREND = {"market": "perp", "lookbacks_days": [5, 10, 20], "vol_target_annual": 0.2, "vol_lookback_days": 10,
         "rebalance_hours": 24, "max_gross_leverage": 2.0, "max_weight_per_asset": 0.25, "allow_short": True}
CARRY = {"entry_funding_annual": 0.10, "exit_funding_annual": 0.02, "funding_lookback_hours": 72,
         "max_weight_per_asset": 0.2, "max_gross": 1.0}
STRATS = [TrendStrategy(TREND), CarryStrategy(CARRY)]


def _row(tw: TargetWeights, t: pd.Timestamp) -> pd.Series:
    parts = []
    for name, f in (("spot", tw.spot), ("perp", tw.perp)):
        if t in f.index:
            parts.append(f.loc[t].fillna(0.0).add_prefix(name + ":"))
    return pd.concat(parts).sort_index() if parts else pd.Series(dtype=float)


@pytest.mark.parametrize("strat", STRATS, ids=lambda s: s.name)
def test_truncation_invariance(strat) -> None:
    data = make_dataset()
    full = strat.target_weights(data)
    rng = np.random.default_rng(1)
    nonzero = 0
    for t in rng.choice(full.perp.index, size=30, replace=False):
        t = pd.Timestamp(t)
        trunc = strat.target_weights(data.truncate(t))
        a, b = _row(full, t), _row(trunc, t)
        pd.testing.assert_series_equal(a, b, check_names=False)
        nonzero += int((a.abs() > 0).any())
    assert nonzero > 5  # the test exercises non-trivial weights


def _perturb_after(data: Dataset, t: pd.Timestamp, rng: np.random.Generator) -> Dataset:
    def pm(md: MarketData) -> MarketData:
        c = md.close.copy()
        mask = c.index > t
        c.loc[mask] = c.loc[mask] * rng.uniform(0.5, 2.0, c.loc[mask].shape)
        f = md.is_filled.copy()
        f.loc[mask] = True
        return MarketData(open=c, high=c, low=c, close=c, volume=md.volume, quote_volume=md.quote_volume,
                          is_filled=f)

    fund = data.funding.copy()
    fund.loc[fund.index > t] = 0.01
    return Dataset(spot=pm(data.spot), perp=pm(data.perp), funding=fund)


@pytest.mark.parametrize("strat", STRATS, ids=lambda s: s.name)
def test_future_perturbation_does_not_change_past(strat) -> None:
    data = make_dataset()
    full = strat.target_weights(data)
    rng = np.random.default_rng(2)
    for t in rng.choice(full.perp.index[:-1], size=10, replace=False):
        t = pd.Timestamp(t)
        pert = strat.target_weights(_perturb_after(data, t, rng))
        pd.testing.assert_series_equal(_row(full, t), _row(pert, t), check_names=False)
