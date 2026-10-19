"""Concept-drift detection.

* Feature distributions: PSI and two-sample KS (reference window vs current window).
* Prediction error: Page-Hinkley test on the live error stream (per model).
* Market structure: BTC-alt correlation, funding level, realized vol, liquidity (volume) shifts.

Each detected drift becomes a ``DriftEvent``; ``write_triggers`` appends research triggers (a request
for a new hypothesis, with context) to research/triggers.jsonl.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats

from engine.monitor._io import append_jsonl, read_jsonl

TRIGGERS_PATH = Path("research/triggers.jsonl")


@dataclass
class DriftEvent:
    ts: str
    kind: str                    # feature | error | market
    name: str                    # feature / model / market-structure metric
    statistic: str               # psi | ks | page_hinkley | rel_change | abs_change
    value: float
    threshold: float
    model_id: str = ""
    context: dict[str, Any] = field(default_factory=dict)


def psi(ref: np.ndarray | pd.Series, cur: np.ndarray | pd.Series, bins: int = 10) -> float:
    """Population stability index using reference-quantile bins."""
    a = np.asarray(ref, dtype=float)
    b = np.asarray(cur, dtype=float)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < bins or len(b) < 2:
        return math.nan
    edges = np.unique(np.quantile(a, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return math.nan
    edges[0], edges[-1] = -np.inf, np.inf
    pa = np.histogram(a, edges)[0] / len(a)
    pb = np.histogram(b, edges)[0] / len(b)
    pa, pb = np.clip(pa, 1e-6, None), np.clip(pb, 1e-6, None)
    return float(np.sum((pb - pa) * np.log(pb / pa)))


def ks(ref: np.ndarray | pd.Series, cur: np.ndarray | pd.Series) -> tuple[float, float]:
    a = np.asarray(ref, dtype=float)
    b = np.asarray(cur, dtype=float)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 2 or len(b) < 2:
        return math.nan, math.nan
    r = stats.ks_2samp(a, b)
    return float(r.statistic), float(r.pvalue)


def page_hinkley(x: np.ndarray | pd.Series, delta: float = 0.005, lam: float = 0.05,
                 burn_in: int = 30) -> int | None:
    """Two-sided Page-Hinkley test. Returns the index of the first alarm, or None."""
    v = np.asarray(x, dtype=float)
    v = v[np.isfinite(v)]
    mean = 0.0
    up = dn = 0.0
    up_min = dn_max = 0.0
    for i, xi in enumerate(v):
        mean += (xi - mean) / (i + 1)
        up += xi - mean - delta
        dn += xi - mean + delta
        up_min, dn_max = min(up_min, up), max(dn_max, dn)
        if i >= burn_in and (up - up_min > lam or dn_max - dn > lam):
            return i
    return None


def feature_drift(ref: pd.DataFrame, cur: pd.DataFrame, now: pd.Timestamp, psi_thr: float = 0.25,
                  ks_p: float = 0.001) -> list[DriftEvent]:
    out: list[DriftEvent] = []
    for c in sorted(set(ref.columns) & set(cur.columns)):
        p = psi(ref[c], cur[c])
        stat, pv = ks(ref[c], cur[c])
        if not math.isnan(p) and p > psi_thr:
            out.append(DriftEvent(now.isoformat(), "feature", c, "psi", p, psi_thr,
                                  context={"ks": stat, "ks_p": pv}))
        elif not math.isnan(pv) and pv < ks_p:
            out.append(DriftEvent(now.isoformat(), "feature", c, "ks", stat, ks_p, context={"ks_p": pv}))
    return out


def error_drift(df: pd.DataFrame, now: pd.Timestamp, delta: float = 0.005,
                lam: float = 0.05) -> list[DriftEvent]:
    """Page-Hinkley per model on the resolved prediction-error stream (ledger.joined frame)."""
    out: list[DriftEvent] = []
    if df.empty or "error" not in df.columns:
        return out
    for mid, g in df[df["error"].notna()].sort_values("expiry").groupby("model_id"):
        idx = page_hinkley(g["error"].to_numpy(), delta, lam)
        if idx is not None:
            out.append(DriftEvent(now.isoformat(), "error", str(mid), "page_hinkley", float(idx), lam,
                                  model_id=str(mid),
                                  context={"n": len(g), "alarm_at": str(g["expiry"].iloc[idx])}))
    return out


def market_structure(ref: pd.DataFrame, cur: pd.DataFrame, now: pd.Timestamp,
                     rel_thr: float = 0.5, corr_thr: float = 0.25) -> list[DriftEvent]:
    """Columns used if present: btc_ret, alt_ret, funding, ret (for vol), volume (liquidity)."""
    out: list[DriftEvent] = []

    def ev(name: str, stat: str, val: float, thr: float, ctx: dict[str, Any]) -> None:
        out.append(DriftEvent(now.isoformat(), "market", name, stat, val, thr, context=ctx))

    if {"btc_ret", "alt_ret"} <= set(ref) & set(cur):
        a, b = ref["btc_ret"].corr(ref["alt_ret"]), cur["btc_ret"].corr(cur["alt_ret"])
        if np.isfinite(a) and np.isfinite(b) and abs(b - a) > corr_thr:
            ev("btc_alt_corr", "abs_change", float(b - a), corr_thr, {"ref": a, "cur": b})
    if "funding" in ref and "funding" in cur:
        a, b = ref["funding"].mean(), cur["funding"].mean()
        sd = ref["funding"].std()
        if np.isfinite(sd) and sd > 0 and abs(b - a) / sd > 3:
            ev("funding_level", "abs_change", float((b - a) / sd), 3.0, {"ref": a, "cur": b})
        if np.sign(a) != np.sign(b) and abs(b) > sd:
            ev("funding_sign", "abs_change", float(b - a), float(sd), {"ref": a, "cur": b})
    for col, name in (("ret", "volatility"), ("volume", "liquidity")):
        if col in ref and col in cur:
            a = ref[col].std() if col == "ret" else ref[col].median()
            b = cur[col].std() if col == "ret" else cur[col].median()
            if np.isfinite(a) and a > 0 and np.isfinite(b) and abs(b / a - 1) > rel_thr:
                ev(name, "rel_change", float(b / a - 1), rel_thr, {"ref": a, "cur": b})
    return out


def write_triggers(events: list[DriftEvent], path: Path = TRIGGERS_PATH) -> list[dict[str, Any]]:
    """Append one research trigger per new drift event (deduped by trigger_id)."""
    seen = {r.get("trigger_id") for r in read_jsonl(path)}
    rows: list[dict[str, Any]] = []
    for e in events:
        tid = hashlib.sha1(f"{e.kind}|{e.name}|{e.statistic}|{e.ts[:10]}".encode()).hexdigest()[:12]
        if tid in seen:
            continue
        seen.add(tid)
        rows.append({"trigger_id": tid, "created": e.ts, "type": "new_hypothesis_request",
                     "reason": f"{e.kind} drift: {e.name} "
                               f"({e.statistic}={e.value:.4g}, thr={e.threshold:.4g})",
                     "status": "open", "drift": asdict(e)})
    append_jsonl(path, rows)
    return rows
