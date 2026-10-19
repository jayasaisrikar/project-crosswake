"""Model combination: diversification diagnostics, OOS-error weighting, admission test, disagreement.

All inputs are walk-forward OOS series (index = decision time, one column per model):
  signals  -- model forecasts (expected return or position)
  returns  -- per-model OOS strategy returns (net of costs)
  errors   -- forecast errors (forecast - realized)
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd

from engine.research.contract import Prediction


def drawdown(returns: pd.Series) -> pd.Series:
    eq = (1 + returns.fillna(0)).cumprod()
    return 1 - eq / eq.cummax()


def drawdown_overlap(returns: pd.DataFrame, threshold: float = 0.05) -> pd.DataFrame:
    """P(both in drawdown > threshold | either is) for each model pair (Jaccard of DD periods)."""
    dd = pd.DataFrame({c: drawdown(returns[c]) > threshold for c in returns.columns})
    cols = list(returns.columns)
    out = pd.DataFrame(np.nan, index=cols, columns=cols)
    for a in cols:
        for b in cols:
            u = (dd[a] | dd[b]).sum()
            out.loc[a, b] = float((dd[a] & dd[b]).sum() / u) if u else 0.0
    return out


def regime_overlap(returns: pd.DataFrame, regimes: pd.Series) -> pd.DataFrame:
    """Jaccard overlap of the sets of regimes in which each model has positive mean OOS return."""
    good = {c: set(returns[c].groupby(regimes.reindex(returns.index)).mean().pipe(lambda s: s[s > 0]).index)
            for c in returns.columns}
    cols = list(returns.columns)
    out = pd.DataFrame(np.nan, index=cols, columns=cols)
    for a in cols:
        for b in cols:
            u = good[a] | good[b]
            out.loc[a, b] = len(good[a] & good[b]) / len(u) if u else 0.0
    return out


@dataclass
class Diagnostics:
    signal_corr: pd.DataFrame
    return_corr: pd.DataFrame
    drawdown_overlap: pd.DataFrame
    regime_overlap: pd.DataFrame | None = None


def diversification_diagnostics(signals: pd.DataFrame, returns: pd.DataFrame,
                                regimes: pd.Series | None = None, dd_threshold: float = 0.05) -> Diagnostics:
    return Diagnostics(
        signal_corr=signals.corr(),
        return_corr=returns.corr(),
        drawdown_overlap=drawdown_overlap(returns, dd_threshold),
        regime_overlap=regime_overlap(returns, regimes) if regimes is not None else None,
    )


def inverse_variance_weights(errors: pd.DataFrame, shrinkage: float = 0.5) -> pd.Series:
    """w_i ∝ 1/Var(err_i), shrunk toward equal weight: w = (1-λ) w_iv + λ / N. Sums to 1."""
    var = errors.var().replace(0, np.nan)
    iv = (1 / var).fillna(0.0)
    n = len(iv)
    if n == 0:
        return iv
    w_iv = iv / iv.sum() if iv.sum() > 0 else pd.Series(1.0 / n, index=iv.index)
    lam = float(np.clip(shrinkage, 0, 1))
    return (1 - lam) * w_iv + lam / n


def regime_weights(errors: pd.DataFrame, regimes: pd.Series, shrinkage: float = 0.5,
                   min_obs: int = 50) -> dict[str, pd.Series]:
    """Inverse-variance weights per regime; regimes with < min_obs fall back to unconditional weights."""
    base = inverse_variance_weights(errors, shrinkage)
    r = regimes.reindex(errors.index)
    out: dict[str, pd.Series] = {}
    for reg, sub in errors.groupby(r):
        out[str(reg)] = inverse_variance_weights(sub, shrinkage) if len(sub) >= min_obs else base
    return out


def sharpe(r: pd.Series) -> float:
    r = r.dropna()
    s = r.std()
    return float(r.mean() / s) if len(r) > 1 and s > 0 else float("nan")


@dataclass
class AdmissionResult:
    admitted: list[str]
    rejected: dict[str, str] = field(default_factory=dict)


def select_models(returns: pd.DataFrame, signals: pd.DataFrame | None = None, corr_cap: float = 0.8,
                  min_sharpe_gain: float = 0.0, min_t: float = 0.0) -> AdmissionResult:
    """Greedy admission ordered by standalone OOS Sharpe.

    A candidate is admitted only if (a) its |return corr| (and |signal corr| if given) with every
    admitted model is <= corr_cap and (b) the equal-weight combo Sharpe rises by > min_sharpe_gain
    and the candidate's OOS return orthogonal to the admitted combo has a t-stat > min_t.
    """
    order = sorted(returns.columns, key=lambda c: -np.nan_to_num(sharpe(pd.Series(returns[c])), nan=-np.inf))
    res = AdmissionResult(admitted=[])
    for c in order:
        if not res.admitted:
            if sharpe(pd.Series(returns[c])) > 0:
                res.admitted.append(c)
            else:
                res.rejected[c] = "non-positive standalone OOS Sharpe"
            continue
        rc = returns[res.admitted].corrwith(returns[c]).abs().max()
        sc = signals[res.admitted].corrwith(signals[c]).abs().max() if signals is not None else 0.0
        if rc > corr_cap or sc > corr_cap:
            res.rejected[c] = f"correlation cap: return {rc:.2f}, signal {sc:.2f} > {corr_cap}"
            continue
        base = returns[res.admitted].mean(axis=1)
        new = returns[[*res.admitted, c]].mean(axis=1)
        gain = sharpe(new) - sharpe(base)
        df = pd.concat([base, returns[c]], axis=1).dropna()
        x, y = df.iloc[:, 0].to_numpy(), df.iloc[:, 1].to_numpy()
        beta = float(np.dot(x - x.mean(), y - y.mean()) / max(np.var(x) * len(x), 1e-18))
        resid = y - beta * x
        sd = float(resid.std(ddof=1))
        t = float(resid.mean() / (sd / math.sqrt(len(resid)))) if sd > 0 else 0.0
        if gain <= min_sharpe_gain or t <= min_t:
            res.rejected[c] = f"no incremental OOS info: dSharpe {gain:.4f}, alpha t {t:.2f}"
            continue
        res.admitted.append(c)
    return res


def sign_dispersion(preds: Sequence[Prediction], weights: dict[str, float] | None = None) -> float:
    """1 - |weighted mean sign| in [0,1]: 0 = unanimous, 1 = evenly split."""
    if not preds:
        return float("nan")
    w = np.array([(weights or {}).get(p.model_id, 1.0) for p in preds], dtype=float)
    s = np.sign([p.expected_return for p in preds])
    tot = w.sum()
    return float(1 - abs((w * s).sum() / tot)) if tot > 0 else float("nan")


def combine_predictions(preds: Sequence[Prediction], weights: dict[str, float],
                        max_disagreement: float = 0.5, model_id: str = "ensemble") -> Prediction:
    """Weighted combination for ONE asset/time. Confidence is shrunk by (1 - dispersion); if
    dispersion > max_disagreement the result is NO TRADE (direction 0, reason model_disagreement)."""
    use = [p for p in preds if weights.get(p.model_id, 0.0) > 0]
    if not use:
        raise ValueError("no admitted predictions to combine")
    w = np.array([weights[p.model_id] for p in use])
    w = w / w.sum()
    er = float(np.dot(w, [p.expected_return for p in use]))
    unc = float(math.sqrt(np.dot(w**2, [p.uncertainty**2 for p in use])))
    risk = float(np.dot(w, [p.risk for p in use]))
    confs = np.array([p.confidence for p in use], dtype=float)
    conf = float(np.dot(w, confs)) if np.all(np.isfinite(confs)) else float("nan")
    disp = sign_dispersion(use, {p.model_id: wi for p, wi in zip(use, w, strict=True)})
    conf_adj = conf * (1 - disp) + 0.5 * disp if math.isfinite(conf) else conf  # shrink toward coin flip
    direction: int = 0 if er == 0 else (1 if er > 0 else -1)
    reason = ""
    if disp > max_disagreement:
        direction, reason = 0, f"model_disagreement: sign dispersion {disp:.2f} > {max_disagreement}"
    first = use[0]
    return replace(first, model_id=model_id, expected_return=er, direction=direction,  # type: ignore[arg-type]
                   confidence=conf_adj, uncertainty=unc, risk=risk,
                   model_sources=tuple(p.model_id for p in use),
                   features={**first.features, "sign_dispersion": disp}, reason=reason)
