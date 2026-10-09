"""Predictive lead-lag tests: Granger-style incremental prediction (§4.C), dynamic rolling-lag
estimation (§4.E) and walk-forward out-of-sample R^2 for regularized/linear predictors (§4.G).

Everything here is causal and, where it makes a trading claim, out-of-sample:
  * Granger test asks whether LAGGED BTC returns add predictive power for an altcoin's NEXT return
    AFTER controlling for the altcoin's own lagged returns -- the control the master prompt demands,
    so we never credit BTC for autocorrelation the alt already carries. Inference is HAC (Newey-West)
    so overlapping / heteroskedastic residuals do not inflate significance. Across the 13 followers we
    apply Benjamini-Hochberg FDR control (§6: multiple comparisons), not a raw per-alt p-value.
  * Rolling-lag estimation measures whether the "best" BTC->alt lag is stable or just noise that would
    be dangerous to trade (§4.E): a lag that wanders every month is not a tradable constant.
  * OOS R^2 is the Campbell-Thompson statistic vs the in-sample-mean forecast, evaluated only on
    walk-forward TEST folds. A linear BTC-lag predictor is kept over the own-lags baseline only if it
    shows POSITIVE incremental OOS R^2 -- the §4.G rule "complex only if it beats simple out of sample".

None of these functions read forward data relative to the point they score; they take a return panel
whose rows are bar-close returns and only ever use shift(+L) (past) regressors."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm

from engine.validation.walkforward import walk_forward_splits


def benjamini_hochberg(pvals: dict[str, float], alpha: float = 0.10) -> dict[str, bool]:
    """Benjamini-Hochberg FDR: return {name: rejected} at level `alpha`. NaN p-values never reject."""
    items = [(k, v) for k, v in pvals.items() if v is not None and np.isfinite(v)]
    m = len(items)
    rejected = {k: False for k in pvals}
    if m == 0:
        return rejected
    items.sort(key=lambda kv: kv[1])
    kmax = 0
    for i, (_, p) in enumerate(items, start=1):
        if p <= alpha * i / m:
            kmax = i
    for i, (k, _) in enumerate(items, start=1):
        rejected[k] = i <= kmax
    return rejected


def _lag_matrix(x: pd.Series, p: int) -> pd.DataFrame:
    return pd.concat({f"{x.name}_l{i}": x.shift(i) for i in range(1, p + 1)}, axis=1)


def granger_incremental(r_alt: pd.Series, r_btc: pd.Series, p: int) -> dict[str, float]:
    """HAC Wald test that lags 1..p of r_btc jointly add predictive info for r_alt[t], controlling for
    lags 1..p of r_alt itself. Returns f_stat, p_value, n, btc_beta_sum (net sign of the BTC effect)."""
    df = pd.concat([r_alt.rename("y"), _lag_matrix(r_alt.rename("alt"), p),
                    _lag_matrix(r_btc.rename("btc"), p)], axis=1).dropna()
    nan = {"f_stat": float("nan"), "p_value": float("nan"), "n": float(len(df)), "btc_beta_sum": float("nan")}
    if len(df) < 10 * (2 * p + 1):
        return nan
    y = df["y"].to_numpy(float)
    xcols = [c for c in df.columns if c != "y"]
    X = sm.add_constant(df[xcols].to_numpy(float), has_constant="add")
    lags = max(int(round(4 * (len(df) / 100.0) ** (2.0 / 9.0))), 1)
    res = sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": lags})
    btc_idx = [i + 1 for i, c in enumerate(xcols) if c.startswith("btc_l")]  # +1 for const
    R = np.zeros((len(btc_idx), X.shape[1]))
    for row, j in enumerate(btc_idx):
        R[row, j] = 1.0
    wald = res.wald_test(R, scalar=True)
    beta = np.asarray(res.params)
    return {"f_stat": float(wald.statistic), "p_value": float(wald.pvalue),
            "n": float(len(df)), "btc_beta_sum": float(beta[btc_idx].sum())}


def granger_table(r_alt: pd.DataFrame, r_btc: pd.Series, p: int, alpha: float = 0.10) -> pd.DataFrame:
    """Per-follower Granger test + BH-FDR flag across the follower family."""
    rows = {c: granger_incremental(r_alt[c], r_btc, p) for c in r_alt.columns}
    rej = benjamini_hochberg({c: rows[c]["p_value"] for c in rows}, alpha)
    out = pd.DataFrame(rows).T
    out["fdr_reject"] = pd.Series(rej)
    out.index.name = "symbol"
    return out.reset_index()


def rolling_lag(r_alt: pd.Series, r_btc: pd.Series, window: int, max_lag: int,
                step: int) -> pd.DataFrame:
    """At each sampled time t (every `step` bars), over the trailing `window` bars find the lag
    L in 0..max_lag maximising |corr(r_btc[t-L], r_alt[t])|. Causal (trailing window only)."""
    df = pd.concat([r_alt.rename("a"), r_btc.rename("b")], axis=1)
    idx = df.index
    recs: list[dict[str, Any]] = []
    for pos in range(window, len(idx), step):
        seg = df.iloc[pos - window:pos]
        best_l, best_c = 0, 0.0
        for L in range(max_lag + 1):
            c = seg["a"].corr(seg["b"].shift(L))
            if np.isfinite(c) and abs(c) > abs(best_c):
                best_l, best_c = L, float(c)
        recs.append({"ts": idx[pos - 1], "best_lag": best_l, "best_corr": round(best_c, 4)})
    return pd.DataFrame(recs)


def rolling_lag_stability(r_alt: pd.DataFrame, r_btc: pd.Series, window: int, max_lag: int,
                          step: int) -> pd.DataFrame:
    """Dynamic lag stability per follower: modal lag, share of windows at the mode, std of the lag."""
    recs: list[dict[str, Any]] = []
    for c in r_alt.columns:
        rl = rolling_lag(r_alt[c], r_btc, window, max_lag, step)
        if rl.empty:
            continue
        lags = rl["best_lag"]
        mode = int(lags.mode().iloc[0])
        recs.append({"symbol": c, "n_windows": int(len(lags)), "modal_lag": mode,
                     "share_at_mode": round(float((lags == mode).mean()), 3),
                     "lag_std": round(float(lags.std()), 3),
                     "mean_abs_corr": round(float(rl["best_corr"].abs().mean()), 4)})
    return pd.DataFrame(recs)


def _ols_oos_r2(y: pd.Series, X: pd.DataFrame, splits: list[tuple[np.ndarray, np.ndarray]]) -> float:
    """Pooled walk-forward OOS R^2 vs the train-mean forecast (Campbell-Thompson). >0 => the model
    beats the naive mean out of sample. Positional splits index into the aligned (y, X) rows."""
    yv = y.to_numpy(float)
    Xv = sm.add_constant(X.to_numpy(float), has_constant="add")
    sse_m = sse_0 = 0.0
    used = 0
    for tr, te in splits:
        if len(tr) < Xv.shape[1] + 5 or len(te) == 0:
            continue
        beta, *_ = np.linalg.lstsq(Xv[tr], yv[tr], rcond=None)
        pred = Xv[te] @ beta
        mu = float(yv[tr].mean())
        sse_m += float(np.sum((yv[te] - pred) ** 2))
        sse_0 += float(np.sum((yv[te] - mu) ** 2))
        used += len(te)
    if used == 0 or sse_0 <= 0:
        return float("nan")
    return float(1.0 - sse_m / sse_0)


def oos_predictive_r2(r_alt: pd.DataFrame, r_btc: pd.Series, p: int, train_months: int,
                      test_months: int, embargo_bars: int) -> pd.DataFrame:
    """Per-follower walk-forward OOS R^2 for an own-lags baseline vs own-lags + BTC-lags model.
    `incremental` = r2_btc - r2_own: positive means lagged BTC adds genuine OOS predictive value."""
    recs: list[dict[str, Any]] = []
    for c in r_alt.columns:
        own = _lag_matrix(r_alt[c].rename("alt"), p)
        btc = _lag_matrix(r_btc.rename("btc"), p)
        df = pd.concat([r_alt[c].rename("y"), own, btc], axis=1).dropna()
        if len(df) < 10 * (2 * p + 1):
            continue
        splits = walk_forward_splits(pd.DatetimeIndex(df.index), train_months, test_months, embargo_bars)
        if not splits:
            continue
        y = df["y"]
        r2_own = _ols_oos_r2(y, df[own.columns], splits)
        r2_btc = _ols_oos_r2(y, df[[*own.columns, *btc.columns]], splits)
        recs.append({"symbol": c, "n_folds": len(splits), "r2_oos_own": round(r2_own, 5),
                     "r2_oos_btc": round(r2_btc, 5),
                     "incremental": round(r2_btc - r2_own, 5)})
    return pd.DataFrame(recs)
