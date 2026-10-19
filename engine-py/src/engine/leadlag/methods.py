"""Lead-lag statistical methods (Phase 5). Every function takes a leader series ``x`` and a follower
series ``y`` (aligned hourly log returns, NaN-free) and a lag ``L`` (bars). "x leads y by L" means
``y_t`` is related to ``x_{t-L}``. All functions return plain dicts with at least ``stat`` and ``p``.

Hourly bars are the finest resolution in data/cleaned: sub-hour lags cannot be tested here.
"""

from __future__ import annotations

import math
import warnings
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats
from statsmodels.tsa.api import VAR
from statsmodels.tsa.stattools import grangercausalitytests

HAC_LAGS = 24


def _pair(x: pd.Series, y: pd.Series, lag: int) -> tuple[np.ndarray, np.ndarray]:
    """(x_{t-L}, y_t) for every t where both exist."""
    df = pd.concat([x.shift(lag), y], axis=1).dropna()
    return df.iloc[:, 0].to_numpy(float), df.iloc[:, 1].to_numpy(float)


def lagged_xcorr(x: pd.Series, y: pd.Series, lag: int) -> dict[str, float]:
    xl, yt = _pair(x, y, lag)
    n = len(xl)
    if n < 30:
        return {"stat": math.nan, "p": math.nan, "n": n}
    r = float(np.corrcoef(xl, yt)[0, 1])
    z = math.atanh(max(min(r, 0.999999), -0.999999)) * math.sqrt(n - 3)
    return {"stat": r, "p": float(2 * stats.norm.sf(abs(z))), "n": n}


def lagged_ols_hac(x: pd.Series, y: pd.Series, lag: int, hac_lags: int = HAC_LAGS) -> dict[str, float]:
    """y_t = a + b x_{t-L}; Newey-West t-stat on b."""
    xl, yt = _pair(x, y, lag)
    if len(xl) < 30:
        return {"stat": math.nan, "p": math.nan, "beta": math.nan, "n": len(xl)}
    res = sm.OLS(yt, sm.add_constant(xl)).fit(cov_type="HAC", cov_kwds={"maxlags": hac_lags})
    return {"stat": float(res.tvalues[1]), "p": float(res.pvalues[1]), "beta": float(res.params[1]),
            "n": len(xl)}


def granger(x: pd.Series, y: pd.Series, lag: int) -> dict[str, float]:
    """statsmodels Granger F-test: do lags 1..L of x add to lags 1..L of y?"""
    df = pd.concat([y, x], axis=1).dropna()
    if len(df) < 10 * lag + 30:
        return {"stat": math.nan, "p": math.nan}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out: Any = grangercausalitytests(df.to_numpy(float), maxlag=[lag])
    f, p = out[lag][0]["ssr_ftest"][:2]
    return {"stat": float(f), "p": float(p)}


def var_irf(x: pd.Series, y: pd.Series, lags: list[int],
            order: int | None = None) -> dict[int, dict[str, float]]:
    """Fit one bivariate VAR(order) and return the (non-orthogonalised) response of y at horizon L to a
    unit shock in x, with asymptotic standard errors -> z / p per L."""
    df = pd.concat([x.rename("x"), y.rename("y")], axis=1).dropna()
    order = order or max(lags)
    out: dict[int, dict[str, float]] = {}
    if len(df) < 20 * order:
        return {L: {"stat": math.nan, "p": math.nan} for L in lags}
    res = VAR(df.to_numpy(float)).fit(order)
    irf = res.irf(max(lags))
    se = irf.stderr(orth=False)
    for L in lags:
        resp, s = float(irf.irfs[L, 1, 0]), float(se[L, 1, 0])
        z = resp / s if s > 0 else math.nan
        out[L] = {"stat": resp, "p": float(2 * stats.norm.sf(abs(z))) if math.isfinite(z) else math.nan}
    return out


def rolling_stability(x: pd.Series, y: pd.Series, lag: int, window: int = 24 * 90) -> dict[str, float]:
    """Non-overlapping windows; fraction whose lagged corr has the same sign as the pooled corr.
    p = two-sided binomial test of sign consistency vs 0.5."""
    xl, yt = _pair(x, y, lag)
    k = len(xl) // window
    if k < 4:
        return {"stat": math.nan, "p": math.nan, "windows": k}
    pooled = np.sign(np.corrcoef(xl, yt)[0, 1])
    signs = [np.sign(np.corrcoef(xl[i * window:(i + 1) * window], yt[i * window:(i + 1) * window])[0, 1])
             for i in range(k)]
    same = int(sum(s == pooled for s in signs))
    p = float(stats.binomtest(same, k, 0.5).pvalue)
    return {"stat": same / k, "p": p, "windows": k}


def _codes(v: np.ndarray, bins: int) -> np.ndarray:
    edges = np.quantile(v, np.linspace(0, 1, bins + 1)[1:-1])
    return np.searchsorted(edges, v, side="right").astype(np.int64)


def _entropy(*codes: np.ndarray, bins: int) -> float:
    key = np.zeros_like(codes[0])
    for c in codes:
        key = key * bins + c
    cnt = np.bincount(key)
    p = cnt[cnt > 0] / len(key)
    return float(-(p * np.log(p)).sum())


def mutual_information(x: pd.Series, y: pd.Series, lag: int, bins: int = 5, n_surr: int = 199,
                       seed: int = 0) -> dict[str, float]:
    """Binned I(y_t; x_{t-L}) in nats, p from shuffled-x surrogates."""
    xl, yt = _pair(x, y, lag)
    if len(xl) < 100:
        return {"stat": math.nan, "p": math.nan}
    cx, cy = _codes(xl, bins), _codes(yt, bins)
    hy = _entropy(cy, bins=bins)

    def mi(c: np.ndarray) -> float:
        return _entropy(c, bins=bins) + hy - _entropy(c, cy, bins=bins)

    obs = mi(cx)
    rng = np.random.default_rng(seed)
    ge = sum(mi(rng.permutation(cx)) >= obs for _ in range(n_surr))
    return {"stat": obs, "p": (1 + ge) / (1 + n_surr)}


def transfer_entropy(x: pd.Series, y: pd.Series, lag: int, bins: int = 3, n_surr: int = 199,
                     seed: int = 0) -> dict[str, float]:
    """Binned TE x->y = I(y_t; x_{t-L} | y_{t-1}) in nats; p from shuffled-x surrogates (which keep
    the y autodependence intact)."""
    df = pd.concat([x.shift(lag), y, y.shift(1)], axis=1).dropna()
    if len(df) < 100:
        return {"stat": math.nan, "p": math.nan}
    cx, cy, cyp = (_codes(df.iloc[:, i].to_numpy(float), bins) for i in range(3))
    h_y_yp = _entropy(cy, cyp, bins=bins)
    h_yp = _entropy(cyp, bins=bins)

    def te(c: np.ndarray) -> float:
        return h_y_yp + _entropy(c, cyp, bins=bins) - _entropy(cy, c, cyp, bins=bins) - h_yp

    obs = te(cx)
    rng = np.random.default_rng(seed)
    ge = sum(te(rng.permutation(cx)) >= obs for _ in range(n_surr))
    return {"stat": obs, "p": (1 + ge) / (1 + n_surr)}


def benjamini_hochberg(p: np.ndarray, alpha: float = 0.05) -> tuple[np.ndarray, np.ndarray]:
    """Returns (reject mask, BH-adjusted q-values). NaN p-values are never rejected."""
    p = np.asarray(p, float)
    q = np.full_like(p, np.nan)
    ok = np.isfinite(p)
    pv = p[ok]
    m = len(pv)
    if m == 0:
        return np.zeros_like(p, bool), q
    order = np.argsort(pv)
    ranked = pv[order] * m / np.arange(1, m + 1)
    adj = np.minimum.accumulate(ranked[::-1])[::-1].clip(max=1.0)
    qv = np.empty(m)
    qv[order] = adj
    q[ok] = qv
    return np.where(ok, q <= alpha, False), q
