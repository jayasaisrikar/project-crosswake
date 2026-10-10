"""Two-state Gaussian HMM on daily log returns, numpy EM (Baum-Welch with scaling).

Causality: parameters are re-estimated at each month start on days STRICTLY before that month
(expanding window). Output is the FILTERED probability P(s_d | r_1..r_d) from a forward pass only;
no backward pass / smoothing is ever used for labelling (the backward pass appears only inside EM on
the training window). States are ordered by variance: 0 = low-vol, 1 = high-vol.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

MIN_TRAIN_DAYS = 365


@dataclass(frozen=True)
class HMMParams:
    pi: np.ndarray
    A: np.ndarray
    mu: np.ndarray
    var: np.ndarray


def _emis(x: np.ndarray, p: HMMParams) -> np.ndarray:
    return np.exp(-0.5 * (x[:, None] - p.mu) ** 2 / p.var) / np.sqrt(2 * np.pi * p.var) + 1e-300


def forward_filter(x: np.ndarray, p: HMMParams) -> tuple[np.ndarray, np.ndarray]:
    """Filtered state probabilities alpha[t] = P(s_t | x_1..x_t) and scaling constants."""
    b = _emis(x, p)
    n, k = b.shape
    alpha = np.empty((n, k))
    c = np.empty(n)
    a = p.pi * b[0]
    for t in range(n):
        if t:
            a = (alpha[t - 1] @ p.A) * b[t]
        c[t] = a.sum()
        alpha[t] = a / c[t]
    return alpha, c


def fit_em(x: np.ndarray, init: HMMParams | None = None, iters: int = 50) -> HMMParams:
    v = float(np.var(x))
    p = init or HMMParams(np.array([0.5, 0.5]), np.array([[0.95, 0.05], [0.05, 0.95]]),
                          np.array([float(np.mean(x))] * 2), np.array([0.5 * v, 2.0 * v]))
    b_n = len(x)
    for _ in range(iters):
        b = _emis(x, p)
        alpha, c = forward_filter(x, p)
        beta = np.ones_like(alpha)
        for t in range(b_n - 2, -1, -1):
            beta[t] = (p.A @ (b[t + 1] * beta[t + 1])) / c[t + 1]
        gamma = alpha * beta
        gamma /= gamma.sum(axis=1, keepdims=True)
        xi = (alpha[:-1, :, None] * p.A[None] * (b[1:] * beta[1:])[:, None, :]) / c[1:, None, None]
        A = xi.sum(0)
        A /= A.sum(1, keepdims=True)
        w = gamma.sum(0)
        mu = (gamma * x[:, None]).sum(0) / w
        var = np.maximum((gamma * (x[:, None] - mu) ** 2).sum(0) / w, 1e-10)
        p = HMMParams(gamma[0], A, mu, var)
    order = np.argsort(p.var)
    return HMMParams(p.pi[order], p.A[np.ix_(order, order)], p.mu[order], p.var[order])


def daily_returns(close: pd.Series) -> pd.Series:
    """Daily log return from the close of each UTC day's last available hourly bar."""
    d = close.dropna().resample("1D").last()
    return np.log(d).diff().dropna()


def filtered_high_vol_prob(close: pd.Series) -> pd.Series:
    """Daily series P(high-vol state | data through day d) with monthly expanding refits."""
    r = daily_returns(close)
    if len(r) <= MIN_TRAIN_DAYS:
        return pd.Series(np.nan, index=r.index)
    x = r.to_numpy(float)
    first = r.index[0] + pd.Timedelta(days=MIN_TRAIN_DAYS)
    starts = pd.date_range(first.normalize() + pd.offsets.MonthBegin(0), r.index[-1], freq="MS")
    out = pd.Series(np.nan, index=r.index)
    params: HMMParams | None = None
    for i, m in enumerate(starts):
        train = x[r.index < m]
        params = fit_em(train, params, iters=50 if params is None else 15)
        end = starts[i + 1] if i + 1 < len(starts) else r.index[-1] + pd.Timedelta(days=1)
        upto = r.index < end
        alpha, _ = forward_filter(x[upto], params)
        seg = (r.index >= m) & upto
        out[seg] = alpha[seg[upto], 1]
    return out
