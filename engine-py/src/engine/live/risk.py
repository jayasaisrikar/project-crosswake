"""Paper-trading risk controls: kill switch, leverage cap, reconciliation."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd


@dataclass(frozen=True)
class RiskLimits:
    max_drawdown: float = 0.20
    daily_loss_limit: float = 0.05
    stale_data_hours: float = 2.0
    max_exchange_errors: int = 0
    max_gross_leverage: float = 2.0
    flatten_on_kill: bool = True
    reconcile_tolerance: float = 1e-6
    stale_mark_tolerance: float = 0.05     # stale-marked |notional| / equity above this => cannot value book

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> RiskLimits:
        r = cfg.get("risk", cfg) or {}
        return cls(**{k: type(getattr(cls, k))(v) for k, v in r.items() if k in cls.__dataclass_fields__})


@dataclass
class RiskReport:
    kill: bool = False          # drawdown kill switch (latched in the ledger)
    halt: bool = False          # no new trades this step (kill, daily loss, stale, errors)
    reasons: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    valuation_stale: bool = False   # book could not be valued at fresh prices (no kill / flatten)


def check_risk(
    limits: RiskLimits,
    equity: float,
    peak: float,
    day_start_equity: float | None,
    now: pd.Timestamp,
    last_bar: pd.Timestamp | None,
    errors: list[str],
    already_killed: bool = False,
    stale_marks: list[str] | None = None,
    stale_frac: float | None = None,
) -> RiskReport:
    """`stale_marks` (O3): held positions that could not be valued at a fresh price; they are marked
    to their last-known price. If they are material (`stale_frac` = their |notional| / equity above
    `limits.stale_mark_tolerance`, or unknown), drawdown / daily loss are NOT evaluated (no new kill,
    no flatten) and the step halts (holds) with reason "cannot value book". Immaterial stale marks
    (e.g. a small position in a settled perp) are only noted; the checks run normally."""
    rep = RiskReport()
    material = bool(stale_marks) and (stale_frac is None or stale_frac > limits.stale_mark_tolerance)
    rep.valuation_stale = material
    dd = 1.0 - equity / peak if peak > 0 else 0.0
    if already_killed:
        rep.kill = True
        rep.reasons.append("kill switch latched (manual reset: `engine live reset-kill --version vNNN "
                           "--reason ...`)")
    if material:
        rep.halt = True
        rep.reasons.append("cannot value book (stale marks, kill switch not evaluated): "
                           + ", ".join((stale_marks or [])[:5])
                           + (" ..." if len(stale_marks or []) > 5 else ""))
    elif stale_marks:
        rep.notes.append(f"immaterial stale marks ({stale_frac:.1%} of equity): "
                         + ", ".join(stale_marks[:5]))
    if not material and not already_killed and dd > limits.max_drawdown:
        rep.kill = True
        rep.reasons.append(f"drawdown {dd:.1%} > limit {limits.max_drawdown:.1%}")
    if not material and day_start_equity and day_start_equity > 0:
        dl = 1.0 - equity / day_start_equity
        if dl > limits.daily_loss_limit:
            rep.halt = True
            rep.reasons.append(f"daily loss {dl:.1%} > limit {limits.daily_loss_limit:.1%}")
    if last_bar is None:
        rep.halt = True
        rep.reasons.append("no market data")
    else:
        age_h = (now - (last_bar + pd.Timedelta(hours=1))) / pd.Timedelta(hours=1)
        if age_h > limits.stale_data_hours:
            rep.halt = True
            rep.reasons.append(f"stale data: last bar closed {age_h:.1f}h ago > {limits.stale_data_hours}h")
    if len(errors) > limits.max_exchange_errors:
        rep.halt = True
        rep.reasons.append(f"{len(errors)} exchange error(s): {errors[0]}")
    rep.halt = rep.halt or rep.kill
    rep.notes.append(f"drawdown from peak {dd:.2%}")
    return rep


def reconcile(ledger_qty: dict[str, dict[str, float]], fills: list[dict[str, Any]],
              tol: float = 1e-6) -> list[str]:
    """Ledger positions vs positions replayed from the append-only fill log. Returns mismatches.

    Fills are deduplicated by fill identity first (engine.live.paper.effective_fills), so a log
    duplicated by an interrupted pre-journal step heals instead of halting the version forever."""
    from engine.live.paper import effective_fills

    exp: dict[str, dict[str, float]] = {}
    for f in effective_fills([f for f in fills if f.get("side") != "funding"]):
        m = exp.setdefault(f["market"], {})
        m[f["symbol"]] = m.get(f["symbol"], 0.0) + float(f["qty"])
    out = []
    for mk in sorted(set(exp) | set(ledger_qty)):
        a, b = ledger_qty.get(mk, {}), exp.get(mk, {})
        for s in sorted(set(a) | set(b)):
            x, y = a.get(s, 0.0), b.get(s, 0.0)
            if abs(x - y) > tol * max(1.0, abs(y)):
                out.append(f"{mk} {s}: ledger {x:.8g} vs fills {y:.8g}")
    return out
