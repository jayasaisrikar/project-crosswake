"""Shared machinery for engine.models: data helpers and the ScoreModel base class.

A ScoreModel produces a causal hourly *score* panel (index = hourly bars, columns = assets). `fit(data, end)`
truncates the data at `end`, computes the score and the forward `horizon_hours` return on that truncated data
(so targets never look past `end`), and fits a pooled OLS calibration  fwd_ret = a + b * score.
`predict(data, t)` slices the data to [t - warmup, t], recomputes the score and returns
expected_return = b * score_t (minus its cross-sectional mean for cross-sectional models), i.e. a forecast
in return units of the return IN EXCESS of the training-window drift `a`. The intercept is NOT used for
direction (review 01 #1, 2026-10-10: with sign(a + b*s) every model was a long-only beta bet because the
training drift `a` dominated b*s). `features["calib_a"]` / `features["er_with_drift"]` keep the raw values.
`predict_many(data, times)` computes the panels once and reads rows (review 01 #6); it must equal
`predict(truncate(data, t), t)` at every t, which the runner's leakage check verifies.
confidence is NaN (calibration is done elsewhere); risk = trailing hourly vol * sqrt(horizon).

Cross-sectional models (`xs = True`) need >= MIN_XS_ASSETS assets (DataUnavailable otherwise) and rank
only over the point-in-time universe `pit_mask` when one is attached (review 01 #9).
"""

from __future__ import annotations

import math
from typing import Any, cast

import numpy as np
import pandas as pd

from engine.contracts import Dataset, MarketData
from engine.research.contract import Direction, Prediction
from engine.signals.trend import MAX_STALE_BARS

HOURS_PER_YEAR = 24 * 365
MIN_FIT_SAMPLES = 50
MIN_XS_ASSETS = 3


class DataUnavailable(RuntimeError):
    """The model needs a data source the Dataset does not carry (OI, liquidations, order book...)."""


class InsufficientData(ValueError):
    """Too few valid (score, target) pairs in the training window."""


class NotFitted(RuntimeError):
    pass


# ----------------------------------------------------------------------------------------------- data helpers


def stale_run_length_fast(is_filled: pd.DataFrame) -> pd.DataFrame:
    """Vectorised equivalent of engine.signals.trend.stale_run_length (review 01 #6): consecutive
    is_filled=True bars ending at each t, computed as cumsum - (cumsum frozen at the last False)."""
    f = is_filled.fillna(False).astype(bool).to_numpy()
    c = np.cumsum(f, axis=0)
    reset = np.where(~f, c, 0)
    run = c - np.maximum.accumulate(reset, axis=0)
    return pd.DataFrame(run, index=is_filled.index, columns=is_filled.columns)


def tradable_mask(md: MarketData) -> pd.DataFrame:
    """Valid close and not stale for more than MAX_STALE_BARS consecutive bars (same rule as
    engine.signals.trend.tradable_mask, vectorised)."""
    filled = md.is_filled.reindex_like(md.close)
    return md.close.notna() & (stale_run_length_fast(filled) <= MAX_STALE_BARS)


def slice_data(data: Dataset, start: pd.Timestamp | None, end: pd.Timestamp) -> Dataset:
    """Rows in [start, end] for every panel (start=None -> from the beginning). Causal (<= end only)."""

    def md(m: MarketData) -> MarketData:
        return MarketData(**{k: getattr(m, k).loc[start:end] for k in m.__dataclass_fields__})

    return Dataset(md(data.spot), md(data.perp), data.funding.loc[start:end])


def hourly_returns(md: MarketData) -> pd.DataFrame:
    """Simple hourly returns; synthesized (stale) bars -> NaN so they do not bias vol."""
    real = ~md.is_filled.reindex_like(md.close).fillna(True).astype(bool)
    return md.close.pct_change(fill_method=None).where(real)


def trailing_vol(rets: pd.DataFrame, hours: int) -> pd.DataFrame:
    """Trailing hourly stdev over `hours` bars (min half the window)."""
    return rets.rolling(hours, min_periods=max(hours // 2, 2)).std()


def npf(fn: Any, df: pd.DataFrame) -> pd.DataFrame:
    """Apply a numpy ufunc to a DataFrame, keeping the DataFrame type for mypy."""
    return cast(pd.DataFrame, fn(df))


def log_mom(close: pd.DataFrame, hours: int, skip: int = 0) -> pd.DataFrame:
    return npf(np.log, close.shift(skip) / close.shift(hours + skip))


def funding_hourly(data: Dataset, index: pd.Index, columns: pd.Index) -> pd.DataFrame:
    """Funding events binned to the hourly bar at or after the event (ceil), summed. NaN = no event.

    An event at 08:00:00.005 lands in the 09:00 bar, so a bar never sees an event stamped after it."""
    f = data.funding.reindex(columns=columns)
    if f.empty:
        return pd.DataFrame(np.nan, index=index, columns=columns)
    f = f.copy()
    f.index = pd.DatetimeIndex(f.index).ceil("h")
    g = f.groupby(level=0).sum(min_count=1)
    return g.reindex(index)


def funding_apr(data: Dataset, close: pd.DataFrame, hours: int) -> pd.DataFrame:
    """Trailing funding over (t - hours, t], annualised. NaN where the perp is not listed."""
    fh = funding_hourly(data, close.index, close.columns)
    apr = fh.fillna(0.0).rolling(hours, min_periods=hours).sum() * (HOURS_PER_YEAR / hours)
    return apr.where(close.notna())


def zscore(x: pd.DataFrame, hours: int) -> pd.DataFrame:
    mu = x.rolling(hours, min_periods=hours // 2).mean()
    sd = x.rolling(hours, min_periods=hours // 2).std()
    return (x - mu) / sd.where(sd > 0)


def xs_demean_rank(x: pd.DataFrame, min_assets: int = 3) -> pd.DataFrame:
    """Cross-sectional percentile rank, demeaned to [-0.5, 0.5]; rows with < min_assets valid -> NaN."""
    r = x.rank(axis=1, pct=True)
    n = x.notna().sum(axis=1)
    r = r.sub(r.mean(axis=1), axis=0)
    return r.where(n >= min_assets, np.nan)


def forward_return(close: pd.DataFrame, h: int) -> pd.DataFrame:
    """close[t+h]/close[t]-1. On data truncated at `end` this is NaN whenever t+h > end."""
    return close.shift(-h) / close - 1.0


def ols(x: np.ndarray, y: np.ndarray, ridge: float = 0.0) -> np.ndarray:
    """Least squares with intercept in column 0 of x (not penalised)."""
    p = x.shape[1]
    pen = np.eye(p) * ridge
    pen[0, 0] = 0.0
    return np.linalg.solve(x.T @ x + pen + 1e-12 * np.eye(p), x.T @ y)


# --------------------------------------------------------------------------------------------- the base model


class ScoreModel:
    """Base: subclasses implement `score_panel` (and optionally `_fit_inner`, `target_panel`)."""

    model_id: str = "score_model"
    family: str = ""
    xs: bool = False                      # cross-sectional: ranks across assets at t
    default_params: dict[str, Any] = {}
    params: dict[str, Any]
    pit_mask: pd.DataFrame | None = None  # causal PIT universe membership (xs ranks use members only)

    def __init__(self, **params: Any):
        p: dict[str, Any] = {"horizon_hours": 24, "market": "perp", "vol_hours": 30 * 24,
                             "min_abs_return": 0.0, "fit_stride": 0, "winsor": 0.005}
        p.update(self.default_params)
        p.update(params)
        self.params = p
        self.horizon_hours = int(p["horizon_hours"])
        self.market = str(p["market"])
        if "cross_sectional" in p:          # opt-in xs demeaning for pooled models (e.g. ridge on a universe)
            self.xs = bool(p["cross_sectional"])
        self.coef_: tuple[float, float] | None = None
        self.resid_std_: float = math.nan
        self.n_fit_: int = 0
        self.fit_end_: pd.Timestamp | None = None

    # ---- to override
    @property
    def warmup_hours(self) -> int:
        return 2 * int(self.params["vol_hours"])

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        raise NotImplementedError

    def target_panel(self, data: Dataset) -> pd.DataFrame:
        return forward_return(data.market(self.market).close, self.horizon_hours)  # type: ignore[arg-type]

    def _fit_inner(self, train: Dataset) -> None:
        """Hook for models with their own estimated parameters (HAR, ridge, logit...)."""

    # ---- shared
    def _md(self, data: Dataset) -> MarketData:
        return data.market(self.market)  # type: ignore[arg-type]

    def _stride(self) -> int:
        s = int(self.params["fit_stride"])
        return s if s > 0 else max(1, min(self.horizon_hours, 24))

    def _xs_rank(self, x: pd.DataFrame) -> pd.DataFrame:
        """Cross-sectional demeaned rank over the PIT universe at t only (non-members -> NaN first)."""
        if self.pit_mask is not None:
            m = self.pit_mask.reindex(index=x.index, columns=x.columns).fillna(False).astype(bool)
            x = x.where(m)
        return xs_demean_rank(x, MIN_XS_ASSETS)

    def _check_assets(self, data: Dataset) -> None:
        n = self._md(data).close.shape[1]
        if self.xs and n < MIN_XS_ASSETS:
            raise DataUnavailable(f"{self.model_id}: cross-sectional model needs >= {MIN_XS_ASSETS} assets, "
                                  f"got {n}")

    def fit(self, data: object, end: pd.Timestamp) -> None:
        assert isinstance(data, Dataset)
        self._check_assets(data)
        train = data.truncate(end)
        self._fit_inner(train)
        score = self.score_panel(train)
        target = self.target_panel(train).reindex_like(score)
        ok = tradable_mask(self._md(train)).reindex_like(score).fillna(False).astype(bool)
        s = score.where(ok).to_numpy(dtype=float)[:: self._stride()].ravel()
        y = target.to_numpy(dtype=float)[:: self._stride()].ravel()
        m = np.isfinite(s) & np.isfinite(y)
        s, y = s[m], y[m]
        if len(y) < MIN_FIT_SAMPLES:
            raise InsufficientData(f"{self.model_id}: {len(y)} training pairs < {MIN_FIT_SAMPLES}")
        w = float(self.params["winsor"])
        if w > 0:
            lo, hi = np.quantile(y, [w, 1 - w])
            y = np.clip(y, lo, hi)
        x = np.column_stack([np.ones_like(s), s])
        beta = ols(x, y) if np.std(s) > 0 else np.array([float(np.mean(y)), 0.0])
        self.coef_ = (float(beta[0]), float(beta[1]))
        self.resid_std_ = float(np.std(y - x @ beta, ddof=min(2, len(y) - 1)))
        self.n_fit_ = int(len(y))
        self.fit_end_ = pd.Timestamp(end)

    def _rows(self, score: pd.DataFrame, md: MarketData, times: list[pd.Timestamp]) -> list[Prediction]:
        if self.coef_ is None:
            raise NotFitted(f"{self.model_id}: call fit() first")
        ok = tradable_mask(md).reindex_like(score).fillna(False).astype(bool)
        if self.pit_mask is not None:
            pm = self.pit_mask.reindex(index=score.index, columns=score.columns).fillna(False).astype(bool)
            ok &= pm
        vol = trailing_vol(hourly_returns(md), int(self.params["vol_hours"])).reindex_like(score)
        a, b = self.coef_
        h = self.horizon_hours
        cols = [str(c) for c in score.columns]
        sv, okv, vv = score.to_numpy(dtype=float), ok.to_numpy(dtype=bool), vol.to_numpy(dtype=float)
        pos = score.index.get_indexer(pd.DatetimeIndex(times))
        out: list[Prediction] = []
        for t, i in zip(times, pos, strict=True):
            if i < 0:
                continue
            valid = np.isfinite(sv[i]) & okv[i]
            if not valid.any():
                continue
            sig = b * sv[i]
            if self.xs:
                sig = sig - float(np.mean(sig[valid]))
            for j in np.flatnonzero(valid):
                s, er = float(sv[i, j]), float(sig[j])
                v = float(vv[i, j])
                risk = v * math.sqrt(h) if np.isfinite(v) else math.nan
                direction: Direction = 1 if er > 0 else -1 if er < 0 else 0
                reason = ""
                if abs(er) <= float(self.params["min_abs_return"]):
                    direction, reason = 0, "NO TRADE: |expected_return| <= min_abs_return"
                out.append(Prediction(
                    timestamp=pd.Timestamp(t), asset=cols[j], model_id=self.model_id, horizon_hours=h,
                    expected_return=er, direction=direction, confidence=math.nan,
                    uncertainty=self.resid_std_, risk=risk, model_sources=(self.model_id,),
                    features={"score": s, "calib_a": a, "calib_b": b, "er_with_drift": a + b * s},
                    reason=reason,
                ))
        return out

    def predict(self, data: object, t: pd.Timestamp) -> list[Prediction]:
        assert isinstance(data, Dataset)
        if self.coef_ is None:
            raise NotFitted(f"{self.model_id}: call fit() first")
        t = pd.Timestamp(t)
        win = slice_data(data, t - pd.Timedelta(hours=self.warmup_hours), t)
        md = self._md(win)
        if t not in md.close.index:
            return []
        score = self.score_panel(win)
        if t not in score.index:
            return []
        return self._rows(score, md, [t])

    def predict_many(self, data: object, times: list[pd.Timestamp]) -> list[Prediction]:
        """Predictions at every t in `times` from ONE score computation on data <= max(times).

        Equivalent to [predict(truncate(data, t), t) for t in times] for causal (trailing) scores."""
        assert isinstance(data, Dataset)
        if self.coef_ is None:
            raise NotFitted(f"{self.model_id}: call fit() first")
        if not times:
            return []
        times = [pd.Timestamp(t) for t in times]
        win = slice_data(data, min(times) - pd.Timedelta(hours=self.warmup_hours), max(times))
        md = self._md(win)
        score = self.score_panel(win)
        return self._rows(score, md, times)
