"""Out-of-sample confidence calibration.

Inputs are walk-forward OOS pairs (score, realized) where `score` is a raw model confidence /
probability-like score and `realized` is 1 if the predicted sign was correct else 0. Calibrators are
fit ONLY on OOS pairs from strictly earlier folds; if fewer than `min_samples` pairs exist the
calibrated confidence stays NaN (the contract's "uncalibrated" marker).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd

from engine.research.contract import Prediction

DEFAULT_MIN_SAMPLES = 200


def pav(y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
    """Pool-adjacent-violators: weighted non-decreasing least-squares fit of y (already x-sorted)."""
    yy = np.asarray(y, dtype=float)
    ww = np.ones_like(yy) if w is None else np.asarray(w, dtype=float)
    vals: list[float] = []
    wts: list[float] = []
    cnt: list[int] = []
    for yi, wi in zip(yy, ww, strict=True):
        vals.append(float(yi))
        wts.append(float(wi))
        cnt.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            wsum = wts[-2] + wts[-1]
            v = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / wsum
            c = cnt[-2] + cnt[-1]
            vals[-2:] = [v]
            wts[-2:] = [wsum]
            cnt[-2:] = [c]
    return np.repeat(np.array(vals), np.array(cnt, dtype=int))


def _clean(scores: np.ndarray, outcomes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    s = np.asarray(scores, dtype=float)
    o = np.asarray(outcomes, dtype=float)
    m = np.isfinite(s) & np.isfinite(o)
    return s[m], o[m]


@dataclass
class IsotonicCalibrator:
    min_samples: int = DEFAULT_MIN_SAMPLES
    x_: np.ndarray = field(default_factory=lambda: np.empty(0))
    y_: np.ndarray = field(default_factory=lambda: np.empty(0))
    fitted: bool = False

    def fit(self, scores: np.ndarray, outcomes: np.ndarray) -> IsotonicCalibrator:
        s, o = _clean(scores, outcomes)
        if len(s) < self.min_samples:
            self.fitted = False
            return self
        order = np.argsort(s, kind="mergesort")
        s, o = s[order], o[order]
        fit = pav(o)
        ux, idx = np.unique(s, return_index=True)  # ties share the pooled value
        self.x_, self.y_ = ux, np.clip(fit[idx], 0.0, 1.0)
        self.fitted = True
        return self

    def predict(self, scores: np.ndarray | float) -> np.ndarray:
        s = np.atleast_1d(np.asarray(scores, dtype=float))
        if not self.fitted:
            return np.full(s.shape, np.nan)
        out = np.interp(s, self.x_, self.y_)
        out[~np.isfinite(s)] = np.nan
        return out


@dataclass
class PlattCalibrator:
    """p = sigmoid(a*score + b), fit by Newton-Raphson on log-loss with Platt (1999) smoothed targets."""

    min_samples: int = DEFAULT_MIN_SAMPLES
    a: float = float("nan")
    b: float = float("nan")
    fitted: bool = False

    def fit(self, scores: np.ndarray, outcomes: np.ndarray, iters: int = 100) -> PlattCalibrator:
        s, o = _clean(scores, outcomes)
        if len(s) < self.min_samples:
            self.fitted = False
            return self
        n1 = float(o.sum())
        n0 = len(o) - n1
        t = np.where(o > 0.5, (n1 + 1) / (n1 + 2), 1 / (n0 + 2))
        x = np.column_stack([s, np.ones_like(s)])
        beta = np.zeros(2)
        for _ in range(iters):
            p = 1 / (1 + np.exp(-(x @ beta)))
            g = x.T @ (p - t)
            h = x.T @ (x * (p * (1 - p))[:, None]) + 1e-9 * np.eye(2)
            step = np.linalg.solve(h, g)
            beta -= step
            if np.max(np.abs(step)) < 1e-10:
                break
        self.a, self.b = float(beta[0]), float(beta[1])
        self.fitted = True
        return self

    def predict(self, scores: np.ndarray | float) -> np.ndarray:
        s = np.atleast_1d(np.asarray(scores, dtype=float))
        if not self.fitted:
            return np.full(s.shape, np.nan)
        return np.asarray(1 / (1 + np.exp(-(self.a * s + self.b))))


Calibrator = IsotonicCalibrator | PlattCalibrator


def brier_score(probs: np.ndarray, outcomes: np.ndarray) -> float:
    p, o = _clean(probs, outcomes)
    return float(np.mean((p - o) ** 2)) if len(p) else float("nan")


def reliability_table(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = 10) -> pd.DataFrame:
    """Equal-width bins on [0,1]: count, mean predicted, observed frequency, gap."""
    p, o = _clean(probs, outcomes)
    edges = np.linspace(0, 1, n_bins + 1)
    b = np.clip(np.digitize(p, edges[1:-1]), 0, n_bins - 1)
    rows = []
    for i in range(n_bins):
        m = b == i
        n = int(m.sum())
        mp = float(p[m].mean()) if n else float("nan")
        of = float(o[m].mean()) if n else float("nan")
        rows.append({"bin_lo": edges[i], "bin_hi": edges[i + 1], "count": n,
                     "mean_pred": mp, "obs_freq": of, "gap": of - mp if n else float("nan")})
    return pd.DataFrame(rows)


def expected_calibration_error(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = 10) -> float:
    t = reliability_table(probs, outcomes, n_bins)
    n = t["count"].sum()
    if n == 0:
        return float("nan")
    t = t[t["count"] > 0]
    return float((t["count"] * t["gap"].abs()).sum() / n)


def make_calibrator(method: str, min_samples: int = DEFAULT_MIN_SAMPLES) -> Calibrator:
    if method == "isotonic":
        return IsotonicCalibrator(min_samples)
    if method == "platt":
        return PlattCalibrator(min_samples)
    raise ValueError(f"unknown calibration method {method!r}")


def walk_forward_calibrate(scores: pd.Series, outcomes: pd.Series, method: str = "isotonic",
                           min_samples: int = DEFAULT_MIN_SAMPLES, refit_every: int = 1) -> pd.Series:
    """Causal calibration: value at i uses a calibrator fit on pairs [0, i) only.

    `outcomes[j]` must be realized before decision time i: callers with horizon h must only pass
    pairs whose outcome had matured (or lag them) -- this function assumes row order == availability.
    """
    s = scores.to_numpy(dtype=float)
    o = outcomes.to_numpy(dtype=float)
    out = np.full(len(s), np.nan)
    cal: Calibrator | None = None
    for i in range(len(s)):
        if cal is None or i % max(refit_every, 1) == 0:
            cal = make_calibrator(method, min_samples).fit(s[:i], o[:i])
        out[i] = cal.predict(s[i])[0]
    return pd.Series(out, index=scores.index)


def calibrate_prediction(pred: Prediction, calibrator: Calibrator, score: float | None = None) -> Prediction:
    """Replace pred.confidence with the calibrated value (NaN if the calibrator is not fitted)."""
    raw = pred.confidence if score is None else score
    c = float(calibrator.predict(raw)[0]) if math.isfinite(raw) else float("nan")
    return replace(pred, confidence=c)
