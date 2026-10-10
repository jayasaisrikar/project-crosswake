"""Collect the app's data from files that already exist in the repo (read-only, never invents numbers).

Every section returns ``None``/empty when its inputs are missing; the page then shows a friendly empty
state naming the command that fills it. A value that was not recorded is ``None`` (never a fake 0), and
the page renders it as "not available" with the reason. Nothing here touches the network.
"""

from __future__ import annotations

import csv
import json
import logging
import math
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# Files that exist but could not be parsed during the current collect() run (review 04 #15):
# surfaced as out["unreadable"] so "unreadable" is distinguishable from "missing".
_UNREADABLE: list[str] = []

MARKET_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP"]
TAIL_DAYS = 90
DECISIONS = ["PROMOTE", "WATCH", "INCONCLUSIVE", "REJECT"]
NO_FORECAST_MSG = "not recorded: this ledger row is a target weight only (no return forecast)"


def _num(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or math.isinf(v) else v


def _jsonl(p: Path) -> list[dict[str, Any]]:
    if not p.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    return out


def _json(p: Path) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _yaml(p: Path) -> Any:
    try:
        return yaml.safe_load(p.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None


def _csv(p: Path) -> list[dict[str, str]]:
    try:
        with p.open(encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))
    except OSError:
        return []


def _mtime(p: Path) -> str | None:
    try:
        return datetime.fromtimestamp(p.stat().st_mtime, tz=UTC).isoformat(timespec="minutes")
    except OSError:
        return None


def _parquet(p: Path) -> Any:
    if not p.exists():
        return None
    try:
        import pandas as pd

        return pd.read_parquet(p)
    except (OSError, ValueError, ImportError) as e:  # pyarrow errors subclass these
        logger.warning("unreadable parquet %s: %s: %s", p, type(e).__name__, e)
        _UNREADABLE.append(f"{p.as_posix()}: {type(e).__name__}: {e}")
        return None


def _paper_dirs(root: Path) -> list[tuple[str, Path]]:
    """v001 lives in data/paper; every other config/versions/*.yaml names its own paper_dir."""
    dirs = [("v001", root / "data/paper")]
    vdir = root / "config/versions"
    for f in sorted(vdir.glob("*.yaml")) if vdir.exists() else []:
        v = _yaml(f) or {}
        if isinstance(v, dict) and v.get("id") and v.get("paper_dir") and str(v["id"]) != "v001":
            dirs.append((str(v["id"]), root / str(v["paper_dir"])))
    return dirs


# ---------------------------------------------------------------- market

def market(root: Path) -> dict[str, Any]:
    import pandas as pd

    assets = []
    for sym in MARKET_SYMBOLS:
        df = _parquet(root / f"data/cleaned/bars/perp/{sym}.parquet")
        if df is None or df.empty or "close" not in df.columns:
            continue
        df = df.sort_values("ts")
        end = df["ts"].iloc[-1]
        tail = df[df["ts"] > end - pd.Timedelta(days=TAIL_DAYS)]
        daily = tail.set_index("ts")["close"].resample("1D").last().dropna()
        r = tail["close"].astype(float).pct_change().dropna()
        vol = _num(r.tail(24 * 30).std() * math.sqrt(24 * 365)) if len(r) > 48 else None
        last = float(df["close"].iloc[-1])
        before = df[df["ts"] <= end - pd.Timedelta(days=TAIL_DAYS)]
        base_row = before.iloc[-1] if not before.empty else tail.iloc[0]
        first = float(base_row["close"])
        fund = _parquet(root / f"data/cleaned/funding/{sym}.parquet")
        fund_last = fund_apr = None
        if fund is not None and not fund.empty and "rate" in fund.columns:
            fund = fund.sort_values("ts")
            fund_last = _num(fund["rate"].iloc[-1])
            gaps = fund["ts"].diff().dt.total_seconds().dropna().tail(30)
            hours = float(gaps.median()) / 3600 if len(gaps) else 8.0
            recent = fund[fund["ts"] > fund["ts"].iloc[-1] - pd.Timedelta(days=7)]["rate"]
            fund_apr = _num(recent.mean() * (24 / max(round(hours), 1)) * 365)
        assets.append({
            "symbol": sym, "asof": str(end)[:16], "last": last, "quote": "USDT",
            "change_90d": _num(last / first - 1) if first else None,
            "change_since": str(base_row["ts"])[:16],
            "closes": [round(float(v), 6) for v in daily.tolist()],
            "dates": [str(d)[:10] for d in daily.index],
            "vol_30d": vol, "funding_last": fund_last, "funding_apr_7d": fund_apr,
        })
    regime = None
    labels = _parquet(root / "reports/regimes/labels.parquet")
    if labels is not None and not labels.empty:
        lab = labels.dropna(subset=[c for c in ("trend", "vol") if c in labels.columns])
        last_row = lab.iloc[-1]
        shares = {c: {str(k): float(v) for k, v in lab[c].value_counts(normalize=True).items()}
                  for c in ("trend", "vol") if c in lab.columns}
        regime = {"asof": str(last_row.name)[:16], "first": str(lab.index[0])[:10], "shares": shares,
                  "research_only": True,
                  **{k: (str(last_row[k]) if not isinstance(last_row[k], float) else _num(last_row[k]))
                     for k in ("trend", "vol", "funding", "correlation", "leadership", "panic")
                     if k in labels.columns}}
    return {"assets": assets, "regime": regime}


# ---------------------------------------------------------------- paper trading

def _dd_and_stats(eq: list[dict[str, Any]], initial: float) -> dict[str, Any]:
    by_ts: dict[str, float] = {}
    n_rows = 0
    for e in eq:
        v = _num(e.get("equity"))
        if v is not None and e.get("ts"):
            n_rows += 1
            by_ts[str(e["ts"])] = v  # duplicate timestamps (re-runs): keep the last write
    ts = sorted(by_ts)
    ys = [by_ts[t] for t in ts]
    peak, dds = -math.inf, []
    for y in ys:
        peak = max(peak, y)
        dds.append(y / peak - 1 if peak > 0 else 0.0)
    rets = [ys[i] / ys[i - 1] - 1 for i in range(1, len(ys)) if ys[i - 1]]
    sharpe = None
    if len(rets) >= 30:
        m = sum(rets) / len(rets)
        sd = math.sqrt(sum((r - m) ** 2 for r in rets) / (len(rets) - 1))
        sharpe = _num(m / sd * math.sqrt(24 * 365)) if sd > 0 else None
    up = sum(1 for r in rets if r > 0)
    return {
        "ts": ts, "equity": ys, "drawdown": dds,
        "total_return": (ys[-1] / initial - 1) if ys and initial else None,
        "max_drawdown": min(dds) if dds else None, "sharpe": sharpe, "n_hours": len(rets),
        "up_hours_frac": (up / len(rets)) if len(rets) >= 30 else None,  # same 30-step rule as Sharpe
        "eq_rows": n_rows, "eq_duplicates": n_rows - len(ts),
    }


def paper(root: Path) -> list[dict[str, Any]]:
    out = []
    vdir = root / "config/versions"
    names: dict[str, str] = {}
    if vdir.exists():
        for f in sorted(vdir.glob("*.yaml")):
            v = _yaml(f) or {}
            if isinstance(v, dict) and v.get("id"):
                names[str(v["id"])] = str(v.get("name", ""))
    keys = ("ts", "symbol", "side", "market", "notional", "cost", "rate")
    for vid, d in _paper_dirs(root):
        eq = _jsonl(d / "equity.jsonl")
        state = _json(d / "state.json") or {}
        if not eq and not state:
            continue
        initial = _num(state.get("initial_capital")) or 100000.0
        fills = _jsonl(d / "fills.jsonl")
        trades = [f for f in fills if str(f.get("side")) != "funding"]
        funding = [f for f in fills if str(f.get("side")) == "funding"]
        sigs = _jsonl(d / "signals.jsonl")
        last = sigs[-1] if sigs else {}
        positions = []
        for mkt, qtys in (state.get("qty") or {}).items():
            for sym, q in (qtys or {}).items():
                if _num(q):
                    positions.append({"market": mkt, "symbol": sym, "side": "long" if q > 0 else "short"})
        out.append({
            "id": vid, "name": names.get(vid, ""), "initial": initial,
            **_dd_and_stats(eq, initial),
            "n_fills": len(fills), "n_trades": len(trades), "n_funding": len(funding),
            "n_buys": sum(1 for f in trades if f.get("side") == "buy"),
            "n_sells": sum(1 for f in trades if f.get("side") == "sell"),
            "total_cost": sum(_num(f.get("cost")) or 0.0 for f in trades),
            "funding_net": sum(_num(f.get("cost")) or 0.0 for f in funding),  # >0 paid, <0 received
            "total_notional": sum(abs(_num(f.get("notional")) or 0.0) for f in trades),
            "recent_fills": [{k: f.get(k) for k in keys} for f in trades[-12:]][::-1],
            "recent_funding": [{k: f.get(k) for k in keys} for f in funding[-12:]][::-1],
            "positions": positions, "killed": bool(state.get("killed")),
            "halt": bool(last.get("halt")), "reasons": [str(r) for r in last.get("reasons") or []],
            "last_bar": state.get("last_bar") or (eq[-1].get("ts") if eq else None),
            "allocation": last.get("allocation") or {},
            "target": (last.get("target") or {}), "asof": last.get("asof"),
        })
    return out


# ---------------------------------------------------------------- signals

def has_forecast(p: dict[str, Any]) -> bool:
    """True only when a ledger row carries a real model return forecast (not a 0.0 placeholder)."""
    reason = str(p.get("reason") or "").lower()
    if "no return forecast" in reason or str(p.get("model_id") or "").startswith("sleeve."):
        return False
    vals = [_num(p.get(k)) for k in ("expected_return", "expected_cost", "expected_net_edge")]
    if all(v in (None, 0.0) for v in vals) and not p.get("model_sources"):
        return False
    return _num(p.get("expected_return")) is not None


def _pred_card(p: dict[str, Any], vid: str) -> dict[str, Any]:
    fc = has_forecast(p)
    feats = p.get("features") if isinstance(p.get("features"), dict) else {}
    return {
        "version": vid, "asset": str(p.get("asset")), "model": str(p.get("model_id")),
        "ts": str(p.get("timestamp", "")), "direction": int(_num(p.get("direction")) or 0),
        "has_forecast": fc, "weight": _num((feats or {}).get("weight")),
        "expected_return": _num(p.get("expected_return")) if fc else None,
        "expected_cost": _num(p.get("expected_cost")) if fc else None,
        "net_edge": _num(p.get("expected_net_edge")) if fc else None,
        "missing_reason": None if fc else NO_FORECAST_MSG,
        "confidence": _num(p.get("confidence")), "horizon_hours": _num(p.get("horizon_hours")),
        "reason": str(p.get("reason") or ""), "regime": str(p.get("regime") or ""),
    }


def signals(root: Path, paper_runs: list[dict[str, Any]]) -> dict[str, Any]:
    versions: list[dict[str, Any]] = []
    for vid, d in _paper_dirs(root):
        run = next((r for r in paper_runs if r["id"] == vid), None)
        preds = _jsonl(d / "predictions.jsonl")
        cards: list[dict[str, Any]] = []
        source: str | None = None
        if preds:
            latest: dict[tuple[str, str], dict[str, Any]] = {}
            for p in preds:
                latest[(str(p.get("asset")), str(p.get("model_id")))] = p
            cards = [_pred_card(p, vid) for _, p in sorted(latest.items())]
            source = "predictions"
        elif run and run.get("target"):
            source = "paper_targets"
            for mkt, w in run["target"].items():
                for sym, wt in (w or {}).items():
                    v = _num(wt) or 0.0
                    cards.append({"version": vid, "asset": sym, "model": f"paper {vid} ({mkt})",
                                  "ts": str(run.get("asof")), "has_forecast": False,
                                  "direction": (1 if v > 0 else -1 if v < 0 else 0), "weight": v,
                                  "expected_return": None, "expected_cost": None, "net_edge": None,
                                  "missing_reason": NO_FORECAST_MSG,
                                  "confidence": None, "horizon_hours": None,
                                  "reason": "; ".join(run.get("reasons") or []), "regime": ""})
        if not cards:
            continue
        cards.sort(key=lambda c: (-abs(_num(c.get("weight")) or 0.0), str(c["asset"])))
        versions.append({"id": vid, "name": run.get("name", "") if run else "", "source": source,
                         "halt": bool(run.get("halt")) if run else False, "cards": cards,
                         "n_forecasts": sum(1 for c in cards if c["has_forecast"])})
    all_cards = [c for v in versions for c in v["cards"]]
    return {"source": versions[0]["source"] if versions else None, "cards": all_cards,
            "versions": versions, "n_forecasts": sum(1 for c in all_cards if c["has_forecast"]),
            "halt": any(v["halt"] for v in versions)}


# ---------------------------------------------------------------- models

def models(root: Path) -> dict[str, Any]:
    reg = _jsonl(root / "experiments/exp_registry.jsonl")
    board = []
    for r in reg:
        res = r.get("results") or {}
        board.append({
            "id": r.get("id"), "hypothesis": r.get("hypothesis_id"), "family": r.get("family"),
            "model": r.get("model_version"), "decision": r.get("decision"),
            "reason": r.get("rejection_reason") or "", "oos_sharpe": _num(res.get("oos_sharpe")),
            "cost_stress_sharpe": _num(res.get("cost_stress_sharpe")), "dsr": _num(res.get("dsr")),
            "pbo": _num(res.get("pbo")), "n_trades": _num(res.get("n_trades")),
        })
    order = {d: i for i, d in enumerate(DECISIONS)}
    board.sort(key=lambda b: (order.get(str(b["decision"]), 9), -(_num(b["oos_sharpe"]) or -99.0)))
    health_raw: Any = _json(root / "data/paper/model_health.json") or {}
    health = [{"model": k, "state": v.get("state"), "score": _num(v.get("score")),
               "n": _num(v.get("n"))} for k, v in health_raw.items() if isinstance(v, dict)]
    pvr: list[dict[str, Any]] = []
    n_resolved_no_fc = 0
    for vid, d in _paper_dirs(root):
        res_by = {str(x.get("signal_id")): x for x in _jsonl(d / "resolutions.jsonl")}
        for p in _jsonl(d / "predictions.jsonl"):
            rz = res_by.get(str(p.get("signal_id")))
            if not rz or _num(rz.get("realized_return")) is None:
                continue
            if not has_forecast(p):
                n_resolved_no_fc += 1  # target-weight rows have no predicted move to compare
                continue
            pvr.append({"version": vid, "model": p.get("model_id"), "asset": p.get("asset"),
                        "predicted": _num(p.get("expected_return")),
                        "actual": _num(rz.get("realized_return"))})
    return {"leaderboard": board[:60], "n_experiments": len(reg), "health": health,
            "pred_vs_real": pvr[-400:], "n_resolved_no_forecast": n_resolved_no_fc}


# ---------------------------------------------------------------- research lab

def research(root: Path) -> dict[str, Any]:
    reg = _jsonl(root / "experiments/exp_registry.jsonl")
    counts = Counter(str(r.get("decision")) for r in reg if r.get("decision"))
    by_h: dict[str, list[str]] = {}
    for r in reg:
        by_h.setdefault(str(r.get("hypothesis_id")), []).append(str(r.get("decision")))
    seed = _yaml(root / "research/hypotheses_seed.yaml") or {}
    hyps = []
    for h in (seed.get("hypotheses") or []) if isinstance(seed, dict) else []:
        decs = by_h.get(str(h.get("id")), [])
        best = next((d for d in DECISIONS if d in decs), None)
        status = best or ("UNTESTED" if h.get("testable_now") else "NEEDS DATA")
        hyps.append({"id": h.get("id"), "family": h.get("family"), "statement": h.get("statement"),
                     "status": status, "n_experiments": len(decs)})
    ll_reg = {str(r.get("model_version"))[len("leadlag_engine:"):]: r for r in reg
              if str(r.get("model_version") or "").startswith("leadlag_engine:")}
    verdicts = []
    for v in _csv(root / "reports/leadlag/engine/verdicts.csv"):
        rec: dict[str, Any] = ll_reg.get(str(v.get("pair"))) or {}
        rr: dict[str, Any] = rec.get("results") or {}
        q = next((_num(val) for k, val in rr.items() if str(k).startswith("q_bh")), None)
        verdicts.append({
            "pair": v.get("pair"), "group": v.get("group"), "verdict": v.get("verdict"),
            "net_sharpe": _num(v.get("net_sharpe")), "n_trades": _num(v.get("n_trades")),
            "hit_rate": _num(v.get("hit_rate")),
            "registry_decision": rec.get("decision"),
            "registry_reason": rec.get("rejection_reason") or "",
            "registry_id": rec.get("id"), "q_bh": q, "dsr": _num(rr.get("dsr")),
            "n_pairs_tested": _num(rr.get("n_pairs_tested")),
        })
    regime_md = None
    p = root / "reports/regimes/summary.md"
    if p.exists():
        regime_md = p.read_text(encoding="utf-8", errors="replace")[:6000]
    log_path = root / "experiments/holdout_log.jsonl"
    log = _jsonl(log_path)
    try:
        from engine.research.holdout_guard import h2_open_count

        h2_opens: int | None = h2_open_count(log_path)
    except (ImportError, OSError, ValueError) as e:
        logger.warning("h2_open_count unavailable: %s: %s", type(e).__name__, e)
        h2_opens = None
    h1 = [x for x in log if x.get("holdout") != "H2"]
    h2_start = None
    try:
        from engine.research.contract import H2_START

        h2_start = H2_START.isoformat()
    except (ImportError, AttributeError) as e:
        logger.warning("H2_START unavailable: %s: %s", type(e).__name__, e)
    batch = None
    bdir = root / "reports/research/batch_001"
    if bdir.exists():
        plan = _yaml(bdir / "plan.yaml")
        pl = plan if isinstance(plan, dict) else {}
        batch = {"files": sorted(f.name for f in bdir.iterdir())[:40], "created_at": pl.get("created_at"),
                 "data_start": pl.get("data_start"), "data_end": pl.get("data_end"),
                 "h2_start": pl.get("h2_start")}
    return {
        "counts": {d: counts.get(d, 0) for d in DECISIONS}, "n_experiments": len(reg),
        "hypotheses": hyps, "verdicts": verdicts, "n_pairs": len(verdicts), "regime_summary": regime_md,
        "holdout": {"h1_views": len(h1), "h1_last_reason": (h1[-1].get("reason") if h1 else None),
                    "h1_start": (h1[-1].get("holdout_start") if h1 else None),
                    "h1_first_view": (str(h1[0].get("timestamp")) if h1 else None),
                    "h1_last_view": (str(h1[-1].get("timestamp")) if h1 else None),
                    "h1_reasons": [str(x.get("reason") or "") for x in h1][-10:],
                    "h2_opens": h2_opens, "h2_start": h2_start},
        "batch": batch,
    }


# ---------------------------------------------------------------- data health

def data_health(root: Path) -> dict[str, Any]:
    integ = _json(root / "reports/data_integrity.json")
    integrity = None
    if isinstance(integ, dict):
        uni = _yaml(root / "config/universe.yaml")
        universe = {str(x) for x in (uni.get("symbols") or [])} if isinstance(uni, dict) else set()
        checks: Counter[tuple[str, str]] = Counter()
        syms: dict[tuple[str, str], set[str]] = {}
        details: dict[tuple[str, str], str] = {}
        nbars: Counter[tuple[str, str]] = Counter()
        for i in integ.get("issues") or []:
            key = (str(i.get("check")), str(i.get("severity")))
            checks[key] += 1
            syms.setdefault(key, set()).add(str(i.get("symbol")))
            details.setdefault(key, str(i.get("detail") or ""))
            nbars[key] += int(_num(i.get("n")) or 0)
        integrity = {"ok": bool(integ.get("ok")), "counts": integ.get("counts") or {},
                     "universe_size": len(universe),
                     "by_check": [{"check": c, "severity": s, "n": n, "n_symbols": len(syms[(c, s)]),
                                   "n_bars": nbars[(c, s)], "detail": details[(c, s)],
                                   "universe_hit": sorted(syms[(c, s)] & universe)}
                                  for (c, s), n in checks.most_common(12)],
                     "updated": _mtime(root / "reports/data_integrity.json")}
    audit = _json(root / "data/cleaned/audit.json")
    coverage = None
    if isinstance(audit, dict) and isinstance(audit.get("bars"), dict):
        coverage = {}
        for mkt, syms_ in audit["bars"].items():
            if isinstance(syms_, dict):
                coverage[mkt] = dict(Counter(str((v or {}).get("status")) for v in syms_.values()))
    fresh = []
    for label, rel in [("Hourly prices (perp)", "data/cleaned/bars/perp/BTC.parquet"),
                       ("Funding rates", "data/cleaned/funding/BTC.parquet"),
                       ("Paper ledger", "data/paper/equity.jsonl"),
                       ("Prediction ledger", "data/paper/predictions.jsonl"),
                       ("Experiment registry", "experiments/exp_registry.jsonl"),
                       ("Regime labels", "reports/regimes/labels.parquet"),
                       ("Lead-lag verdicts", "reports/leadlag/engine/verdicts.csv"),
                       ("Data integrity report", "reports/data_integrity.json")]:
        f = root / rel
        fresh.append({"label": label, "path": rel, "exists": f.exists(), "updated": _mtime(f)})
    return {"integrity": integrity, "coverage": coverage, "freshness": fresh}


# ---------------------------------------------------------------- everything

def _days(a: str | None, b: str | None) -> float | None:
    try:
        ta = datetime.fromisoformat(str(a).replace(" ", "T"))
        tb = datetime.fromisoformat(str(b).replace(" ", "T"))
    except (TypeError, ValueError):
        return None
    ta = ta if ta.tzinfo else ta.replace(tzinfo=UTC)
    tb = tb if tb.tzinfo else tb.replace(tzinfo=UTC)
    return (tb - ta).total_seconds() / 86400


def _freshness(out: dict[str, Any]) -> dict[str, Any]:
    """Data end, build time and paper last step, so the page can say how old its snapshot is."""
    mk = out.get("market") or {}
    ends = [a["asof"] for a in mk.get("assets") or []]
    data_end = max(ends) if ends else None
    steps = [str(r["last_bar"]) for r in out.get("paper") or [] if r.get("last_bar")]
    gen = out["generated_at"]
    age = _days(data_end, gen)
    return {"generated_at": gen, "data_end": data_end, "paper_last_step": max(steps) if steps else None,
            "regime_asof": (mk.get("regime") or {}).get("asof"),
            "data_age_days": round(age, 1) if age is not None else None,
            "stale": bool(age is not None and age > 1)}


def collect(root: Path = Path(".")) -> dict[str, Any]:
    """Gather every section. Each section is isolated: one broken input never blanks the whole app."""
    out: dict[str, Any] = {"generated_at": datetime.now(tz=UTC).isoformat(timespec="minutes")}
    _UNREADABLE.clear()
    try:
        out["paper"] = paper(root)
    except Exception as e:  # noqa: BLE001 - section isolation: recorded in out["errors"] and logged
        logger.warning("app section paper failed: %s: %s", type(e).__name__, e)
        out["paper"], out.setdefault("errors", {})["paper"] = [], f"{type(e).__name__}: {e}"
    steps: list[tuple[str, Any]] = [
        ("market", lambda: market(root)), ("signals", lambda: signals(root, out["paper"])),
        ("models", lambda: models(root)), ("research", lambda: research(root)),
        ("data", lambda: data_health(root)),
    ]
    for key, fn in steps:
        try:
            out[key] = fn()
        except Exception as e:  # noqa: BLE001 - section isolation: recorded in out["errors"] and logged
            logger.warning("app section %s failed: %s: %s", key, type(e).__name__, e)
            out[key] = None
            out.setdefault("errors", {})[key] = f"{type(e).__name__}: {e}"
    if _UNREADABLE:
        out["unreadable"] = list(_UNREADABLE)
    out["freshness"] = _freshness(out)
    return out
