"""Operational health of the paper engine: is it running, is data fresh, is anything stuck.

Each check is OK / WARN / FAIL. `engine health` exits 1 if any check FAILs, so a scheduler or a
human can see at a glance that hourly steps stopped, data went stale or a ledger drifted. Health
never crashes on a damaged ledger: a torn or corrupt file becomes a FAIL check (O2).

Alerting is LOCAL: `local_alert` appends to logs/alerts.log; a Telegram copy is sent only when the
caller passes send=True AND the TELEGRAM_* env vars are already configured. No other remote service.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import pandas as pd

from engine.live.journal import LedgerCorrupt, atomic_write_text, read_rows, tail_rows
from engine.live.paper import duplicate_fills
from engine.live.risk import reconcile
from engine.track.versions import Version

HEARTBEAT = Path("logs") / "heartbeat.json"


@dataclass
class Check:
    name: str
    status: str          # OK | WARN | FAIL
    detail: str


def _age_h(now: pd.Timestamp, ts: Any) -> float | None:
    return None if ts is None else (now - pd.Timestamp(ts)) / pd.Timedelta(hours=1)


def _halted_hours(signals: list[dict[str, Any]], now: pd.Timestamp) -> float:
    """How long the version has been continuously halted (from the tail of signals.jsonl)."""
    since = None
    for r in reversed(signals):
        if not r.get("halt"):
            break
        since = r.get("logged_at")
    if since is None:
        return 0.0
    return _age_h(now, since) or 0.0


def ledger_checks(root: Path, v: Version, now: pd.Timestamp, step_warn_h: float = 2.0,
                  step_fail_h: float = 6.0, halt_fail_h: float = 6.0) -> list[Check]:
    d = root / v.paper_dir
    tag = v.id
    st_p = d / "state.json"
    if not st_p.exists():
        return [Check(f"{tag} ledger", "WARN", f"no ledger yet at {v.paper_dir} (run `engine live step`)")]
    st = json.loads(st_p.read_text(encoding="utf-8"))
    out: list[Check] = []
    if (d / "journal.json").exists():
        out.append(Check(f"{tag} journal", "WARN", "interrupted step pending roll-forward (next step or "
                                                   "`engine live recover`)"))
    rows: dict[str, list[dict[str, Any]]] = {}
    for name in ("fills.jsonl", "equity.jsonl"):
        try:
            rows[name], issues = read_rows(d / name, repair=False)
        except LedgerCorrupt as e:
            out.append(Check(f"{tag} {name}", "FAIL", f"corrupt: {e}"))
            rows[name] = []
            continue
        if issues:
            out.append(Check(f"{tag} {name}", "FAIL", "; ".join(issues) + " - run `engine live recover`"))
    signals = tail_rows(d / "signals.jsonl", 512_000)
    sig = signals[-1] if signals else None
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
                     "LATCHED - `engine live reset-kill` after review" if st.get("killed") else "off"))
    fills = rows.get("fills.jsonl", [])
    mism = reconcile(st.get("qty", {}), [f for f in fills if f.get("side") != "funding"])
    dup = duplicate_fills(fills)
    out.append(Check(f"{tag} reconciliation", "FAIL" if mism else "OK",
                     "; ".join(mism[:3]) if mism else
                     f"ledger matches {len(fills)} fill rows"
                     + (f" ({dup} duplicate rows ignored)" if dup else "")))
    halted = _halted_hours(signals, now)
    if halted > halt_fail_h:
        out.append(Check(f"{tag} halted", "FAIL", f"continuously halted for {halted:.1f}h: "
                         + "; ".join((sig or {}).get("reasons", [])[:3])))
    elif sig and (sig.get("halt") or sig.get("reasons")):
        out.append(Check(f"{tag} last decision", "WARN", "halted: " + "; ".join(sig.get("reasons", []))))
    if sig and sig.get("stale_marks"):
        out.append(Check(f"{tag} valuation", "WARN", "marked to last-known prices: "
                         + ", ".join(sig["stale_marks"][:3])))
    return out


def heartbeat_check(root: Path, now: pd.Timestamp, warn_h: float = 1.5, fail_h: float = 3.0) -> list[Check]:
    p = root / HEARTBEAT
    if not p.exists():
        return [Check("heartbeat", "WARN",
                      "no logs/heartbeat.json yet (written by every `engine live step`)")]
    try:
        hb = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        return [Check("heartbeat", "FAIL", f"unreadable: {e}")]
    age = _age_h(now, hb.get("ts")) or 0.0
    s = "OK" if age <= warn_h else ("WARN" if age <= fail_h else "FAIL")
    rc = int(hb.get("rc", 0))
    out = [Check("heartbeat", s,
                 f"last step ended {age:.1f}h ago on {hb.get('host')} (rev {hb.get('code_rev')})")]
    if rc >= 2:
        out.append(Check("last step exit code", "FAIL", f"rc={rc} {hb.get('versions')}"))
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
                             f"last rebuilt {age_d:.0f} days ago (live feed + bar cache top it up hourly)"))
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
        try:
            out += ledger_checks(root, v, now)
        except Exception as e:  # noqa: BLE001  (health must report, never crash)
            out.append(Check(f"{v.id} ledger", "FAIL", f"health check crashed: {type(e).__name__}: {e}"))
    if versions:
        out += heartbeat_check(root, now)
    return out + data_checks(root, now)


def format_health(checks: list[Check]) -> str:
    worst = "FAIL" if any(c.status == "FAIL" for c in checks) else \
        ("WARN" if any(c.status == "WARN" for c in checks) else "OK")
    return "\n".join([f"Health: {worst}"] + [f"  [{c.status:4s}] {c.name}: {c.detail}" for c in checks])


def write_health_state(root: Path, checks: list[Check]) -> Path:
    p = root / "logs" / "health.json"
    worst = "FAIL" if any(c.status == "FAIL" for c in checks) else \
        ("WARN" if any(c.status == "WARN" for c in checks) else "OK")
    atomic_write_text(p, json.dumps({"ts": pd.Timestamp.now(tz="UTC").isoformat(), "status": worst,
                                     "checks": [asdict(c) for c in checks]}, indent=1))
    return p


def local_alert(root: Path, text: str, send: bool = False) -> None:
    """Append an alert to logs/alerts.log (always) and optionally to Telegram (only if configured)."""
    from engine.live.telegram import SendError, maybe_send, redact

    ts = pd.Timestamp.now(tz="UTC").isoformat()
    (root / "logs").mkdir(parents=True, exist_ok=True)
    with open(root / "logs" / "alerts.log", "a", encoding="utf-8") as f:
        f.write(f"[{ts}] ALERT\n{redact(text)}\n")
    if send:
        try:
            maybe_send(f"ENGINE ALERT {ts}\n{text}", True)
        except SendError as e:
            with open(root / "logs" / "alerts.log", "a", encoding="utf-8") as f:
                f.write(f"[{ts}] {e}\n")
