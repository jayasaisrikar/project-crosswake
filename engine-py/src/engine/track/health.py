"""Operational health of the paper engine: is it running, is data fresh, is anything stuck.

Each check is OK / WARN / FAIL. `engine health` exits 1 if any check FAILs, so a scheduler or a
human can see at a glance that hourly steps stopped, data went stale or a ledger drifted.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

from engine.live.risk import reconcile
from engine.track.versions import Version


@dataclass
class Check:
    name: str
    status: str          # OK | WARN | FAIL
    detail: str


def _age_h(now: pd.Timestamp, ts: Any) -> float | None:
    return None if ts is None else (now - pd.Timestamp(ts)) / pd.Timedelta(hours=1)


def _last_line(p: Path) -> dict[str, Any] | None:
    if not p.exists():
        return None
    lines = [x for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    return json.loads(lines[-1]) if lines else None


def ledger_checks(root: Path, v: Version, now: pd.Timestamp, step_warn_h: float = 2.0,
                  step_fail_h: float = 6.0) -> list[Check]:
    d = root / v.paper_dir
    tag = v.id
    st_p = d / "state.json"
    if not st_p.exists():
        return [Check(f"{tag} ledger", "WARN", f"no ledger yet at {v.paper_dir} (run `engine live step`)")]
    st = json.loads(st_p.read_text(encoding="utf-8"))
    out: list[Check] = []
    sig = _last_line(d / "signals.jsonl")
    age = _age_h(now, sig.get("logged_at")) if sig else None
    if age is None:
        out.append(Check(f"{tag} last step", "WARN", "no step logged yet"))
    else:
        s = "OK" if age <= step_warn_h else ("WARN" if age <= step_fail_h else "FAIL")
        out.append(Check(f"{tag} last step", s, f"{age:.1f}h ago (hourly expected)"))
    bar_age = _age_h(now, st.get("last_bar"))
    if bar_age is not None:
        s = "OK" if bar_age <= 3 else ("WARN" if bar_age <= 8 else "FAIL")
        out.append(Check(f"{tag} last bar", s, f"{st['last_bar']} ({bar_age:.1f}h old)"))
    pend = st.get("pending")
    if pend:
        p_age = _age_h(now, pend.get("decision_ts")) or 0.0
        out.append(Check(f"{tag} pending order", "OK" if p_age <= 3 else "WARN",
                         f"decided {p_age:.1f}h ago, fills at next step"))
    out.append(Check(f"{tag} kill switch", "FAIL" if st.get("killed") else "OK",
                     "LATCHED - manual reset needed" if st.get("killed") else "off"))
    fills_p = d / "fills.jsonl"
    fills = [json.loads(x) for x in fills_p.read_text(encoding="utf-8").splitlines() if x.strip()] \
        if fills_p.exists() else []
    mism = reconcile(st.get("qty", {}), [f for f in fills if f.get("side") != "funding"])
    out.append(Check(f"{tag} reconciliation", "FAIL" if mism else "OK",
                     "; ".join(mism[:3]) if mism else f"ledger matches {len(fills)} fill rows"))
    if sig and (sig.get("halt") or sig.get("reasons")):
        out.append(Check(f"{tag} last decision", "WARN", "halted: " + "; ".join(sig.get("reasons", []))))
    return out


def data_checks(root: Path, now: pd.Timestamp, min_free_gb: float = 2.0) -> list[Check]:
    out: list[Check] = []
    bars = root / "data" / "cleaned" / "bars"
    if bars.exists():
        files = list(bars.rglob("*.parquet"))
        if files:
            newest = max(f.stat().st_mtime for f in files)
            age_d = (now - pd.Timestamp(newest, unit="s", tz="UTC")) / pd.Timedelta(days=1)
            out.append(Check("cleaned history", "OK" if age_d <= 45 else "WARN",
                             f"last rebuilt {age_d:.0f} days ago (live feed tops it up hourly)"))
    free_gb = shutil.disk_usage(root).free / 1e9
    out.append(Check("disk space", "OK" if free_gb >= min_free_gb else "FAIL", f"{free_gb:.1f} GB free"))
    for log in (root / "logs").glob("*.log") if (root / "logs").exists() else []:
        mb = log.stat().st_size / 1e6
        if mb > 100:
            out.append(Check(f"log {log.name}", "WARN", f"{mb:.0f} MB - rotate it"))
    return out


def run_health(root: Path, versions: list[Version], now: pd.Timestamp | None = None) -> list[Check]:
    now = now or pd.Timestamp.now(tz="UTC")
    out: list[Check] = []
    for v in versions:
        out += ledger_checks(root, v, now)
    return out + data_checks(root, now)


def format_health(checks: list[Check]) -> str:
    worst = "FAIL" if any(c.status == "FAIL" for c in checks) else \
        ("WARN" if any(c.status == "WARN" for c in checks) else "OK")
    return "\n".join([f"Health: {worst}"] + [f"  [{c.status:4s}] {c.name}: {c.detail}" for c in checks])
