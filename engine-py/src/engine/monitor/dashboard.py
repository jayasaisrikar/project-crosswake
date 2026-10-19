"""reports/research_dashboard.html: static, self-contained, LOCAL FILE ONLY (never published/uploaded).

Sections: MARKET, SIGNALS, MODELS, PAPER TRADING, RESEARCH. Reuses the CSS tokens of the paper
dashboard (engine.track.dashboard) so both pages share one design language, incl. light/dark.
"""

from __future__ import annotations

import math
from html import escape
from pathlib import Path
from typing import Any

import pandas as pd

from engine.monitor._io import read_jsonl
from engine.monitor.metrics import by_group, summarize
from engine.track.dashboard import CSS, equity_svg


def _c(x: Any) -> str:
    if isinstance(x, float):
        return "-" if math.isnan(x) else f"{x:,.4g}"
    return escape(str(x))


def _table(df: pd.DataFrame, cols: list[str] | None = None, limit: int = 50) -> str:
    if df is None or df.empty:
        return '<p class="sub">No data yet.</p>'
    cols = [c for c in (cols or list(df.columns)) if c in df.columns]
    head = "".join(f"<th>{escape(c)}</th>" for c in cols)
    body = "".join("<tr>" + "".join(f"<td>{_c(r[c])}</td>" for c in cols) + "</tr>"
                   for _, r in df.head(limit).iterrows())
    return f'<div class="wrap"><table><tr>{head}</tr>{body}</table></div>'


def render(out: Path, *, now: pd.Timestamp, ledger_df: pd.DataFrame, leaderboard: pd.DataFrame,
           drift_events: list[dict[str, Any]], triggers: list[dict[str, Any]],
           registry: dict[str, dict[str, Any]], equity: list[dict[str, Any]], initial_capital: float,
           market: pd.DataFrame | None = None) -> Path:
    market_html = _table(market) if market is not None else ""
    market_html += "<h3>Market-structure drift</h3>" + _table(
        pd.DataFrame([d for d in drift_events if d.get("kind") == "market"]),
        ["ts", "name", "statistic", "value", "threshold"])
    sig = pd.DataFrame()
    if not ledger_df.empty:
        sig = ledger_df.sort_values("timestamp", ascending=False)
    signals_html = _table(sig, ["timestamp", "asset", "model_id", "direction", "expected_return",
                                "confidence",
                                "expected_net_edge", "regime", "reason"], limit=40)
    models_html = _table(leaderboard) + "<h3>By model and regime (live)</h3>" + _table(
        by_group(ledger_df, ["model_id", "regime"]) if not ledger_df.empty else pd.DataFrame())
    s = summarize(ledger_df) if not ledger_df.empty else summarize(pd.DataFrame())
    kpis = "".join(f'<div class="kpi"><b>{_c(v)}</b><span>{escape(k)}</span></div>' for k, v in s.items())
    eq_svg = equity_svg(equity, initial_capital)
    paper_html = f'<div class="kpis">{kpis}</div><div class="card">{eq_svg}</div>'
    decisions: dict[str, int] = {}
    for r in registry.values():
        d = str(r.get("decision", "unknown"))
        decisions[d] = decisions.get(d, 0) + 1
    research_html = (_table(pd.DataFrame([{"decision": k, "models": v} for k, v in decisions.items()]))
                     + "<h3>Research triggers</h3>"
                     + _table(pd.DataFrame(triggers), ["created", "trigger_id", "status", "reason"])
                     + "<h3>All drift events</h3>"
                     + _table(pd.DataFrame(drift_events), ["ts", "kind", "name", "statistic", "value"]))
    sections = [("MARKET", market_html), ("SIGNALS", signals_html), ("MODELS", models_html),
                ("PAPER TRADING", paper_html), ("RESEARCH", research_html)]
    body = (f'<main><h1>Research dashboard</h1><p class="sub">Generated {now:%Y-%m-%d %H:%M} UTC · '
            "local file only · PAPER ONLY · not financial advice</p>"
            + "".join(f'<h2 id="{t.lower().replace(" ", "-")}">{t}</h2>{h}' for t, h in sections) + "</main>")
    html = ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            'content="width=device-width,initial-scale=1"><title>Research Dashboard</title>'
            f"<style>{CSS}</style></head><body>{body}</body></html>")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


def build_default(root: Path = Path("."), now: pd.Timestamp | None = None) -> Path:
    """Render from standard repo paths (convenience for CLI wiring)."""
    from engine.monitor.health import HealthBook, load_rules
    from engine.monitor.leaderboard import build, load_registry
    from engine.monitor.ledger import Ledger, joined

    now = now or pd.Timestamp.now(tz="UTC")
    paper = root / "data/paper"
    df = joined(Ledger(paper))
    reg = load_registry(root / "experiments/exp_registry.jsonl")
    health = HealthBook(paper, load_rules(root / "config/health_rules.yaml")).states()
    lb = build(reg, df, health)
    trig = read_jsonl(root / "research/triggers.jsonl")
    drift = [t.get("drift", {}) for t in trig]
    return render(root / "reports/research_dashboard.html", now=now, ledger_df=df, leaderboard=lb,
                  drift_events=drift, triggers=trig, registry=reg, equity=read_jsonl(paper / "equity.jsonl"),
                  initial_capital=100000.0)
