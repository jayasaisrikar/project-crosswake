"""Feature store: causality of every registered feature, record schema, cache + incremental."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.features import FeatureStore, compute_wide, get_feature, list_features, to_records

SYMS = ["BTC", "ETH", "SOL"]
N = 24 * 45


def _md(close: pd.DataFrame, rng: np.random.Generator) -> MarketData:
    qv = pd.DataFrame(rng.uniform(1e5, 1e6, close.shape), index=close.index, columns=close.columns)
    filled = pd.DataFrame(False, index=close.index, columns=close.columns)
    filled.iloc[300:305, 1] = True
    return MarketData(open=close, high=close * 1.001, low=close * 0.999, close=close,
                      volume=qv / close, quote_volume=qv.where(close.notna()), is_filled=filled)


def make_data(seed: int = 0) -> Dataset:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2023-01-01", periods=N, freq="h", tz="UTC", name="ts")
    perp = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (N, 3)), axis=0)),
                        index=idx, columns=SYMS)
    perp.iloc[:200, 2] = np.nan                       # SOL listed later
    spot = perp * (1 + rng.normal(0, 1e-3, perp.shape))
    fidx = pd.date_range(idx[0], idx[-1], freq="8h") + pd.Timedelta(milliseconds=1)
    funding = pd.DataFrame(rng.normal(1e-4, 5e-5, (len(fidx), 3)), index=fidx, columns=SYMS)
    return Dataset(spot=_md(spot, rng), perp=_md(perp, rng), funding=funding)


DATA = make_data()
FEATURES = list_features()


def test_registry_has_base_features() -> None:
    ids = {f.feature_id for f in FEATURES}
    assert len(ids) >= 15
    for need in ("rv_24h", "rv_7d", "ret_1h", "ret_4h", "ret_24h", "ret_7d", "vol_adj_mom_7d",
                 "volume_z_7d", "funding_z_90evt", "funding_change", "basis_perp_spot",
                 "btc_ret_lag1h", "ethbtc_rs_7d", "btc_beta_7d", "btc_corr_7d", "drawdown_30d"):
        assert need in ids


@pytest.mark.parametrize("fd", FEATURES, ids=lambda f: f.feature_id)
def test_feature_causality(fd) -> None:  # type: ignore[no-untyped-def]
    full = compute_wide(fd, DATA)
    idx = DATA.perp.close.index
    assert full.notna().to_numpy().any(), f"{fd.feature_id} produced no values"
    for i in (210, 400, 24 * 31 + 3, N - 1):
        t = idx[i]
        trunc = compute_wide(fd, DATA.truncate(t))
        pd.testing.assert_series_equal(trunc.loc[t], full.loc[t], check_names=False,
                                       obj=f"{fd.feature_id}@{t}")


@pytest.mark.parametrize("fd", FEATURES, ids=lambda f: f.feature_id)
def test_future_shock_does_not_leak(fd) -> None:  # type: ignore[no-untyped-def]
    """Perturbing data strictly after t must not change any value at <= t."""
    t = DATA.perp.close.index[500]
    full = compute_wide(fd, DATA)
    shocked_close = DATA.perp.close.copy()
    shocked_close.loc[shocked_close.index > t] *= 3.0
    p = DATA.perp
    after = p.close.index > t
    qv = p.quote_volume.copy()
    qv.loc[after] *= 7.0
    fund = DATA.funding.copy()
    fund.loc[fund.index > t] = 0.01
    shocked = Dataset(DATA.spot, MarketData(p.open, p.high, p.low, shocked_close, p.volume, qv,
                                            p.is_filled), fund)
    pd.testing.assert_frame_equal(compute_wide(fd, shocked).loc[:t], full.loc[:t])


def test_records_schema_and_availability() -> None:
    fd = get_feature("ret_24h")
    rec = to_records(fd, compute_wide(fd, DATA))
    assert list(rec.columns) == ["feature_id", "asset", "timestamp", "availability_timestamp", "value",
                                 "source", "calculation_version"]
    assert (rec["availability_timestamp"] - rec["timestamp"] == pd.Timedelta(hours=1)).all()
    assert rec["value"].notna().all()


def test_cache_and_incremental(tmp_path) -> None:  # type: ignore[no-untyped-def]
    store = FeatureStore(tmp_path)
    for fid in ("rv_7d", "funding_z_90evt", "btc_beta_7d", "drawdown_30d"):
        fd = get_feature(fid)
        cut = DATA.perp.close.index[N - 100]
        store.compute(fd, DATA.truncate(cut))
        assert store.path(fd).exists()
        inc = store.compute(fd, DATA)
        full = FeatureStore(tmp_path / "fresh").compute(fd, DATA)
        pd.testing.assert_frame_equal(inc.reset_index(drop=True), full.reset_index(drop=True))
        # unchanged inputs -> served from cache
        again = store.compute(fd, DATA)
        pd.testing.assert_frame_equal(again, inc.reset_index(drop=True))
