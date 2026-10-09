"""CLI handlers for versions, scorecard, dashboard, health, market update, venue check and manual
fills. Kept out of engine.cli so the hourly step stays short."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import pandas as pd

from engine.track.versions import Version, freeze_version, list_versions, load_version, running_versions
from engine.track.versions import set_status as _set_status


def selected_versions(root: Path, vid: str | None) -> list[Version]:
    """--version X -> [X]; else every running (live/observe) version; [] => unversioned config."""
    return [load_version(root, vid)] if vid else running_versions(root)


def _f(x: Any, pct: bool = True) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "n/a"
    return f"{x:+.2%}" if pct else f"{x:.2f}"


def print_scorecard(root: Path, vid: str | None) -> None:
    from engine.live.paper import PaperLedger
    from engine.track.scorecard import scorecard

    for v in selected_versions(root, vid):
        d = root / v.paper_dir
        print(f"== {v.id} {v.name} [{v.status}]")
        if not (d / "state.json").exists():
            print("  no paper ledger yet")
            continue
        lg = PaperLedger(d)
        sc = scorecard(lg.read_log("fills.jsonl"), lg.read_log("equity.jsonl"), lg.state.initial_capital,
                       v.gate)
        e, t, g = sc["equity"], sc["trades"], sc["gate"]
        print(f"  equity {e['last']:,.2f}  return {_f(e['total_return'])}  max DD {e['max_drawdown']:.2%}  "
              f"sharpe {_f(e['sharpe'], False)}  days {e['days']}")
        print(f"  closed trades {t['n_closed']}  win rate {_f(t['win_rate'], False)}  "
              f"avg win {_f(t['avg_win'])}  avg loss {_f(t['avg_loss'])}  "
              f"expectancy {_f(t['expectancy'])}  PF {_f(t['profit_factor'], False)}")
        print(f"  open trades {len(sc['open'])}")
        print(f"  GATE: {g['verdict']} - {g['summary']}")


def version_cmd(root: Path, a: Any, exp: dict[str, Any], uni: dict[str, Any]) -> None:
    if a.version_cmd == "list":
        for v in list_versions(root):
            print(f"{v.id}  {v.status:8s} {len(v.symbols):3d} coins  frozen {v.frozen_at[:10]}  {v.name}")
            print(f"       {v.hypothesis}")
        return
    if a.version_cmd == "set-status":
        v = _set_status(root, a.id, a.status, a.note)
        print(f"{v.id} -> {v.status}")
        return
    symbols = [s.strip().upper() for s in a.symbols.split(",")] if a.symbols else list(uni["symbols"])
    v = freeze_version(root, a.name, a.hypothesis, exp, symbols, vid=a.id, status=a.status,
                       paper_dir=a.paper_dir, notes=a.notes)
    print(f"froze {v.id} ({v.params_hash}) -> config/versions/{v.id}.yaml, ledger {v.paper_dir}")


def dashboard_cmd(root: Path) -> Path:
    from engine.track.dashboard import render_dashboard
    from engine.track.health import run_health

    vs = list_versions(root)
    return render_dashboard(root, vs, run_health(root, [v for v in vs if v.status != "retired"]),
                            root / "reports" / "dashboard.html")


def health_cmd(root: Path) -> int:
    from engine.track.health import format_health, run_health

    checks = run_health(root, running_versions(root))
    print(format_health(checks))
    return 1 if any(c.status == "FAIL" for c in checks) else 0


def market_cmd(root: Path, send: bool) -> None:
    import requests

    from engine.live.paper import PaperLedger
    from engine.live.telegram import maybe_send
    from engine.track.market import COINS, build_update

    ledgers = [(f"{v.id} {v.name}", PaperLedger(root / v.paper_dir).state.qty)
               for v in running_versions(root) if (root / v.paper_dir / "state.json").exists()]
    text, _ = build_update(requests.Session(), pd.Timestamp.now(tz="UTC"), COINS, ledgers)
    maybe_send(text, send)


def venue_cmd(root: Path, days: int, threshold: float, vid: str | None, fallback: list[str]) -> int:
    import requests

    from engine.track.venue import format_check, venue_check

    syms = sorted({s for v in selected_versions(root, vid) for s in v.symbols}) or fallback
    res = venue_check(requests.Session(), syms, pd.Timestamp.now(tz="UTC"), days, threshold)
    print(format_check(res))
    return 1 if any(r["flagged"] for r in res["symbols"].values()) else 0


def record_fill_cmd(root: Path, a: Any) -> None:
    from engine.track.manual import record_fill

    v = load_version(root, a.version)
    rec = record_fill(root / v.paper_dir, a.market, a.symbol, a.side, a.qty, a.price, a.ts, a.fee, a.note)
    print("recorded:", rec)


def add_parsers(sub: Any, live_sub: Any) -> None:
    rf = live_sub.add_parser("record-fill", help="log a real hand-placed fill next to a version's ledger")
    rf.add_argument("--version", required=True)
    rf.add_argument("--market", default="perp", choices=["spot", "perp"])
    rf.add_argument("--symbol", required=True)
    rf.add_argument("--side", required=True, choices=["buy", "sell"])
    rf.add_argument("--qty", type=float, required=True)
    rf.add_argument("--price", type=float, required=True)
    rf.add_argument("--fee", type=float, default=0.0)
    rf.add_argument("--ts", default=None, help="UTC time of the fill (default: now)")
    rf.add_argument("--note", default="")

    vr = sub.add_parser("version", help="frozen strategy versions (config/versions/)")
    vsub = vr.add_subparsers(dest="version_cmd", required=True)
    vsub.add_parser("list", help="all versions, including retired ones")
    fz = vsub.add_parser("freeze", help="freeze the enabled strategies of experiment.yaml as a new version")
    fz.add_argument("--name", required=True)
    fz.add_argument("--hypothesis", required=True, help="what this version should show, in words")
    fz.add_argument("--symbols", default=None, help="comma list (default: universe.yaml)")
    fz.add_argument("--id", default=None, help="default: next free vNNN")
    fz.add_argument("--status", default="live", choices=["live", "observe"])
    fz.add_argument("--paper-dir", default=None)
    fz.add_argument("--notes", default="")
    ss = vsub.add_parser("set-status", help="live / observe / retired (rules stay frozen)")
    ss.add_argument("id")
    ss.add_argument("status", choices=["live", "observe", "retired"])
    ss.add_argument("--note", default="")

    sc = sub.add_parser("scorecard", help="per-trade scorecard and pass/fail gate")
    sc.add_argument("--version", default=None)
    sub.add_parser("dashboard", help="write reports/dashboard.html")
    sub.add_parser("health", help="engine health checks (exit 1 on FAIL)")
    mk = sub.add_parser("market", help="market context")
    msub = mk.add_subparsers(dest="market_cmd", required=True)
    mu = msub.add_parser("update", help="4-hourly market update (prints; --send posts to Telegram)")
    mu.add_argument("--send", action="store_true")
    vn = sub.add_parser("venue", help="cross-venue price checks")
    vnsub = vn.add_subparsers(dest="venue_cmd", required=True)
    vc = vnsub.add_parser("check", help="Binance vs Hyperliquid daily closes")
    vc.add_argument("--days", type=int, default=30)
    vc.add_argument("--threshold-bps", type=float, default=50.0)
    vc.add_argument("--version", default=None)
