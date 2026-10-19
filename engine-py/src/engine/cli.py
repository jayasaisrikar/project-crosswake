"""Command line (PAPER trading only, no real orders):

  engine download | clean | backtest [--unlock-holdout --reason "..." [--acknowledge-reuse]]
  engine live step [--send] [--version vNNN]     one hourly step for every running version
  engine live status [--version vNNN]
  engine live record-fill --version vNNN ...     log a real hand-placed fill (paper ledger untouched)
  engine version list | freeze | set-status      frozen strategy versions (config/versions/)
  engine scorecard [--version vNNN]              per-trade stats + pass/fail gate
  engine dashboard                               write reports/dashboard.html
  engine health [--alert [--send]]               running and fresh? (exit 1 on FAIL; --alert logs it)
  engine live recover --reason R [--rebuild] [--adopt-host]   recovery (docs/RUNBOOK.md)
  engine live reset-kill --version vNNN --reason R [--reset-peak]
  engine market update [--send]                  4-hourly market context post
  engine venue check                             Binance vs Hyperliquid daily-close cross-check

Research engine (thin wrappers; research reads stop before H2_START unless stated):
  engine pit build [--out PATH]                  data/cleaned -> PIT record store (parquet)
  engine universe-at TS [--market perp]          point-in-time eligible universe at TS
  engine features list | compute [--ids ...]     feature registry / cached feature store (< H2)
  engine data validate                           integrity + PIT quality checks (exit 1 if not ok)
  engine research run --hypothesis H-xxxx --model MODEL_ID [--no-register]
  engine research open-h2 --reason "..."         the ONLY sanctioned H2 opening (logged)
  engine research registry                       list experiments/exp_registry.jsonl
  engine leadlag-engine | regimes                lead-lag engine / regime report (< H2)
  engine monitor resolve|drift|leaderboard|dashboard
  engine events ingest listings | --rss URL --source NAME
  `backtest --unlock-holdout` stops before H2_START; adding --open-h2 (needs --reason) reads H2, logged.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

from engine.pipeline import ROOT, load_config, run_pipeline


def _live_paths() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return load_config("live.yaml"), load_config("experiment.yaml"), load_config("universe.yaml")


# exit codes of `engine live step`: 0 ok, 1 halted (held book), 2 failed step, 3 another step running
RC_OK, RC_HALT, RC_FAIL, RC_BUSY = 0, 1, 2, 3
_REV: list[str] = []


def code_rev() -> str:
    """Release stamp for every signals row (O6): ENGINE_RELEASE env, else `git rev-parse HEAD`."""
    import os
    import subprocess

    if not _REV:
        rev = os.environ.get("ENGINE_RELEASE", "")
        if not rev:
            try:
                rev = subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], cwd=ROOT,
                                     capture_output=True, text=True, timeout=5, check=False).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                rev = ""
        _REV.append(rev or "unknown")
    return _REV[0]


class HostMismatch(RuntimeError):
    """The ledger is owned by another machine (single-writer rule)."""


def live_step(send: bool = False, now: Any = None, session: Any = None, version: Any = None,
              deadline: Any = None) -> int:
    """One hourly PAPER step: fetch -> fill pending at next open -> funding -> mark -> risk -> decide.

    `version` (engine.track.versions.Version) supplies the frozen strategies, universe and ledger dir;
    None = the unversioned config (experiment.yaml + universe.yaml + live.yaml paper.dir).

    Operational guarantees (reports/review/03_operations.md):
    * the whole step holds an exclusive lock on the ledger directory (LockBusy if another step runs);
    * a journal left by an interrupted step is rolled forward first, torn log tails are quarantined;
    * nothing is written until the end: all rows + the new state are committed as one transaction;
    * the feed is fetched before any mutation; fatal feed errors / deadline abort with nothing written;
    * a book that cannot be valued at fresh prices is never killed or flattened (held instead)."""
    import pandas as pd
    import requests

    from engine.costs import CostModel
    from engine.live.feed import build_live_dataset
    from engine.live.journal import StepLock, hostname
    from engine.live.paper import PaperLedger, fresh_prices, utcnow
    from engine.live.risk import RiskLimits, check_risk, reconcile
    from engine.live.signals_live import diff_weights, gross, latest_signal, scale_to_gross
    from engine.live.telegram import SendError, format_message, maybe_send
    from engine.track.versions import live_params_hash

    live, exp, uni = _live_paths()
    paper_cfg, feed_cfg = live.get("paper", {}), live.get("feed", {})
    symbols = list(version.symbols) if version else list(uni["symbols"])
    strat_cfg = version.exp_cfg if version else exp
    paper_dir = version.paper_dir if version else paper_cfg.get("dir", "data/paper")
    paper_root = ROOT / paper_dir
    vid = version.id if version else None
    live_hash = version.check_live(live) if version else live_params_hash(live)
    limits = RiskLimits.from_config(live)
    now = utcnow() if now is None else pd.Timestamp(now)
    sess = session or requests.Session()
    cache = feed_cfg.get("cache_dir", "data/paper/live_cache")
    with StepLock(paper_root):
        ledger = PaperLedger(paper_root,
                             float(paper_cfg.get("initial_capital", exp.get("initial_capital", 100_000.0))))
        recovered = ledger.recover()
        host = hostname()
        if ledger.state.host and ledger.state.host != host:
            raise HostMismatch(f"ledger {paper_dir} is owned by host {ledger.state.host!r}, this is "
                               f"{host!r}; see docs/RUNBOOK.md (engine live recover --adopt-host)")
        feed = build_live_dataset(sess, symbols, now, root=ROOT / "data" / "cleaned",
                                  history_days=int(feed_cfg.get("history_days", 200)),
                                  quote=uni.get("quote", "USDT"), retries=int(feed_cfg.get("retries", 4)),
                                  timeout=float(feed_cfg.get("timeout_s", 15)),
                                  cache_dir=ROOT / cache if cache else None, deadline=deadline)
        data = feed.data
        ledger.begin()                              # from here on nothing touches disk until commit()
        ledger.state.host = ledger.state.host or host
        prior_bar = pd.Timestamp(ledger.state.last_bar) if ledger.state.last_bar else None
        cost = CostModel.from_config(exp["costs"], base_dir=ROOT)
        lag = paper_cfg.get("max_fill_lag_bars", 1)
        fills = ledger.fill_pending(data, cost, float(paper_cfg.get("min_trade_frac", 0.001)),
                                    max_lag_bars=None if lag is None else int(lag)) if not feed.errors else []
        funding = ledger.accrue_funding(data)
        t = feed.last_bar
        prices, stale = ledger.valuation_prices(fresh_prices(data, t), t, limits.stale_data_hours)
        material = bool(stale) and ledger.stale_fraction(prices, stale) > limits.stale_mark_tolerance
        equity = ledger.mark(t, prices, stale=material) if t is not None else ledger.equity(prices)
        rep = check_risk(limits, equity, ledger.state.peak, ledger.day_start_equity(now), now, t,
                         feed.errors, ledger.state.killed, stale_marks=stale,
                         stale_frac=ledger.stale_fraction(prices, stale))
        if t is not None and prior_bar is not None and t < prior_bar:
            rep.halt = True
            rep.reasons.append(f"market data ends at {t}, before the last processed bar {prior_bar}")
        if rep.kill:
            ledger.state.killed = True
        trades = [f for f in ledger.read_log("fills.jsonl") if f["side"] != "funding"]
        mism = reconcile(ledger.state.qty, trades, limits.reconcile_tolerance)
        if mism:
            rep.halt = True
            rep.reasons += [f"reconciliation: {m}" for m in mism]
            rep.reasons.append("run `engine live recover` (docs/RUNBOOK.md)")

        current = ledger.weights(prices)
        sig = latest_signal(strat_cfg, data) if t is not None else None
        target = sig.combined if sig else {"spot": {}, "perp": {}}
        ens_cfg = live.get("ensemble", {}) or {}
        ens_rec: dict[str, Any] | None = None
        if ens_cfg.get("enabled", False) and sig is not None and t is not None:   # OFF by default
            if version is not None and not version.live_hash:
                rep.notes.append(f"ensemble ignored for {version.id}: frozen before live.yaml was pinned; "
                                 "freeze a new version to run it")
            else:
                from engine.live.ensemble_hook import apply_ensemble

                target, ens_rec = apply_ensemble(ens_cfg, sig, data, t, now, equity, ledger.state.peak,
                                                 rep.halt, rep.reasons, limits, cost, paper_root,
                                                 current=current, version_id=vid)
        target, k = scale_to_gross(target, limits.max_gross_leverage)
        if k < 1.0:
            rep.notes.append(f"gross leverage capped at {limits.max_gross_leverage}x (scaled x{k:.3f})")
        if rep.kill and limits.flatten_on_kill and not rep.valuation_stale:
            target = {"spot": {}, "perp": {}}
            if t is not None:
                ledger.set_pending(t, target)
        elif rep.halt or rep.kill:
            target = current            # hold; no new orders this step
        elif t is not None:
            ledger.set_pending(t, target)
        if ledger.missed:
            rep.notes.append(f"missed fill: order decided {ledger.missed['decision_ts']} cancelled "
                             f"({ledger.missed['bars_late']} bars late); decided afresh")
        changes = diff_weights(target, current, tol=1e-4)
        ledger.log_signal({
            "version": vid, "asof": str(t), "equity": equity,
            "halt": rep.halt, "kill": rep.kill, "reasons": rep.reasons,
            "target": target, "sleeves": sig.sleeves if sig else {},
            "decided_at": sig.decided_at if sig else {},
            "allocation": sig.allocation if sig else {}, "current": current, "gross": gross(target),
            "n_fills": len(fills), "funding_paid": funding, "live_hash": live_hash, "code_rev": code_rev(),
            "host": host,
            **({"stale_marks": stale} if stale else {}),
            **({"missed_fill": ledger.missed} if ledger.missed else {}),
            **({"recovered": recovered} if recovered else {}),
            **({"ensemble": ens_rec} if ens_rec is not None else {}),
        })
        ledger.commit()
        if (live.get("monitor", {}) or {}).get("log_predictions", True):
            from engine.live.ensemble_hook import log_step_predictions

            try:   # monitoring must never break the paper step
                mon = log_step_predictions(paper_root, sig, data, t, prices, version_id=vid)
                print(f"prediction ledger: {mon['predictions_logged']} logged, "
                      f"{mon['predictions_resolved']} resolved")
            except Exception as e:  # noqa: BLE001  (message content / notifications unchanged)
                print(f"prediction ledger failed: {type(e).__name__}: {e}")
    notes = rep.reasons + rep.notes + [
        f"filled {len(fills)} order(s) at next-bar open; funding {funding:+.2f}"]
    msg = format_message(str(t), equity, target, changes, notes, sig.sleeves if sig else None,
                         version=f"{version.id} {version.name}" if version else None)
    try:
        maybe_send(msg, send)
    except SendError as e:          # the step itself is committed; only the notification failed
        print(f"[{vid or 'default'}] {e}")
    return RC_HALT if rep.halt else RC_OK


def write_heartbeat(rc: int, per_version: dict[str, int], started: Any) -> None:
    """logs/heartbeat.json: last step end time + exit code (read by `engine health`)."""
    import json

    import pandas as pd

    from engine.live.journal import atomic_write_text, hostname

    atomic_write_text(ROOT / "logs" / "heartbeat.json", json.dumps({
        "ts": pd.Timestamp.now(tz="UTC").isoformat(), "started": str(started), "rc": rc,
        "versions": per_version, "host": hostname(), "code_rev": code_rev()}, indent=1))


def live_step_all(send: bool = False, vid: str | None = None) -> int:
    """Hourly step for one version (--version) or every running version; unversioned if none exist."""
    import pandas as pd
    import requests

    from engine.live.feed import Deadline, DeadlineExceeded, FatalFeedError
    from engine.live.journal import LockBusy
    from engine.live.telegram import redact
    from engine.track.commands import selected_versions
    from engine.track.health import local_alert

    started = pd.Timestamp.now(tz="UTC")
    print(f"===== step start {started.isoformat()} (UTC) rev {code_rev()}")
    live = load_config("live.yaml")
    deadline = Deadline(float((live.get("feed") or {}).get("step_deadline_s", 600)))
    sess = requests.Session()
    per: dict[str, int] = {}
    rc = RC_OK
    try:
        versions = selected_versions(ROOT, vid)
    except Exception as e:  # noqa: BLE001  (a broken version file must still leave a heartbeat)
        print(f"step failed: cannot load versions: {redact(str(e))}")
        versions, rc = [], RC_FAIL
    targets: list[Any] = list(versions) or ([None] if rc == RC_OK else [])
    for v in targets:
        name = v.id if v is not None else "default"
        try:
            per[name] = live_step(send=send, version=v, session=sess, deadline=deadline)
        except LockBusy as e:
            print(f"[{name}] skipped: {e}")
            per[name] = RC_BUSY
        except (FatalFeedError, DeadlineExceeded) as e:   # whole step aborted, nothing written
            print(f"[{name}] step aborted: {type(e).__name__}: {redact(str(e))}")
            per[name] = RC_FAIL
            for rest in targets[targets.index(v) + 1:]:
                per[rest.id if rest is not None else "default"] = RC_FAIL
            break
        except Exception as e:  # noqa: BLE001  (one broken version must not stop the others)
            print(f"[{name}] step failed: {type(e).__name__}: {redact(str(e))}")
            per[name] = RC_FAIL
        print()
    rc = max([rc, *per.values()]) if per else rc
    if rc in (RC_FAIL, RC_BUSY):
        local_alert(ROOT, f"live step rc={rc} {per}")
    write_heartbeat(rc, per, started)
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
        if (root / "journal.json").exists():
            print("journal.json present: an interrupted step will be rolled forward by the next step")
        if eq:
            e = eq[-1]["equity"]
            print(f"equity: {e:,.2f}  return: {e / st.initial_capital - 1:+.2%}  "
                  f"drawdown: {1 - e / st.peak if st.peak else 0:.2%}  marks: {len(eq)}")
        print("positions (qty):", json.dumps({m: p for m, p in st.qty.items() if p}))
        print("pending:", json.dumps(st.pending))
        if sig:
            last = sig[-1]
            print(f"last signal: asof {last['asof']} halt={last['halt']} reasons={last['reasons']}")


def live_recover(vid: str | None, reason: str, rebuild: bool = False, adopt_host: bool = False) -> int:
    """Explicit recovery (docs/RUNBOOK.md): roll forward an interrupted step, quarantine torn tails,
    report duplicate fills, optionally rebuild qty/cash from the deduplicated fill log and/or adopt
    this host. Every action is appended to <ledger>/audit.jsonl. Refused while a step holds the lock."""
    from engine.live.journal import StepLock, hostname
    from engine.live.paper import PaperLedger, duplicate_fills
    from engine.live.risk import RiskLimits, reconcile
    from engine.track.commands import selected_versions

    if not reason.strip():
        print("--reason is required")
        return 2
    tol = RiskLimits.from_config(load_config("live.yaml")).reconcile_tolerance
    roots = [(v.id, ROOT / v.paper_dir) for v in selected_versions(ROOT, vid)] or \
        [("default", ROOT / _live_paths()[0].get("paper", {}).get("dir", "data/paper"))]
    rc = 0
    for name, root in roots:
        if not (root / "state.json").exists():
            print(f"== {name}: no ledger")
            continue
        with StepLock(root):
            lg = PaperLedger(root)
            notes = lg.recover()
            fills = lg.read_log("fills.jsonl")
            dup = duplicate_fills(fills)
            mism = reconcile(lg.state.qty, fills, tol)
            act: dict[str, Any] = {"notes": notes, "duplicate_fills_ignored": dup, "mismatch_before": mism}
            if rebuild and mism:
                act["rebuild"] = lg.rebuild_from_fills()
            if adopt_host:
                act["host"] = {"from": lg.state.host, "to": hostname()}
                lg.state.host = hostname()
            if (rebuild and mism) or adopt_host:
                lg.save()
            after = reconcile(lg.state.qty, lg.read_log("fills.jsonl"), tol)
            act["mismatch_after"] = after
            lg.audit("recover", reason=reason, **act)
            print(f"== {name}: {notes or 'no journal / torn tails'}; duplicate fills ignored: {dup}; "
                  f"reconciliation {'OK' if not after else 'MISMATCH: ' + '; '.join(after[:3])}")
            rc = max(rc, 1 if after else 0)
    return rc


def live_reset_kill(vid: str, reason: str, reset_peak: bool = False) -> int:
    """Clear a latched kill switch with an audit row (instead of hand-editing state.json)."""
    from engine.live.journal import StepLock
    from engine.live.paper import PaperLedger
    from engine.track.versions import load_version

    if not reason.strip():
        print("--reason is required")
        return 2
    root = ROOT / load_version(ROOT, vid).paper_dir
    with StepLock(root):
        lg = PaperLedger(root)
        lg.recover()
        was = lg.state.killed
        lg.state.killed = False
        old_peak = lg.state.peak
        if reset_peak:          # otherwise the next step re-latches if equity is still below the limit
            marks = lg.read_log("equity.jsonl")
            if marks:
                lg.state.peak = float(marks[-1]["equity"])
        lg.save()
        lg.audit("reset-kill", reason=reason, was_killed=was, peak_before=old_peak, peak_after=lg.state.peak)
    print(f"{vid}: kill switch {'cleared' if was else 'was not set'} (logged in audit.jsonl)")
    return 0


# --------------------------------------------------------------------------- research engine wrappers
RESEARCH_CMDS = ("pit", "universe-at", "features", "data", "research", "leadlag-engine", "regimes",
                 "monitor", "events")


def _research_data(symbols: list[str] | None = None) -> Any:
    """Cleaned dataset cut strictly before H2_START (sealed holdout)."""
    from engine.data.load import load_dataset
    from engine.pipeline import h2_last_bar

    syms = symbols or list(load_config("universe.yaml")["symbols"])
    return load_dataset(str(ROOT / "data" / "cleaned"), symbols=syms, end=h2_last_bar())


def _universe() -> list[str]:
    return list(load_config("universe.yaml")["symbols"])


def pit_build(out: str) -> int:
    from engine.pit.adapters import load_cleaned_to_pit

    store = load_cleaned_to_pit(ROOT / "data" / "cleaned")
    p = ROOT / out
    p.parent.mkdir(parents=True, exist_ok=True)
    store.to_parquet(p)
    print(f"PIT store: {len(store.records)} records -> {p}")
    return 0


def universe_at_cmd(ts: str, market: str) -> int:
    from engine.pit.universe import universe_at

    u = universe_at(ts, root=ROOT / "data" / "cleaned", market=market)  # type: ignore[arg-type]
    print(f"{len(u)} eligible at {ts} ({market}): {' '.join(u)}")
    return 0


def features_cmd(action: str, ids: list[str] | None) -> int:
    import engine.features.base  # noqa: F401  (registers the feature definitions)
    from engine.features import FeatureStore, list_features

    if action == "list":
        for fd in list_features():
            print(f"{fd.feature_id:24s} v{fd.calculation_version}  lookback {fd.lookback_hours}h  "
                  f"{fd.description}")
        return 0
    out = FeatureStore(ROOT / "data" / "features").compute_all(_research_data(), ids or None)
    for fid, df in out.items():
        print(f"{fid}: {len(df)} rows")
    return 0


def data_validate() -> int:
    from engine.data.load import load_dataset
    from engine.pit.quality import validate_dataset

    rep = validate_dataset(load_dataset(str(ROOT / "data" / "cleaned"), symbols=_universe()))
    print(json.dumps(rep.to_dict(), indent=1, default=str)[:20000])
    return 0 if rep.ok else 1


def research_run(hyp_id: str, model: str, register: bool) -> int:
    from engine.costs import CostModel
    from engine.models.registry import build_model
    from engine.research.hypothesis import load_hypotheses
    from engine.research.registry import ResearchRegistry
    from engine.research.runner import ResearchDataset, run_experiment

    hyps = {h.id: h for h in load_hypotheses(ROOT / "research" / "hypotheses_seed.yaml")}
    if hyp_id not in hyps:
        print(f"unknown hypothesis {hyp_id}; known: {', '.join(sorted(hyps))}")
        return 2
    data = _research_data()
    rets = data.perp.close.pct_change(fill_method=None)
    ds = ResearchDataset(data, rets, name=f"perp_lt_H2_{len(rets.columns)}sym", market="perp")
    cm = CostModel.from_config(load_config("experiment.yaml")["costs"], base_dir=ROOT)
    res = run_experiment(hyps[hyp_id], lambda p: build_model(model, **p), ds, cm,
                         registry=ResearchRegistry(ROOT / "experiments" / "exp_registry.jsonl"),
                         register=register)
    print(f"{res.exp_id or '(not registered)'}  {hyp_id} x {model}: {res.decision}")
    return 0


def research_registry() -> int:
    from engine.research.registry import ResearchRegistry

    for r in ResearchRegistry(ROOT / "experiments" / "exp_registry.jsonl").records():
        print(f"{r.get('id')}  {r.get('hypothesis_id')}  {r.get('family')}  {r.get('model_version')}  "
              f"{r.get('decision')}  {r.get('rejection_reason') or ''}")
    return 0


def monitor_cmd(action: str, vid: str | None = None) -> int:
    """Monitor jobs per ledger: every running version (or --version), else the default paper dir.

    `resolve` uses the LIVE feed (cleaned history + bar cache + Binance) and refuses prices more than
    2 bars older than a prediction's expiry (O9), then re-scores health for that ledger (O14)."""
    import pandas as pd

    from engine.monitor.health import HealthBook, load_rules
    from engine.monitor.ledger import Ledger, joined, resolve
    from engine.track.commands import selected_versions

    now = pd.Timestamp.now(tz="UTC")
    live, _, uni = _live_paths()
    versions = selected_versions(ROOT, vid)
    targets: list[tuple[str | None, Any, list[str], list[str]]] = [
        (v.id, ROOT / v.paper_dir, list(v.symbols), list(v.research_model_ids)) for v in versions]
    if not targets:
        paper_default = ROOT / str(live.get("paper", {}).get("dir", "data/paper"))
        targets = [(None, paper_default, list(uni["symbols"]), [])]
    rules = load_rules(ROOT / "config" / "health_rules.yaml")
    if action == "resolve":   # resolve expired predictions, then re-score model health
        import requests

        from engine.live.ensemble_hook import price_series
        from engine.live.feed import build_live_dataset

        feed_cfg = live.get("feed", {}) or {}
        cache = feed_cfg.get("cache_dir", "data/paper/live_cache")
        sess = requests.Session()
        for name, paper, syms, _ in targets:
            feed = build_live_dataset(sess, syms, now, root=ROOT / "data" / "cleaned",
                                      history_days=int(feed_cfg.get("history_days", 200)),
                                      quote=uni.get("quote", "USDT"), retries=int(feed_cfg.get("retries", 4)),
                                      timeout=float(feed_cfg.get("timeout_s", 15)),
                                      cache_dir=ROOT / cache if cache else None)
            if feed.errors:
                print(f"[{name or 'default'}] feed errors, not resolving: {feed.errors[:3]}")
                continue
            led = Ledger(paper)
            rows = resolve(led, price_series(feed.data), now, max_gap_hours=2.0)
            st = HealthBook(paper, rules).evaluate(joined(led), now)
            states = {k: v.get("state") for k, v in st.items()}
            print(f"[{name or 'default'}] resolved {len(rows)} prediction(s); health: {states}")
    elif action == "drift":
        from engine.monitor.drift import error_drift, write_triggers

        for name, paper, _, _ in targets:
            ev = error_drift(joined(Ledger(paper)), now)
            new = write_triggers(ev, ROOT / "research" / "triggers.jsonl")
            print(f"[{name or 'default'}] {len(ev)} drift event(s); {len(new)} new trigger(s) "
                  "-> research/triggers.jsonl")
    elif action == "leaderboard":
        from engine.monitor.leaderboard import build, live_model_id, load_registry, write

        frames, health, links = [], {}, {}
        for name, paper, _, rids in targets:
            df = joined(Ledger(paper))
            if not df.empty:
                frames.append(df)
            health.update(HealthBook(paper, rules).states())
            if name and rids:
                for sleeve in ("trend", "carry"):
                    links[live_model_id(name, sleeve)] = rids
        led_df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["model_id"])
        lb = build(load_registry(ROOT / "experiments" / "exp_registry.jsonl"), led_df, health, links)
        print("leaderboard:", *write(lb, ROOT / "reports"))
    else:
        from engine.monitor.dashboard import build_default

        print(f"dashboard: {build_default(ROOT, now)}")
    return 0


def events_ingest(what: str | None, rss: str | None, source: str | None) -> int:
    import pandas as pd

    from engine.events.adapters import fetch_rss, from_listings
    from engine.events.schema import EventStore

    now = pd.Timestamp.now(tz="UTC")
    if what == "listings":
        evs = from_listings(ROOT / "data" / "cleaned" / "listings.json", now)
    elif rss and source:
        evs = fetch_rss(rss, source, now, universe=_universe())
    else:
        print("usage: engine events ingest listings | --rss URL --source NAME")
        return 2
    n = EventStore(ROOT / "data" / "events" / "events.jsonl").add(evs)
    print(f"{len(evs)} event(s) parsed, {n} new")
    return 0


def add_research_parsers(sub: Any) -> None:
    pit = sub.add_parser("pit", help="point-in-time store").add_subparsers(dest="pit_cmd", required=True)
    pit.add_parser("build", help="build the PIT record store from data/cleaned").add_argument(
        "--out", default="data/pit/store.parquet")
    ua = sub.add_parser("universe-at", help="PIT universe at a timestamp")
    ua.add_argument("ts")
    ua.add_argument("--market", default="perp", choices=["perp", "spot"])
    fe = sub.add_parser("features", help="feature registry / store (data < H2_START)")
    fe.add_argument("action", choices=["list", "compute"])
    fe.add_argument("--ids", nargs="*", default=None)
    dv = sub.add_parser("data", help="data checks").add_subparsers(dest="data_cmd", required=True)
    dv.add_parser("validate", help="integrity + PIT quality report (exit 1 if not ok)")
    rs = sub.add_parser("research", help="hypothesis research lab").add_subparsers(dest="res_cmd",
                                                                                     required=True)
    rr = rs.add_parser("run", help="run one hypothesis x model (data < H2_START)")
    rr.add_argument("--hypothesis", required=True)
    rr.add_argument("--model", required=True)
    rr.add_argument("--no-register", action="store_true", help="do not append to exp_registry")
    rs.add_parser("open-h2", help="log an H2 opening (append-only)").add_argument("--reason", required=True)
    rs.add_parser("registry", help="list research experiments")
    sub.add_parser("leadlag-engine", help="lead-lag engine research run (data < H2_START)")
    sub.add_parser("regimes", help="regime labels + report (data < H2_START)")
    mo = sub.add_parser("monitor", help="prediction ledger monitoring")
    mo.add_argument("action", choices=["resolve", "drift", "leaderboard", "dashboard"])
    mo.add_argument("--version", default=None, help="only this version (default: all running)")
    ev = sub.add_parser("events", help="external events").add_subparsers(dest="ev_cmd", required=True)
    ei = ev.add_parser("ingest", help="ingest events (listings file or an RSS feed)")
    ei.add_argument("what", nargs="?", choices=["listings"], default=None)
    ei.add_argument("--rss", default=None)
    ei.add_argument("--source", default=None)


def research_main(a: Any) -> int:
    if a.cmd == "pit":
        return pit_build(a.out)
    if a.cmd == "universe-at":
        return universe_at_cmd(a.ts, a.market)
    if a.cmd == "features":
        return features_cmd(a.action, a.ids)
    if a.cmd == "data":
        return data_validate()
    if a.cmd == "research":
        if a.res_cmd == "run":
            return research_run(a.hypothesis, a.model, not a.no_register)
        if a.res_cmd == "open-h2":
            from engine.research.holdout_guard import open_h2

            print(f"H2 opened (logged). Total H2 openings: "
                  f"{open_h2(a.reason, ROOT / 'experiments' / 'holdout_log.jsonl')}")
            return 0
        return research_registry()
    if a.cmd in ("leadlag-engine", "regimes"):
        import os

        os.chdir(ROOT)   # these modules use repo-relative paths (config/, reports/)
        if a.cmd == "regimes":
            from engine.regimes.report import run as run_regimes

            run_regimes(str(ROOT / "data" / "cleaned"))
        else:
            from engine.leadlag.engine import run as run_ll

            run_ll(str(ROOT / "data" / "cleaned"))
        return 0
    if a.cmd == "monitor":
        return monitor_cmd(a.action, getattr(a, "version", None))
    return events_ingest(a.what, a.rss, a.source)


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
    bt.add_argument("--open-h2", action="store_true",
                    help="with --unlock-holdout: also read the sealed H2 window (needs --reason, logged)")
    add_research_parsers(sub)
    lv = sub.add_parser("live", help="PAPER trading (no real orders)")
    lsub = lv.add_subparsers(dest="live_cmd", required=True)
    st = lsub.add_parser("step", help="one hourly paper step: fetch, update ledger, decide, log")
    st.add_argument("--send", action="store_true", help="send Telegram message (needs env vars)")
    st.add_argument("--version", default=None, help="only this version (default: all running)")
    ls = lsub.add_parser("status", help="show paper ledger status")
    ls.add_argument("--version", default=None)
    rcv = lsub.add_parser("recover", help="roll forward an interrupted step, repair torn logs, re-reconcile")
    rcv.add_argument("--version", default=None)
    rcv.add_argument("--reason", required=True)
    rcv.add_argument("--rebuild", action="store_true",
                     help="if still mismatched: rebuild qty/cash from the deduplicated fill log")
    rcv.add_argument("--adopt-host", action="store_true", help="make THIS machine the ledger owner")
    rk = lsub.add_parser("reset-kill", help="clear a latched kill switch (audited)")
    rk.add_argument("--version", required=True)
    rk.add_argument("--reason", required=True)
    rk.add_argument("--reset-peak", action="store_true", help="also reset the peak to the last equity mark")
    tc.add_parsers(sub, lsub)
    ap = sub.add_parser("app", help="build the local self-contained explainer app (HTML, no network)")
    ap.add_argument("--out", default="reports/app/index.html")
    ap.add_argument("--open", action="store_true", help="open the file in the default browser")
    a = p.parse_args(argv)

    if a.cmd in ("download", "clean"):
        from engine.data.cli_data import run_clean, run_download

        (run_download if a.cmd == "download" else run_clean)(load_config("universe.yaml"))
    elif a.cmd == "live":
        if a.live_cmd == "step":
            raise SystemExit(live_step_all(send=a.send, vid=a.version))
        if a.live_cmd == "recover":
            raise SystemExit(live_recover(a.version, a.reason, a.rebuild, a.adopt_host))
        if a.live_cmd == "reset-kill":
            raise SystemExit(live_reset_kill(a.version, a.reason, a.reset_peak))
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
        raise SystemExit(tc.health_cmd(ROOT, alert=a.alert, send=a.send))
    elif a.cmd == "market":
        tc.market_cmd(ROOT, a.send)
    elif a.cmd == "venue":
        raise SystemExit(tc.venue_cmd(ROOT, a.days, a.threshold_bps, a.version,
                                      list(load_config("universe.yaml")["symbols"])))
    elif a.cmd == "app":
        from engine.app import build

        out = build(ROOT, ROOT / a.out)
        print(f"App written: {out}")
        if a.open:
            import webbrowser

            webbrowser.open(out.resolve().as_uri())
    elif a.cmd in RESEARCH_CMDS:
        raise SystemExit(research_main(a))
    else:
        path = run_pipeline(unlock_holdout=a.unlock_holdout, reason=a.reason,
                            acknowledge_reuse=a.acknowledge_reuse, open_h2=a.open_h2)
        print(f"Report written: {path}")


if __name__ == "__main__":
    main()
