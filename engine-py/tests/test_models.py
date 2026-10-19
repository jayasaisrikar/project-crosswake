"""engine.models: causality, fit-window isolation, output schema, registry, stubs."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.models import REGISTRY, DataUnavailable, NotFitted, build_model, param_grid
from engine.models.base import ScoreModel
from engine.research.contract import Prediction

SYMS = ["BTC", "ETH", "SOL", "XRP"]
N = 1600

FAST: dict[str, dict[str, Any]] = {
    "baseline_trend": {"lookbacks_days": [3, 7, 14], "vol_lookback_days": 5, "warmup_days": 30},
    "baseline_breakout": {"lookbacks_days": [3, 7], "vol_lookback_days": 5, "warmup_days": 30},
    "baseline_xsmom": {"formation_days": 5, "vol_lookback_days": 5, "rebalance_hours": 24, "warmup_days": 20},
    "baseline_carry": {"funding_lookback_hours": 24, "entry_funding_annual": 0.05, "warmup_days": 20},
    "tsmom": {"lookbacks_days": [2, 5], "vol_hours": 72},
    "trend_accel": {"window_days": 2, "vol_hours": 72},
    "donchian": {"lookbacks_days": [3, 7], "vol_hours": 72},
    "xs_mom": {"formation_days": 5, "vol_hours": 72},
    "residual_mom": {"formation_days": 5, "beta_days": 10, "vol_hours": 72},
    "st_reversal": {"vol_hours": 72},
    "zscore_reversal": {"vol_hours": 72},
    "voladj_reversal": {"vol_hours": 168},
    "funding_reversion": {"apr_hours": 24, "z_days": 5, "threshold": 0.5, "vol_hours": 72},
    "funding_accel": {"short_hours": 8, "long_hours": 48, "z_days": 5, "vol_hours": 72},
    "basis_reversion": {"z_hours": 72, "vol_hours": 72},
    "vol_regime": {"vol_hours": 72},
    "vol_managed_tsmom": {"lookbacks_days": [2, 5], "vol_hours": 72},
    "ridge": {"lags_hours": [1, 4, 24], "vol_hours": 72},
    "ols": {"lags_hours": [1, 4, 24], "vol_hours": 72},
    "logit_sign": {"lags_hours": [1, 4, 24], "vol_hours": 72},
    "ar": {"order": 2, "horizon_hours": 12, "vol_hours": 72},
}
STUBS = [m for m, s in REGISTRY.items() if s.level == "stub"]
LIVE = [m for m in REGISTRY if m not in STUBS]
END = pd.Timestamp("2022-02-20", tz="UTC")           # fit end (bar ~1200)
T_PRED = [pd.Timestamp("2022-02-25 13:00", tz="UTC"), pd.Timestamp("2022-03-02 00:00", tz="UTC")]


def _market(close: pd.DataFrame, rng: np.random.Generator) -> MarketData:
    v = pd.DataFrame(rng.uniform(10, 100, close.shape), index=close.index, columns=close.columns)
    v = v.where(close.notna())
    filled = pd.DataFrame(False, index=close.index, columns=close.columns)
    filled.iloc[500:520, 2] = True
    return MarketData(open=close, high=close * 1.002, low=close * 0.998, close=close, volume=v,
                      quote_volume=v * close, is_filled=filled)


def make_dataset(seed: int = 1) -> Dataset:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2022-01-01", periods=N, freq="h", tz="UTC")
    mkt = rng.normal(0.0001, 0.008, N)
    rets = mkt[:, None] * np.array([1.0, 1.2, 1.5, 0.8]) + rng.normal(0, 0.006, (N, len(SYMS)))
    close = pd.DataFrame(100 * np.exp(np.cumsum(rets, axis=0)), index=idx, columns=SYMS)
    close.iloc[:200, 3] = np.nan                       # XRP listed late
    spot = close * (1 + rng.normal(0, 5e-4, close.shape))
    fidx = idx[idx.hour % 8 == 0] + pd.Timedelta(milliseconds=3)   # funding ms jitter
    fund = pd.DataFrame(0.0001 + rng.normal(0, 0.0002, (len(fidx), len(SYMS))), index=fidx, columns=SYMS)
    return Dataset(spot=_market(spot, rng), perp=_market(close, rng), funding=fund)


DATA = make_dataset()


def _model(mid: str) -> Any:
    return build_model(mid, **FAST.get(mid, {}))


def _fitted(mid: str) -> Any:
    m = _model(mid)
    m.fit(DATA, END)
    return m


def test_registry_complete() -> None:
    assert set(FAST) == set(LIVE)
    for mid, spec in REGISTRY.items():
        assert spec.model_id == mid
        grid = param_grid(mid)
        assert grid and all(isinstance(g, dict) for g in grid)
        build_model(mid, **grid[-1])


@pytest.mark.parametrize("mid", LIVE)
def test_predict_schema_and_causality(mid: str) -> None:
    m = _fitted(mid)
    assert m.coef_ is not None and math.isfinite(m.coef_[1])
    any_pred = False
    for t in T_PRED:
        full = m.predict(DATA, t)
        trunc = m.predict(DATA.truncate(t), t)
        assert [p.to_record() for p in full] == [p.to_record() for p in trunc]
        for p in full:
            any_pred = True
            assert isinstance(p, Prediction)
            assert p.timestamp == t and p.model_id == mid and p.asset in SYMS
            assert p.horizon_hours == m.horizon_hours > 0
            assert math.isfinite(p.expected_return)
            assert p.direction in (-1, 0, 1)
            assert p.direction == 0 or np.sign(p.expected_return) == p.direction
            assert math.isnan(p.confidence)
            assert p.risk > 0 and p.uncertainty > 0
            assert p.expiry == t + pd.Timedelta(hours=p.horizon_hours)
    assert any_pred, f"{mid} produced no predictions"


@pytest.mark.parametrize("mid", LIVE)
def test_score_panel_causal(mid: str) -> None:
    """Stronger than predict(): the full score panel row at t equals the panel computed on data <= t."""
    m = _fitted(mid)
    assert isinstance(m, ScoreModel)
    full = m.score_panel(DATA)
    for t in T_PRED:
        part = m.score_panel(DATA.truncate(t))
        pd.testing.assert_series_equal(full.loc[t], part.loc[t], check_names=False)


@pytest.mark.parametrize("mid", LIVE)
def test_fit_uses_only_data_up_to_end(mid: str) -> None:
    """Perturb every price/funding strictly after END: fitted parameters must not change."""
    rng = np.random.default_rng(7)
    a = _fitted(mid)

    def scramble(md: MarketData) -> MarketData:
        kw = {}
        for k in md.__dataclass_fields__:
            df = getattr(md, k).copy()
            if k != "is_filled":
                post = df.index > END
                df.loc[post] = df.loc[post] * rng.uniform(0.5, 1.5, df.loc[post].shape)
            kw[k] = df
        return MarketData(**kw)

    f = DATA.funding.copy()
    f.loc[f.index > END] = rng.normal(0, 0.01, f.loc[f.index > END].shape)
    b = _model(mid)
    b.fit(Dataset(scramble(DATA.spot), scramble(DATA.perp), f), END)
    assert a.coef_ == b.coef_ and a.n_fit_ == b.n_fit_
    for attr in ("w_", "har_"):
        if getattr(a, attr, None) is not None:
            np.testing.assert_array_equal(getattr(a, attr), getattr(b, attr))


def test_predict_requires_fit() -> None:
    with pytest.raises(NotFitted):
        _model("tsmom").predict(DATA, T_PRED[0])


@pytest.mark.parametrize("mid", STUBS)
def test_stubs_raise(mid: str) -> None:
    m = build_model(mid)
    with pytest.raises(DataUnavailable):
        m.fit(DATA, END)
    with pytest.raises(DataUnavailable):
        m.predict(DATA, T_PRED[0])


def test_residual_mom_needs_btc() -> None:
    d = DATA
    sub = Dataset(*(MarketData(**{k: getattr(md, k).drop(columns="BTC") for k in md.__dataclass_fields__})
                    for md in (d.spot, d.perp)), funding=d.funding.drop(columns="BTC"))
    with pytest.raises(DataUnavailable):
        _model("residual_mom").fit(sub, END)


def test_calibration_recovers_planted_signal() -> None:
    """Plant fwd_ret = 0.01 * sign(24h momentum): calibrated slope must be positive and in return units."""
    d = make_dataset(3)
    c = d.perp.close.copy()
    lr = np.log(c).diff().fillna(0.0).to_numpy(copy=True)
    for i in range(48, N - 24, 24):
        mom = lr[i - 23: i + 1].sum(axis=0)
        lr[i + 1: i + 25] += np.sign(mom) * 0.01 / 24
    c2 = pd.DataFrame(100 * np.exp(np.cumsum(lr, axis=0)), index=c.index, columns=c.columns).where(c.notna())
    md = MarketData(**{**{k: getattr(d.perp, k) for k in d.perp.__dataclass_fields__},
                       "open": c2, "high": c2, "low": c2, "close": c2})
    m = build_model("tsmom", lookbacks_days=[1], vol_hours=72)
    m.fit(Dataset(d.spot, md, d.funding), END)
    a, b = m.coef_
    assert b > 0 and abs(a) < 0.05
