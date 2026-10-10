"""Regime engine: causality (truncation invariance), filtered-only HMM, transition stats."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.regimes import hmm as H
from engine.regimes import label, labels, transition_stats
from engine.regimes.changepoint import cusum


def make_ds(days: int = 520, seed: int = 3) -> Dataset:
    rng = np.random.default_rng(seed)
    n = days * 24
    idx = pd.date_range("2021-01-01", periods=n, freq="h", tz="UTC", name="ts")
    vol = np.where((np.arange(n) // (24 * 60)) % 2 == 0, 0.004, 0.012)
    btc = rng.normal(0, vol)
    cols = {"BTC": btc}
    for i, s in enumerate(["ETH", "SOL", "XRP"]):
        cols[s] = 0.8 * btc + rng.normal(0, 0.006 + 0.001 * i, n)
    close = pd.DataFrame({k: 100 * np.exp(np.cumsum(v)) for k, v in cols.items()}, index=idx)
    filled = pd.DataFrame(False, index=idx, columns=close.columns)
    md = MarketData(close, close, close, close, close * 0 + 1, close * 0 + 1e6, filled)
    fidx = idx[::8]
    funding = pd.DataFrame({"BTC": rng.normal(1e-4, 1e-4, len(fidx))}, index=fidx)
    return Dataset(md, md, funding)


@pytest.fixture(scope="module")
def ds() -> Dataset:
    return make_ds()


@pytest.fixture(scope="module")
def full(ds: Dataset) -> pd.DataFrame:
    return labels(ds)


@pytest.mark.parametrize("cut", ["2021-11-20 13:00", "2022-05-02 05:00"])
def test_labels_unchanged_by_truncation(ds: Dataset, full: pd.DataFrame, cut: str) -> None:
    t = pd.Timestamp(cut, tz="UTC")
    trunc = labels(ds.truncate(t))
    pd.testing.assert_frame_equal(trunc, full.loc[:t], check_dtype=False)
    one = label(ds, t)
    assert one["trend"] == full.loc[t, "trend"]
    assert one["hmm_p_high"] == pytest.approx(full.loc[t, "hmm_p_high"], nan_ok=True)


def test_future_shock_does_not_change_past(ds: Dataset, full: pd.DataFrame) -> None:
    t = pd.Timestamp("2022-03-01", tz="UTC")
    c = ds.perp.close.copy()
    c.loc[c.index > t] *= 3.0  # huge future jump
    md = MarketData(c, c, c, c, ds.perp.volume, ds.perp.quote_volume, ds.perp.is_filled)
    shocked = labels(Dataset(md, md, ds.funding))
    pd.testing.assert_frame_equal(shocked.loc[:t], full.loc[:t], check_dtype=False)


def test_hmm_is_filtered_not_smoothed() -> None:
    """Filtered alpha[t] must not depend on x[t+1:]; a smoothed posterior would."""
    rng = np.random.default_rng(0)
    x = np.r_[rng.normal(0, 0.01, 300), rng.normal(0, 0.05, 300)]
    p = H.fit_em(x[:400])
    a_full, _ = H.forward_filter(x, p)
    a_cut, _ = H.forward_filter(x[:350], p)
    np.testing.assert_allclose(a_full[:350], a_cut)
    assert p.var[0] < p.var[1]
    assert a_full[-1, 1] > 0.9 and a_full[100, 1] < 0.1


def test_hmm_module_exposes_no_smoother() -> None:
    assert not any("smooth" in n for n in dir(H))


def test_hmm_probs_detect_vol_regimes(full: pd.DataFrame) -> None:
    p = full["hmm_p_high"].dropna()
    assert len(p) > 0 and p.between(0, 1).all()


def test_cusum_flags_vol_increase() -> None:
    rng = np.random.default_rng(1)
    r = pd.Series(np.r_[rng.normal(0, 0.01, 200), rng.normal(0, 0.04, 50)],
                  index=pd.date_range("2022-01-01", periods=250, freq="D"))
    out = cusum(r)
    assert (out["cp_flag"].iloc[200:215] == 1).any()


def test_transition_stats_rows_sum_to_one(full: pd.DataFrame) -> None:
    ts = transition_stats(full["vol"])
    states = [c for c in ts.columns if c not in ("share", "mean_spell_bars")]
    np.testing.assert_allclose(ts[states].sum(axis=1), 1.0)
    assert ts["share"].sum() == pytest.approx(1.0)
