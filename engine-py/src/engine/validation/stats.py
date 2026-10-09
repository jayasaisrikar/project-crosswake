"""Statistical validation: HAC t-stat, block bootstrap, PSR/DSR, PBO (CSCV), Hansen SPA."""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
from arch.bootstrap import SPA, StationaryBootstrap, optimal_block_length
from scipy import stats as st

EULER_GAMMA = 0.5772156649015329


def _to_daily(returns: pd.Series) -> pd.Series:
    r = pd.Series(returns, dtype=float).dropna()
    if isinstance(r.index, pd.DatetimeIndex) and len(r) > 1:
        step = (r.index[1:] - r.index[:-1]).min()
        if step < pd.Timedelta(days=1):
            cnt = r.resample("1D").count()
            r = ((1.0 + r).resample("1D").prod() - 1.0)[cnt > 0]
    return r


def sharpe_hac_tstat(returns: pd.Series) -> float:
    """Newey-West t-stat of the mean daily return (maxlags = floor(4 (T/100)^(2/9)))."""
    r = _to_daily(returns).to_numpy()
    T = len(r)
    lags = int(math.floor(4 * (T / 100.0) ** (2.0 / 9.0)))
    res = sm.OLS(r, np.ones((T, 1))).fit(cov_type="HAC", cov_kwds={"maxlags": lags})
    return float(np.asarray(res.tvalues)[0])


def block_bootstrap_ci(
    returns_daily: pd.Series,
    stat_fn: Callable[[np.ndarray], float],
    n: int = 2000,
    alpha: float = 0.05,
    seed: int | None = 0,
) -> tuple[float, float]:
    """Percentile CI of stat_fn under a stationary bootstrap with Politis-White optimal block length."""
    x = np.asarray(pd.Series(returns_daily, dtype=float).dropna(), dtype=float)
    block = float(optimal_block_length(x)["stationary"].iloc[0])
    bs = StationaryBootstrap(max(block, 1.0), x, seed=seed)  # type: ignore[arg-type]
    vals = np.array([float(stat_fn(np.asarray(data[0][0]))) for data in bs.bootstrap(n)])
    lo, hi = np.nanquantile(vals, [alpha / 2, 1 - alpha / 2])
    return float(lo), float(hi)


def probabilistic_sharpe(
    sr: float, T: int, skew: float, kurt: float, sr_benchmark: float = 0.0
) -> float:
    """PSR (Bailey & Lopez de Prado). sr per-period (non-annualized), kurt NON-excess (normal = 3)."""
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr**2
    if denom <= 0 or T < 2:
        return float("nan")
    z = (sr - sr_benchmark) * math.sqrt(T - 1) / math.sqrt(denom)
    return float(st.norm.cdf(z))


def expected_max_sharpe(trial_sharpes: list[float]) -> float:
    """E[max SR] over N trials under the null (Euler-Mascheroni approximation)."""
    n = len(trial_sharpes)
    if n < 2:
        return 0.0
    sd = float(np.std(trial_sharpes, ddof=1))
    return sd * (
        (1 - EULER_GAMMA) * st.norm.ppf(1 - 1.0 / n) + EULER_GAMMA * st.norm.ppf(1 - 1.0 / (n * math.e))
    )


def deflated_sharpe(returns_daily: pd.Series, trial_sharpes: list[float]) -> float:
    """DSR = PSR against E[max SR] of N = len(trial_sharpes) trials. trial_sharpes are per-period
    (daily, non-annualized) Sharpe ratios on the same frequency as returns_daily."""
    r = pd.Series(returns_daily, dtype=float).dropna().to_numpy()
    sr = float(r.mean() / r.std(ddof=1))
    skew = float(st.skew(r))
    kurt = float(st.kurtosis(r, fisher=False))
    return probabilistic_sharpe(sr, len(r), skew, kurt, expected_max_sharpe(trial_sharpes))


def pbo_cscv(returns_matrix: pd.DataFrame, S: int = 16) -> dict[str, Any]:
    """Probability of Backtest Overfitting via Combinatorially Symmetric Cross-Validation.

    returns_matrix: T x N (configs). Performance metric = Sharpe (mean/std) on each half.
    """
    if S % 2:
        raise ValueError("S must be even")
    M = returns_matrix.to_numpy(dtype=float)
    M = M[~np.isnan(M).any(axis=1)]
    T, N = M.shape
    if N < 2 or T < S:
        raise ValueError("need >= 2 configs and T >= S")
    edges = np.linspace(0, T, S + 1).astype(int)
    blocks = [M[edges[i] : edges[i + 1]] for i in range(S)]
    cnt = np.array([len(b) for b in blocks], dtype=float)  # (S,)
    s1 = np.stack([b.sum(axis=0) for b in blocks])  # (S, N)
    s2 = np.stack([(b**2).sum(axis=0) for b in blocks])

    combos = np.array(list(itertools.combinations(range(S), S // 2)))  # (C, S/2)
    mask = np.zeros((len(combos), S), dtype=bool)
    mask[np.arange(len(combos))[:, None], combos] = True
    W = mask.astype(float)

    def sharpe(w: np.ndarray) -> np.ndarray:
        n = (w @ cnt)[:, None]
        mu = (w @ s1) / n
        var = (w @ s2) / n - mu**2
        var = var * n / np.maximum(n - 1, 1)
        return mu / np.sqrt(np.maximum(var, 1e-300))

    is_perf, oos_perf = sharpe(W), sharpe(1.0 - W)  # (C, N)
    best = is_perf.argmax(axis=1)
    rows = np.arange(len(combos))
    oos_best = oos_perf[rows, best]
    rank = (oos_perf < oos_best[:, None]).sum(axis=1) + 1  # 1..N, ascending
    w = rank / (N + 1.0)
    logits = np.log(w / (1.0 - w))
    is_best = is_perf[rows, best]
    slope = float(np.polyfit(is_best, oos_best, 1)[0]) if np.ptp(is_best) > 0 else float("nan")
    return {
        "pbo": float((logits <= 0).mean()),
        "logits": logits,
        "degradation_slope": slope,
        "is_best": is_best,
        "oos_best": oos_best,
    }


def spa_test(
    strategy_returns: pd.DataFrame, benchmark: pd.Series, reps: int = 1000, seed: int | None = 0
) -> dict[str, float]:
    """Hansen SPA: H0 = no strategy beats the benchmark. Losses = -returns."""
    df = pd.concat([benchmark.rename("__bench__"), strategy_returns], axis=1).dropna()
    bench_loss = -df["__bench__"].to_numpy()
    model_loss = -df.drop(columns="__bench__").to_numpy()
    spa = SPA(bench_loss, model_loss, reps=reps, bootstrap="stationary", seed=seed)
    spa.compute()
    pv = spa.pvalues
    return {
        "pvalue": float(pv["consistent"]),
        "pvalue_consistent": float(pv["consistent"]),
        "pvalue_lower": float(pv["lower"]),
        "pvalue_upper": float(pv["upper"]),
    }
