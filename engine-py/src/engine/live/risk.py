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


def check_risk(
    limits: RiskLimits,
    equity: float,
    peak: float,
    day_start_equity: float | None,
    now: pd.Timestamp,
    last_bar: pd.Timestamp | None,
    errors: list[str],
    already_killed: bool = False,
) -> RiskReport:
    rep = RiskReport()
    dd = 1.0 - equity / peak if peak > 0 else 0.0
    if already_killed:
        rep.kill = True
        rep.reasons.append("kill switch latched (manual reset required: set killed=false in state.json)")
    elif dd > limits.max_drawdown:
        rep.kill = True
        rep.reasons.append(f"drawdown {dd:.1%} > limit {limits.max_drawdown:.1%}")
    if day_start_equity and day_start_equity > 0:
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
    """Ledger positions vs positions replayed from the append-only fill log. Returns mismatches."""
    exp: dict[str, dict[str, float]] = {}
    for f in fills:
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
