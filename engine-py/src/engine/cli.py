"""Command line (PAPER trading only, no real orders):

  engine download | clean | backtest [--unlock-holdout --reason "..." [--acknowledge-reuse]]
  engine live step [--send] [--version vNNN]     one hourly step for every running version
  engine live status [--version vNNN]
  engine live record-fill --version vNNN ...     log a real hand-placed fill (paper ledger untouched)
  engine version list | freeze | set-status      frozen strategy versions (config/versions/)
  engine scorecard [--version vNNN]              per-trade stats + pass/fail gate
  engine dashboard                               write reports/dashboard.html
  engine health                                  running and fresh? (exit 1 on FAIL)
  engine market update [--send]                  4-hourly market context post
  engine venue check                             Binance vs Hyperliquid daily-close cross-check
"""

from __future__ import annotations

import argparse
from typing import Any

from engine.pipeline import ROOT, load_config, run_pipeline


def _live_paths() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return load_config("live.yaml"), load_config("experiment.yaml"), load_config("universe.yaml")


def live_step(send: bool = False, now: Any = None, session: Any = None, version: Any = None) -> int:
    """One hourly PAPER step: fetch -> fill pending at next open -> funding -> mark -> risk -> decide.

    `version` (engine.track.versions.Version) supplies the frozen strategies, universe and ledger dir;
    None = the unversioned config (experiment.yaml + universe.yaml + live.yaml paper.dir)."""
    import pandas as pd
    import requests

    from engine.costs import CostModel
    from engine.live.feed import build_live_dataset
    from engine.live.paper import PaperLedger, close_prices, utcnow
    from engine.live.risk import RiskLimits, check_risk, reconcile
    from engine.live.signals_live import diff_weights, gross, latest_signal, scale_to_gross
    from engine.live.telegram import format_message, maybe_send

    live, exp, uni = _live_paths()
    paper_cfg, feed_cfg = live.get("paper", {}), live.get("feed", {})
    symbols = list(version.symbols) if version else list(uni["symbols"])
    strat_cfg = version.exp_cfg if version else exp
    paper_dir = version.paper_dir if version else paper_cfg.get("dir", "data/paper")
    limits = RiskLimits.from_config(live)
    now = utcnow() if now is None else pd.Timestamp(now)
    sess = session or requests.Session()
    feed = build_live_dataset(sess, symbols, now, root=ROOT / "data" / "cleaned",
                              history_days=int(feed_cfg.get("history_days", 200)),
                              quote=uni.get("quote", "USDT"), retries=int(feed_cfg.get("retries", 4)),
                              timeout=float(feed_cfg.get("timeout_s", 15)))
    data = feed.data
    ledger = PaperLedger(ROOT / paper_dir,
                         float(paper_cfg.get("initial_capital", exp.get("initial_capital", 100_000.0))))
    cost = CostModel.from_config(exp["costs"], base_dir=ROOT)
    fills = ledger.fill_pending(data, cost, float(paper_cfg.get("min_trade_frac", 0.001))) \
        if not feed.errors else []
    funding = ledger.accrue_funding(data)
    t = feed.last_bar
    prices = close_prices(data, t) if t is not None else {}
    equity = ledger.mark(t, prices) if t is not None else ledger.equity(prices)
    rep = check_risk(limits, equity, ledger.state.peak, ledger.day_start_equity(now), now, t,
                     feed.errors, ledger.state.killed)
    if rep.kill:
        ledger.state.killed = True
    mism = reconcile(ledger.state.qty, [f for f in ledger.read_log("fills.jsonl") if f["side"] != "funding"],
                     limits.reconcile_tolerance)
    if mism:
        rep.halt = True
        rep.reasons += [f"reconciliation: {m}" for m in mism]

    current = ledger.weights(prices)
    sig = latest_signal(strat_cfg, data) if t is not None else None
    target = sig.combined if sig else {"spot": {}, "perp": {}}
    target, k = scale_to_gross(target, limits.max_gross_leverage)
    if k < 1.0:
        rep.notes.append(f"gross leverage capped at {limits.max_gross_leverage}x (scaled x{k:.3f})")
    if rep.kill and limits.flatten_on_kill:
        target = {"spot": {}, "perp": {}}
        if t is not None:
            ledger.set_pending(t, target)
    elif rep.halt:
        target = current            # hold; no new orders this step
    elif t is not None:
        ledger.set_pending(t, target)
    changes = diff_weights(target, current, tol=1e-4)
    ledger.log_signal({
        "version": version.id if version else None, "asof": str(t), "equity": equity,
        "halt": rep.halt, "kill": rep.kill, "reasons": rep.reasons,
        "target": target, "sleeves": sig.sleeves if sig else {}, "decided_at": sig.decided_at if sig else {},
        "allocation": sig.allocation if sig else {}, "current": current, "gross": gross(target),
        "n_fills": len(fills), "funding_paid": funding,
    })
    ledger.save()
    notes = rep.reasons + rep.notes + [
        f"filled {len(fills)} order(s) at next-bar open; funding {funding:+.2f}"]
    msg = format_message(str(t), equity, target, changes, notes, sig.sleeves if sig else None,
                         version=f"{version.id} {version.name}" if version else None)
    maybe_send(msg, send)
    return 1 if rep.halt else 0


def live_step_all(send: bool = False, vid: str | None = None) -> int:
    """Hourly step for one version (--version) or every running version; unversioned if none exist."""
    from engine.track.commands import selected_versions

    versions = selected_versions(ROOT, vid)
    if not versions:
        return live_step(send=send)
    rc = 0
    for v in versions:
        try:
            rc = max(rc, live_step(send=send, version=v))
        except Exception as e:  # one broken version must not stop the others
            print(f"[{v.id}] step failed: {type(e).__name__}: {e}")
            rc = 2
        print()
    return rc


def live_status(vid: str | None = None) -> None:
    import json

    from engine.live.paper import PaperLedger
    from engine.track.commands import selected_versions

    roots = [(v.id, ROOT / v.paper_dir) for v in selected_versions(ROOT, vid)] or \
        [("default", ROOT / _live_paths()[0].get("paper", {}).get("dir", "data/paper"))]
    for name, root in roots:
        print(f"== {name}")
        if not (root / "state.json").exists():
            print(f"No paper ledger yet at {root}. Run `engine live step` first.")
            continue
        lg = PaperLedger(root)
        eq = lg.read_log("equity.jsonl")
        sig = lg.read_log("signals.jsonl")
        st = lg.state
        print(f"ledger: {root}")
        print(f"last bar: {st.last_bar}  cash: {st.cash:,.2f}  peak: {st.peak:,.2f}  killed: {st.killed}")
        if eq:
            e = eq[-1]["equity"]
            print(f"equity: {e:,.2f}  return: {e / st.initial_capital - 1:+.2%}  "
                  f"drawdown: {1 - e / st.peak if st.peak else 0:.2%}  marks: {len(eq)}")
        print("positions (qty):", json.dumps({m: p for m, p in st.qty.items() if p}))
        print("pending:", json.dumps(st.pending))
        if sig:
            last = sig[-1]
            print(f"last signal: asof {last['asof']} halt={last['halt']} reasons={last['reasons']}")


def main(argv: list[str] | None = None) -> None:
    from engine.track import commands as tc

    p = argparse.ArgumentParser(prog="engine")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("download", help="download raw history from data.binance.vision")
    sub.add_parser("clean", help="clean raw data into data/cleaned")
    bt = sub.add_parser("backtest", help="run strategies, validation and build the HTML report")
    bt.add_argument("--unlock-holdout", action="store_true", help="include locked holdout (logged)")
    bt.add_argument("--reason", default="", help="why the holdout is being unlocked")
    bt.add_argument("--acknowledge-reuse", action="store_true",
                    help="allow a holdout already viewed by OTHER rules (report stamped contaminated)")
    lv = sub.add_parser("live", help="PAPER trading (no real orders)")
    lsub = lv.add_subparsers(dest="live_cmd", required=True)
    st = lsub.add_parser("step", help="one hourly paper step: fetch, update ledger, decide, log")
    st.add_argument("--send", action="store_true", help="send Telegram message (needs env vars)")
    st.add_argument("--version", default=None, help="only this version (default: all running)")
    ls = lsub.add_parser("status", help="show paper ledger status")
    ls.add_argument("--version", default=None)
    tc.add_parsers(sub, lsub)
    a = p.parse_args(argv)

    if a.cmd in ("download", "clean"):
        from engine.data.cli_data import run_clean, run_download

        (run_download if a.cmd == "download" else run_clean)(load_config("universe.yaml"))
    elif a.cmd == "live":
        if a.live_cmd == "step":
            raise SystemExit(live_step_all(send=a.send, vid=a.version))
        if a.live_cmd == "record-fill":
            tc.record_fill_cmd(ROOT, a)
        else:
            live_status(a.version)
    elif a.cmd == "version":
        tc.version_cmd(ROOT, a, load_config("experiment.yaml"), load_config("universe.yaml"))
    elif a.cmd == "scorecard":
        tc.print_scorecard(ROOT, a.version)
    elif a.cmd == "dashboard":
        print(f"Dashboard written: {tc.dashboard_cmd(ROOT)}")
    elif a.cmd == "health":
        raise SystemExit(tc.health_cmd(ROOT))
    elif a.cmd == "market":
        tc.market_cmd(ROOT, a.send)
    elif a.cmd == "venue":
        raise SystemExit(tc.venue_cmd(ROOT, a.days, a.threshold_bps, a.version,
                                      list(load_config("universe.yaml")["symbols"])))
    else:
        path = run_pipeline(unlock_holdout=a.unlock_holdout, reason=a.reason,
                            acknowledge_reuse=a.acknowledge_reuse)
        print(f"Report written: {path}")


if __name__ == "__main__":
    main()
