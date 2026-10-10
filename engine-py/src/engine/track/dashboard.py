"""Self-contained local dashboard (reports/dashboard.html): one page, no server, no external assets.

Shows every strategy version (including retired ones), its pass/fail gate, equity curve, open
positions, per-trade scorecard, latest plain-words actions, manual fills and engine health.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from html import escape
from pathlib import Path
from typing import Any

from engine.live.telegram import format_actions
from engine.track.health import Check
from engine.track.manual import match_paper, read_manual
from engine.track.scorecard import scorecard
from engine.track.versions import Version

CSS = """
:root{--bg:#fbfaf7;--fg:#1d1f23;--mut:#666b73;--line:#e3e0d8;--card:#fff;--good:#1f7a4d;--bad:#b3362c;
--warn:#a5670b;--accent:#2b5fd9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141518;--fg:#e8e6e1;--mut:#9a9ea6;
--line:#2b2d33;--card:#1b1d21;--good:#5cc28d;--bad:#ec7a6f;--warn:#e0a84a;--accent:#7aa2ff}}
:root[data-theme="dark"]{--bg:#141518;--fg:#e8e6e1;--mut:#9a9ea6;--line:#2b2d33;--card:#1b1d21;--good:#5cc28d;
--bad:#ec7a6f;--warn:#e0a84a;--accent:#7aa2ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 16px 80px}h1{font-size:26px;margin:0 0 4px}
h2{font-size:20px;margin:36px 0 8px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:15px;margin:18px 0 6px;color:var(--mut);font-weight:600}.sub{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.kpi b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.kpi span{color:var(--mut);font-size:12px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--mut);font-weight:600}
.g{color:var(--good)}.b{color:var(--bad)}.w{color:var(--warn)}
.pill{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid}
.PASS,.OK{color:var(--good)}.FAIL{color:var(--bad)}.PENDING,.WARN{color:var(--warn)}
pre{white-space:pre-wrap;font-size:13px;margin:0}svg{display:block;width:100%;height:auto}
svg text{fill:var(--mut);font-size:11px}
"""


def _pct(x: Any, d: int = 1) -> str:
    return "—" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:+.{d}%}"


def _num(x: Any, d: int = 2) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return "∞" if isinstance(x, float) and math.isinf(x) else f"{x:,.{d}f}"


def _cls(x: Any) -> str:
    return "" if not isinstance(x, int | float) or math.isnan(x) else ("g" if x > 0 else "b" if x < 0 else "")


def equity_svg(equity: list[dict[str, Any]], initial: float, w: int = 960, h: int = 200) -> str:
    if len(equity) < 2:
        return '<p class="sub">Equity curve appears after a few hourly steps.</p>'
    ys = [float(e["equity"]) for e in equity]
    lo, hi = min(ys + [initial]), max(ys + [initial])
    span = (hi - lo) or 1.0
    px, py = 50, 14

    def X(i: int) -> float:
        return px + i * (w - px - 8) / (len(ys) - 1)

    def Y(v: float) -> float:
        return py + (hi - v) / span * (h - 2 * py)

    pts = " ".join(f"{X(i):.1f},{Y(v):.1f}" for i, v in enumerate(ys))
    base = Y(initial)
    return (f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="paper equity curve">'
            f'<line x1="{px}" x2="{w - 8}" y1="{base:.1f}" y2="{base:.1f}" stroke="var(--line)" '
            f'stroke-dasharray="4 4"/><polyline points="{pts}" fill="none" stroke="var(--accent)" '
            f'stroke-width="2"/><text x="4" y="{Y(hi) + 4:.0f}">{hi:,.0f}</text>'
            f'<text x="4" y="{Y(lo):.0f}">{lo:,.0f}</text>'
            f'<text x="{px}" y="{h - 1}">{escape(str(equity[0]["ts"])[:16])}</text>'
            f'<text x="{w - 8}" y="{h - 1}" text-anchor="end">'
            f'{escape(str(equity[-1]["ts"])[:16])}</text></svg>')


def _read(p: Path) -> list[dict[str, Any]]:
    """Read-only, tolerant: a torn last line is skipped (repair is the step's / recover's job)."""
    from engine.live.journal import read_rows

    return read_rows(p, repair=False)[0]


def _table(headers: list[str], rows: list[list[str]]) -> str:
    th = "".join(f"<th>{h}</th>" for h in headers)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="wrap"><table><tr>{th}</tr>{trs}</table></div>'


def _span(cls: str, text: str) -> str:
    return f'<span class="{cls}">{text}</span>'


def _kpis(eq: dict[str, Any], tr: dict[str, Any]) -> str:
    wr = "—" if math.isnan(tr["win_rate"]) else f"{tr['win_rate']:.0%}"
    kp = [("Paper equity", _num(eq["last"], 0), ""),
          ("Return", _pct(eq["total_return"], 2), _cls(eq["total_return"])),
          ("Max drawdown", _pct(-eq["max_drawdown"]), "b" if eq["max_drawdown"] else ""),
          ("Sharpe (daily)", _num(eq["sharpe"]), ""), ("Closed trades", str(tr["n_closed"]), ""),
          ("Win rate", wr, ""), ("Profit factor", _num(tr["profit_factor"]), ""),
          ("Live days", str(eq["days"]), "")]
    cells = "".join(f'<div class="kpi"><span>{k}</span><b class="{c}">{val}</b></div>' for k, val, c in kp)
    return f'<div class="kpis">{cells}</div>'


def _gate(g: dict[str, Any]) -> str:
    rows = [[escape(c["check"]), _num(c["value"], 4) if isinstance(c["value"], float) else str(c["value"]),
             escape(c["need"]), _span("OK" if c["ok"] else "WARN", "✓" if c["ok"] else "·")]
            for c in g["checks"]]
    return (f'<div class="card"><b>Gate: {_span(g["verdict"], g["verdict"])}</b> — {escape(g["summary"])}'
            + _table(["Check", "Value", "Needs", ""], rows) + "</div>")


def _actions(last: dict[str, Any]) -> str:
    tgt, cur = last.get("target", {}), last.get("current", {})
    changes = [{"market": m, "symbol": s, "current": cur.get(m, {}).get(s, 0.0),
                "target": tgt.get(m, {}).get(s, 0.0)}
               for m in ("spot", "perp") for s in sorted(set(tgt.get(m, {})) | set(cur.get(m, {})))]
    acts = format_actions(changes)
    text = "\n".join(acts) if acts else "  nothing - hold positions"
    if last.get("halt"):
        text += "\n\nHALTED: " + "; ".join(last.get("reasons", []))
    return (f'<h3>Latest decision · bar {escape(str(last.get("asof", "—")))}</h3>'
            f'<div class="card"><pre>{escape(text)}</pre></div>')


def _open_positions(opens: list[dict[str, Any]]) -> str:
    if not opens:
        return '<h3>Open positions</h3><p class="sub">Flat.</p>'
    rows = [[f'{escape(t["symbol"])} <span class="sub">{t["market"]}</span>', t["side"],
             escape(t["opened"][:16]), _num(t["entry_price"], 4), _num(abs(t["qty"] * t["entry_price"]), 0),
             _num(t["costs"] + t["funding"])] for t in sorted(opens, key=lambda t: -t["max_notional"])]
    return "<h3>Open positions</h3>" + _table(
        ["Coin", "Side", "Since", "Avg entry", "Notional", "Costs+funding"], rows)


def _closed_trades(closed: list[dict[str, Any]]) -> str:
    if not closed:
        return ('<h3>Closed trades</h3><p class="sub">No round trip has closed yet. '
                'Trend trades usually last weeks.</p>')
    rows = [[escape(t["symbol"]), t["side"], escape(t["opened"][:16]), escape(str(t["closed"])[:16]),
             _num(t["entry_price"], 4), _num(t["exit_price"], 4), _span(_cls(t["pnl"]), _num(t["pnl"])),
             _span(_cls(t["ret"]), _pct(t["ret"], 2))] for t in closed[-50:][::-1]]
    return "<h3>Closed trades (latest 50)</h3>" + _table(
        ["Coin", "Side", "Opened", "Closed", "Entry", "Exit", "Net PnL", "Return"], rows)


def _manual(man: list[dict[str, Any]]) -> str:
    if not man:
        return ""
    rows = [[escape(m["ts"][:16]), escape(m["symbol"]), m["side"], _num(m["qty"], 4), _num(m["price"], 4),
             _num(m["paper_price"], 4),
             "—" if m["slippage_bps"] is None else f'{m["slippage_bps"]:+.1f} bps'] for m in man[::-1]]
    return "<h3>Manual fills vs paper</h3>" + _table(
        ["Time", "Coin", "Side", "Qty", "Your price", "Paper price", "Slippage"], rows)


def version_section(root: Path, v: Version) -> str:
    d = root / v.paper_dir
    head = (f'<h2 id="{v.id}">{escape(v.id)} · {escape(v.name)} '
            f'<span class="pill sub">{escape(v.status)}</span></h2>'
            f'<p class="sub">{escape(v.hypothesis)}<br>Frozen {escape(v.frozen_at[:16])} UTC · '
            f'{len(v.symbols)} coins · hash <code>{escape(v.params_hash)}</code></p>')
    if not (d / "state.json").exists():
        return head + '<div class="card sub">No paper ledger yet — run <code>engine live step</code>.</div>'
    st = json.loads((d / "state.json").read_text(encoding="utf-8"))
    fills, equity, signals = _read(d / "fills.jsonl"), _read(d / "equity.jsonl"), _read(d / "signals.jsonl")
    sc = scorecard(fills, equity, float(st["initial_capital"]), v.gate)
    curve = f'<h3>Paper equity</h3><div class="card">{equity_svg(equity, st["initial_capital"])}</div>'
    return (head + _kpis(sc["equity"], sc["trades"]) + _gate(sc["gate"]) + curve
            + _actions(signals[-1] if signals else {}) + _open_positions(sc["open"])
            + _closed_trades(sc["closed"]) + _manual(match_paper(read_manual(d), fills)))


def render_dashboard(root: Path, versions: list[Version], health: list[Check], out: Path) -> Path:
    vrows = [[f'<a href="#{v.id}">{escape(v.id)}</a>', escape(v.name), escape(v.status), str(len(v.symbols)),
              escape(v.live_start[:10])] for v in versions]
    hrows = [[escape(c.name), _span(c.status, c.status), escape(c.detail)] for c in health]
    body = (f'<main><h1>Paper trading dashboard</h1><p class="sub">Generated '
            f'{datetime.now(UTC):%Y-%m-%d %H:%M} UTC · PAPER ONLY, no real orders · not financial advice'
            f' · refresh with <code>uv run engine dashboard</code></p>'
            "<h2>Strategy versions</h2>" + _table(["Version", "Name", "Status", "Coins", "Live since"], vrows)
            + "<h2>Engine health</h2>" + _table(["Check", "Status", "Detail"], hrows)
            + "".join(version_section(root, v) for v in versions if v.status != "retired")
            + "</main>")
    html = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            'content="width=device-width,initial-scale=1"><title>Paper Trading Dashboard</title>'
            f'<style>{CSS}</style></head><body>{body}</body></html>')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out
