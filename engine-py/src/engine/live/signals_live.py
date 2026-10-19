"""Latest target weights per sleeve and combined (allocation-weighted), plus diff vs paper positions."""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from engine.contracts import Dataset
from engine.signals.registry import build_strategies

Weights = dict[str, dict[str, float]]   # market -> symbol -> weight (fraction of equity)

log = logging.getLogger(__name__)


def resolve_allocation(names: Sequence[str], alloc_cfg: Mapping[str, Any] | None) -> dict[str, float]:
    """Capital share per enabled sleeve, shared by the backtest pipeline and the live paper loop.

    * No `strategies.allocation` block at all -> equal weight 1/N over the enabled sleeves.
    * Otherwise the block is authoritative: an enabled sleeve missing from it gets 0.0 and is SKIPPED
      (not traded, not backtested), with a warning. Previously the backtest gave such a sleeve zero
      capital (instantly "ruined") while live silently gave it 1/N on top of the configured weights
      (AUDIT_REPORT B2); skipping is the less surprising rule because the configured weights keep
      summing to what the user wrote.
    """
    names = list(names)
    if not alloc_cfg:
        return {n: 1.0 / len(names) for n in names} if names else {}
    out: dict[str, float] = {}
    for n in names:
        if n in alloc_cfg:
            out[n] = float(alloc_cfg[n])
        else:
            log.warning("sleeve %r is enabled but has no strategies.allocation entry; skipped", n)
            out[n] = 0.0
    return out


@dataclass
class LiveSignal:
    asof: pd.Timestamp                       # last closed bar the decision is based on
    sleeves: dict[str, Weights]              # sleeve name -> weights (fraction of SLEEVE equity)
    decided_at: dict[str, str | None]        # sleeve -> ts of the decision row used
    combined: Weights                        # fraction of TOTAL equity
    allocation: dict[str, float] = field(default_factory=dict)


def _last_row(df: pd.DataFrame, t: pd.Timestamp) -> tuple[dict[str, float], str | None]:
    if df is None or df.empty:
        return {}, None
    sub = df.loc[:t]
    if sub.empty:
        return {}, None
    row = sub.iloc[-1].fillna(0.0)
    return {str(k): float(v) for k, v in row.items() if float(v) != 0.0}, str(sub.index[-1])


def latest_signal(exp_cfg: dict[str, Any], data: Dataset) -> LiveSignal:
    asof = data.perp.close.index.union(data.spot.close.index)[-1]
    alloc_cfg = exp_cfg.get("strategies", {}).get("allocation", {}) or {}
    sleeves: dict[str, Weights] = {}
    decided: dict[str, str | None] = {}
    combined: Weights = {"spot": {}, "perp": {}}
    strategies = build_strategies(exp_cfg)
    alloc = resolve_allocation([s.name for s in strategies], alloc_cfg)
    for strat in strategies:
        if alloc[strat.name] == 0.0:
            continue
        tw = strat.target_weights(data)
        w: Weights = {}
        ts_used: str | None = None
        for m, df in (("spot", tw.spot), ("perp", tw.perp)):
            w[m], t_m = _last_row(df, asof)
            ts_used = max(filter(None, [ts_used, t_m]), default=None)
        sleeves[strat.name], decided[strat.name] = w, ts_used
        for m, ws in w.items():
            for sym, v in ws.items():
                combined[m][sym] = combined[m].get(sym, 0.0) + alloc[strat.name] * v
    combined = {m: {s: v for s, v in ws.items() if abs(v) > 1e-12} for m, ws in combined.items()}
    return LiveSignal(asof=asof, sleeves=sleeves, decided_at=decided, combined=combined, allocation=alloc)


def gross(w: Weights) -> float:
    return sum(abs(v) for ws in w.values() for v in ws.values())


def scale_to_gross(w: Weights, max_gross: float) -> tuple[Weights, float]:
    g = gross(w)
    k = max_gross / g if g > max_gross > 0 else 1.0
    return {m: {s: v * k for s, v in ws.items()} for m, ws in w.items()}, k


def diff_weights(target: Weights, current: Weights, tol: float = 1e-9) -> list[dict[str, Any]]:
    """Rows {market, symbol, current, target, delta} where they differ."""
    out = []
    for m in ("spot", "perp"):
        t, c = target.get(m, {}), current.get(m, {})
        for s in sorted(set(t) | set(c)):
            d = t.get(s, 0.0) - c.get(s, 0.0)
            if abs(d) > tol:
                out.append({"market": m, "symbol": s, "current": c.get(s, 0.0), "target": t.get(s, 0.0),
                            "delta": d})
    return out
