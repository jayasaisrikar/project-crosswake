"""MODEL_LEADERBOARD: research results (experiments/exp_registry.jsonl) + live ledger + health.

Ranking is multi-criteria: the mean of per-criterion percentile ranks over OOS Sharpe, live Sharpe,
max drawdown, expectancy, calibration, cost robustness, regime robustness, parameter stability and
health score. Raw return is shown but deliberately NOT a ranking criterion. Missing values rank at
the neutral midpoint (0.5) so an unknown is never rewarded nor fatally punished.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import pandas as pd

from engine.monitor._io import read_jsonl
from engine.monitor.metrics import summarize

REGISTRY = Path("experiments/exp_registry.jsonl")

# column -> higher_is_better
CRITERIA: dict[str, bool] = {
    "oos_sharpe": True, "live_sharpe": True, "max_dd": True,  # max_dd is negative: closer to 0 better
    "expectancy": True, "calibration_ece": False, "cost_robustness": True,
    "regime_robustness": True, "param_stability": True, "health_score": True,
}
COLUMNS = ["rank", "model_id", "status", "health", "composite", "oos_sharpe", "live_sharpe", "live_return",
           "max_dd", "expectancy", "calibration_ece", "cost_robustness", "regime_robustness",
           "param_stability", "health_score", "n_live", "exp_id", "hypothesis_id", "decision"]


def _f(x: Any) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return math.nan
    return v


def canonical_model_id(r: dict[str, Any]) -> str | None:
    """One key space for research rows (O10): `model_version|hypothesis_id` (the research registry
    schema: id=EXP-..., model_version, hypothesis_id). Legacy rows with `model_id` keep it."""
    if r.get("model_version") and r.get("hypothesis_id"):
        return f"{r['model_version']}|{r['hypothesis_id']}"
    mid = r.get("model_id") or r.get("exp_id") or r.get("id")
    return str(mid) if mid else None


def live_model_id(version_id: str | None, sleeve: str) -> str:
    """Live sleeve ids are namespaced by version (`v002/sleeve.trend`); unversioned = `sleeve.trend`."""
    return f"{version_id}/sleeve.{sleeve}" if version_id else f"sleeve.{sleeve}"


def load_registry(path: Path = REGISTRY) -> dict[str, dict[str, Any]]:
    """Latest registry row per canonical model id (later lines win). Tolerates missing file/keys.
    `exp_id` is filled from the registry's `id` when absent."""
    out: dict[str, dict[str, Any]] = {}
    for r in read_jsonl(path):
        mid = canonical_model_id(r)
        if mid:
            out[mid] = {**r, "exp_id": r.get("exp_id") or r.get("id", ""), "model_id": mid}
    return out


def build(registry: dict[str, dict[str, Any]], ledger_df: pd.DataFrame,
          health: dict[str, dict[str, Any]], links: dict[str, list[str]] | None = None) -> pd.DataFrame:
    """`links` maps a live model id (e.g. `v001/sleeve.trend`) to the research ids it descends from
    (a version's `research_model_ids`); the live row then shows the first linked registry row's
    research columns."""
    links = links or {}
    ids = set(registry) | set(health) | (set(ledger_df["model_id"]) if not ledger_df.empty else set())
    rows: list[dict[str, Any]] = []
    for mid in sorted(ids):
        reg = registry.get(mid) or next((registry[x] for x in links.get(mid, []) if x in registry), {})
        res = reg.get("results") or {}
        if not isinstance(res, dict):
            res = {}
        sub = ledger_df if ledger_df.empty else ledger_df[ledger_df["model_id"] == mid]
        live = summarize(sub)
        h = health.get(mid, {})
        rows.append({
            "model_id": mid, "exp_id": reg.get("exp_id", ""), "hypothesis_id": reg.get("hypothesis_id", ""),
            "decision": reg.get("decision", ""),
            "oos_sharpe": _f(res.get("oos_sharpe")),
            "live_sharpe": live["sharpe"], "live_return": live["total_return"], "n_live": live["n"],
            "max_dd": _f(res.get("max_dd")) if not math.isnan(_f(res.get("max_dd"))) else live["max_dd"],
            "expectancy": live["expectancy"] if live["n"] else _f(res.get("expectancy")),
            "calibration_ece": live["ece"] if not math.isnan(live["ece"]) else _f(res.get("calibration_ece")),
            "cost_robustness": _f(res.get("cost_robustness")),
            "regime_robustness": _f(res.get("regime_robustness")),
            "param_stability": _f(res.get("param_stability")),
            "health_score": _f(h.get("score")),
            "health": h.get("state", "UNTRACKED"),
            "status": reg.get("status") or reg.get("decision") or h.get("state", ""),
        })
    df = pd.DataFrame(rows, columns=[c for c in COLUMNS if c != "rank" and c != "composite"])
    if df.empty:
        return pd.DataFrame(columns=COLUMNS)
    if df["max_dd"].notna().any():
        df["max_dd"] = -df["max_dd"].abs()
    ranks = []
    for c, hib in CRITERIA.items():
        ranks.append(df[c].rank(pct=True, ascending=hib).fillna(0.5))
    df["composite"] = pd.concat(ranks, axis=1).mean(axis=1).round(4)
    df = df.sort_values(["composite", "model_id"], ascending=[False, True]).reset_index(drop=True)
    df.insert(0, "rank", range(1, len(df) + 1))
    return df[COLUMNS]


def _fmt(x: Any) -> str:
    if isinstance(x, float):
        return "-" if math.isnan(x) else f"{x:.3f}"
    return str(x)


def write(df: pd.DataFrame, out_dir: Path = Path("reports")) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    csv, md = out_dir / "leaderboard.csv", out_dir / "leaderboard.md"
    df.to_csv(csv, index=False)
    lines = ["# MODEL_LEADERBOARD", "",
             "Ranked by composite = mean percentile rank over: " + ", ".join(CRITERIA)
             + ". Return is NOT a ranking criterion. Missing values count as neutral (0.5).", "",
             "| " + " | ".join(COLUMNS) + " |", "|" + "---|" * len(COLUMNS)]
    for _, r in df.iterrows():
        lines.append("| " + " | ".join(_fmt(r[c]) for c in COLUMNS) + " |")
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return md, csv
