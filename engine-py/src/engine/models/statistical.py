"""Level 2 statistical models (numpy only; no sklearn/lightgbm needed for linear / logistic / AR fits).

Features (all trailing, causal), per asset and hour:
  ret_{k}h  = log(P_t / P_{t-k}) / (sigma_h * sqrt(k))   for k in lags_hours
  fund_z    = z-score of 72h funding APR over 30d          (optional, NaN-filled with 0)
  basis_z   = z-score of spot/perp - 1 over 168h            (optional, NaN-filled with 0)
Coefficients are estimated on the training window only (data <= end, targets with t + h <= end), pooled
across assets, features standardised with train mean/std. The model's linear output is the score; the base
class then maps score -> forward return (an identity-like recalibration for OLS/ridge, a real mapping for
the logistic probability).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from engine.contracts import Dataset
from engine.models.base import (
    InsufficientData,
    ScoreModel,
    funding_apr,
    hourly_returns,
    log_mom,
    ols,
    trailing_vol,
    zscore,
)


class LinearFeatureModel(ScoreModel):
    model_id = "ridge"
    family = "STAT_RIDGE"
    default_params = {"lags_hours": [1, 4, 24, 72, 168], "use_funding": True, "use_basis": True,
                      "ridge": 10.0}

    def __init__(self, **params: object):
        super().__init__(**params)
        self.w_: np.ndarray | None = None
        self.mu_: np.ndarray | None = None
        self.sd_: np.ndarray | None = None

    @property
    def warmup_hours(self) -> int:
        return max(max(self.params["lags_hours"]), 30 * 24 + 72) + 2 * int(self.params["vol_hours"])

    def features(self, data: Dataset) -> list[pd.DataFrame]:
        md = self._md(data)
        c = md.close
        vol = trailing_vol(hourly_returns(md), int(self.params["vol_hours"]))
        out = [log_mom(c, k) / (vol * math.sqrt(k)) for k in self.params["lags_hours"]]
        if self.params["use_funding"]:
            out.append(zscore(funding_apr(data, data.perp.close, 72), 30 * 24).reindex_like(c).fillna(0.0))
        if self.params["use_basis"]:
            b = data.spot.close.reindex_like(data.perp.close) / data.perp.close - 1.0
            out.append(zscore(b, 168).reindex_like(c).fillna(0.0))
        return out

    def _design(self, data: Dataset) -> tuple[np.ndarray, pd.DataFrame]:
        feats = self.features(data)
        x = np.stack([f.to_numpy(dtype=float) for f in feats], axis=-1)  # (T, N, K)
        return x, feats[0]

    def _response(self, y: np.ndarray) -> np.ndarray:
        return y

    def _solve(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        return ols(x, y, ridge=float(self.params["ridge"]))

    def _fit_inner(self, train: Dataset) -> None:
        x, _ = self._design(train)
        y = self.target_panel(train).to_numpy(dtype=float)
        st = self._stride()
        x2 = x[::st].reshape(-1, x.shape[-1])
        y2 = y[::st].ravel()
        m = np.isfinite(x2).all(axis=1) & np.isfinite(y2)
        x2, y2 = x2[m], y2[m]
        if len(y2) < 50:
            raise InsufficientData(f"{self.model_id}: {len(y2)} training rows")
        lo, hi = np.quantile(y2, [0.005, 0.995])
        y2 = np.clip(y2, lo, hi)
        self.mu_ = x2.mean(axis=0)
        sd = x2.std(axis=0)
        self.sd_ = np.where(sd > 0, sd, 1.0)
        z = (x2 - self.mu_) / self.sd_
        self.w_ = self._solve(np.column_stack([np.ones(len(z)), z]), self._response(y2))

    def _linear(self, data: Dataset) -> tuple[np.ndarray, pd.DataFrame]:
        if self.w_ is None or self.mu_ is None or self.sd_ is None:
            raise RuntimeError(f"{self.model_id}: not fitted")
        x, like = self._design(data)
        z = (x - self.mu_) / self.sd_
        # signal term only: the fitted intercept w0 is the training drift and must not set direction
        # (review 01 #1); the base-class calibration a + b*score re-absorbs any level.
        return z @ self.w_[1:], like

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        lin, like = self._linear(data)
        return pd.DataFrame(lin, index=like.index, columns=like.columns)


class OLSModel(LinearFeatureModel):
    model_id = "ols"
    family = "STAT_OLS"
    default_params = {**LinearFeatureModel.default_params, "ridge": 0.0}


class LogisticSign(LinearFeatureModel):
    """P(fwd return > 0) = sigmoid(w . z); fit by IRLS with L2 penalty. score = P - 0.5."""

    model_id = "logit_sign"
    family = "STAT_LOGISTIC"
    default_params = {**LinearFeatureModel.default_params, "ridge": 1.0, "max_iter": 50}

    def _response(self, y: np.ndarray) -> np.ndarray:
        return (y > 0).astype(float)

    def _solve(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        lam = float(self.params["ridge"])
        w = np.zeros(x.shape[1])
        pen = np.eye(x.shape[1]) * lam
        pen[0, 0] = 0.0
        for _ in range(int(self.params["max_iter"])):
            p = 1.0 / (1.0 + np.exp(-np.clip(x @ w, -30, 30)))
            g = x.T @ (p - y) + pen @ w
            h = (x * (p * (1 - p))[:, None]).T @ x + pen + 1e-9 * np.eye(x.shape[1])
            step = np.linalg.solve(h, g)
            w = w - step
            if np.max(np.abs(step)) < 1e-8:
                break
        return w

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        lin, like = self._linear(data)
        assert self.w_ is not None
        w0 = float(self.w_[0])
        p = 1.0 / (1.0 + np.exp(-np.clip(w0 + lin, -30, 30)))
        p0 = 1.0 / (1.0 + math.exp(-max(min(w0, 30.0), -30.0)))
        # probability in excess of the training base rate (drift-free, review 01 #1)
        return pd.DataFrame(p - p0, index=like.index, columns=like.columns)


class ARModel(LinearFeatureModel):
    """Pooled AR(p) on non-overlapping horizon returns: r_{t,t+h} ~ sum_j phi_j r_{t-jh, t-(j-1)h}."""

    model_id = "ar"
    family = "STAT_AR"
    default_params = {"order": 3, "ridge": 0.0, "use_funding": False, "use_basis": False, "lags_hours": [1]}

    @property
    def warmup_hours(self) -> int:
        return (int(self.params["order"]) + 1) * self.horizon_hours + 48

    def features(self, data: Dataset) -> list[pd.DataFrame]:
        c = self._md(data).close
        h = self.horizon_hours
        return [log_mom(c, h, skip=j * h) for j in range(int(self.params["order"]))]
