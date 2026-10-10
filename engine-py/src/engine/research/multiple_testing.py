"""Multiple-testing corrections + a single entry point over the existing validation statistics.

Holm (1979) step-down FWER and Benjamini-Hochberg (1995) FDR are implemented here; DSR, PBO,
SPA, stationary block bootstrap and HAC t-stats are REUSED from engine.validation.stats.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats as st

from engine.validation.stats import (
    _to_daily,
    alpha_vs_benchmark,
    block_bootstrap_ci,
    deflated_sharpe,
    pbo_cscv,
    sharpe_hac_tstat,
    spa_test,
)

__all__ = [
    "alpha_vs_benchmark",
    "benjamini_hochberg",
    "block_bootstrap_ci",
    "deflated_sharpe",
    "holm",
    "pbo_cscv",
    "sharpe_hac_tstat",
    "spa_test",
    "strategy_stats",
]


def holm(pvalues: Sequence[float], alpha: float = 0.05) -> tuple[np.ndarray, np.ndarray]:
    """Holm step-down. Returns (reject mask, adjusted p-values), original order."""
    p = np.asarray(pvalues, dtype=float)
    m = len(p)
    order = np.argsort(p)
    adj = np.empty(m)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[i]))
        adj[i] = running
    return adj <= alpha, adj


def benjamini_hochberg(pvalues: Sequence[float], alpha: float = 0.05) -> tuple[np.ndarray, np.ndarray]:
    """BH step-up FDR. Returns (reject mask, adjusted q-values), original order."""
    p = np.asarray(pvalues, dtype=float)
    m = len(p)
    order = np.argsort(p)
    ranked = p[order] * m / np.arange(1, m + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1].clip(max=1.0)
    adj = np.empty(m)
    adj[order] = q
    return adj <= alpha, adj


def strategy_stats(returns: pd.Series, trial_sharpes_daily: list[float] | None = None,
                   bootstrap_n: int = 500, seed: int = 0, n_trials: int | None = None) -> dict[str, Any]:
    """Daily Sharpe (per-period and annualised x sqrt(365)), HAC t/p, bootstrap CI of annual
    Sharpe, DSR against the previous trial Sharpes (+ this one). `n_trials` is the total number of
    trials tried (may exceed the Sharpe values on record: crashes, neighbours); default = len."""
    d = _to_daily(returns)
    out: dict[str, Any] = {"n_days": int(len(d))}
    if len(d) < 10 or float(d.std(ddof=1)) == 0.0:
        out.update(sharpe_daily=float("nan"), sharpe_ann=float("nan"), hac_t=float("nan"),
                   hac_p=float("nan"), dsr=float("nan"), boot_lo=float("nan"), boot_hi=float("nan"))
        return out
    sr = float(d.mean() / d.std(ddof=1))
    t = sharpe_hac_tstat(d)
    trials = list(trial_sharpes_daily or []) + [sr]
    try:
        lo, hi = block_bootstrap_ci(
            d, lambda x: float(np.mean(x) / np.std(x, ddof=1) * math.sqrt(365)) if np.std(x) > 0 else 0.0,
            n=bootstrap_n, seed=seed)
    except Exception:  # noqa: BLE001 - bootstrap can fail on degenerate series
        lo, hi = float("nan"), float("nan")
    out.update(
        sharpe_daily=sr,
        sharpe_ann=sr * math.sqrt(365),
        hac_t=t,
        hac_p=float(2 * (1 - st.norm.cdf(abs(t)))) if math.isfinite(t) else float("nan"),
        dsr=deflated_sharpe(d, trials, max(int(n_trials or 0), len(trials))),
        n_trials=max(int(n_trials or 0), len(trials)),
        boot_lo=lo,
        boot_hi=hi,
    )
    return out
