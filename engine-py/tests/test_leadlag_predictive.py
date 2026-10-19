"""Tests for the predictive lead-lag module (Granger §4.C, rolling lag §4.E, OOS R^2 §4.G)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.leadlag.predictive import (
    benjamini_hochberg,
    granger_incremental,
    oos_predictive_r2,
    rolling_lag,
    rolling_lag_stability,
)


def _series(n: int, seed: int, freq: str = "h") -> tuple[pd.Series, pd.DatetimeIndex]:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2021-01-01", periods=n, freq=freq, tz="UTC")
    return pd.Series(rng.normal(0, 0.01, n), index=idx, name="btc"), idx


def test_bh_monotone_and_empty() -> None:
    assert benjamini_hochberg({}) == {}
    # one tiny p-value among large ones should reject at least itself
    rej = benjamini_hochberg({"a": 0.001, "b": 0.9, "c": 0.8, "d": float("nan")}, alpha=0.10)
    assert rej["a"] is True and rej["b"] is False and rej["d"] is False
    # all large p-values -> none rejected
    assert not any(benjamini_hochberg({"x": 0.4, "y": 0.6}).values())


def test_granger_detects_planted_lead_and_null() -> None:
    r_btc, idx = _series(6000, seed=1)
    noise = np.random.default_rng(2).normal(0, 0.01, len(idx))
    r_alt = pd.Series(0.6 * r_btc.shift(1).fillna(0.0).to_numpy() + noise, index=idx, name="alt")
    hit = granger_incremental(r_alt, r_btc, p=3)
    assert hit["p_value"] < 0.01 and hit["btc_beta_sum"] > 0   # BTC leads the alt, same sign

    r_null = pd.Series(np.random.default_rng(3).normal(0, 0.01, len(idx)), index=idx, name="alt")
    miss = granger_incremental(r_null, r_btc, p=3)
    assert miss["p_value"] > 0.05                               # no spurious lead-lag


def test_rolling_lag_recovers_planted_lag() -> None:
    r_btc, idx = _series(4000, seed=4)
    r_alt = pd.Series(r_btc.shift(2).fillna(0.0).to_numpy(), index=idx, name="alt")
    rl = rolling_lag(r_alt, r_btc, window=500, max_lag=5, step=200)
    assert int(rl["best_lag"].mode().iloc[0]) == 2
    stab = rolling_lag_stability(r_alt.to_frame(), r_btc, window=500, max_lag=5, step=200)
    assert stab.loc[0, "modal_lag"] == 2 and stab.loc[0, "share_at_mode"] > 0.9


def test_oos_r2_positive_for_lead_negative_for_noise() -> None:
    # 18 months of hourly data so walk_forward (train 12m, test 3m) yields folds
    r_btc, idx = _series(24 * 30 * 18, seed=5)
    noise = np.random.default_rng(6).normal(0, 0.01, len(idx))
    lead = pd.Series(0.7 * r_btc.shift(1).fillna(0.0).to_numpy() + noise, index=idx, name="LEAD")
    null = pd.Series(np.random.default_rng(7).normal(0, 0.01, len(idx)), index=idx, name="NULL")
    alt = pd.concat([lead, null], axis=1)
    oos = oos_predictive_r2(alt, r_btc, p=2, train_months=12, test_months=3, embargo_bars=24)
    oos = oos.set_index("symbol")
    assert oos.loc["LEAD", "incremental"] > 0          # BTC lags add real OOS value for the lead
    assert oos.loc["NULL", "incremental"] <= 0.001     # none for pure noise
