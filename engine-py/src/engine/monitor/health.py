"""Model health score + state machine (ACTIVE / WARNING / REDUCED / QUARANTINED / RESEARCH).

Rules live in config/health_rules.yaml. Downgrades may jump several states at once; upgrades move one
step at a time and need ``threshold + recovery_margin``. RESEARCH is sticky: only ``reinstate`` (an
explicit human action) moves a model out of it. Models are never deleted; state history is appended to
``model_health.jsonl`` and the latest state per model is in ``model_health.json``.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from engine.monitor._io import append_jsonl, read_jsonl
from engine.monitor.metrics import resolved, summarize

STATES = ["ACTIVE", "WARNING", "REDUCED", "QUARANTINED", "RESEARCH"]
RULES_PATH = Path("config/health_rules.yaml")


def load_rules(path: Path = RULES_PATH) -> dict[str, Any]:
    return dict(yaml.safe_load(path.read_text(encoding="utf-8")))


def _lin(x: float, lo: float, hi: float) -> float:
    if math.isnan(x):
        return 0.5
    return min(1.0, max(0.0, (x - lo) / (hi - lo)))


def health_score(m: dict[str, float], rules: dict[str, Any], drift: bool = False) -> float:
    s = rules["score"]
    w = s["weights"]
    ece = m.get("ece", math.nan)
    parts = {
        "hit_rate": _lin(m.get("hit_rate", math.nan), s["hit_floor"], s["hit_target"]),
        "expectancy": _lin(m.get("expectancy", math.nan), s["exp_floor"], s["exp_target"]),
        "sharpe": _lin(m.get("sharpe", math.nan), s["sharpe_floor"], s["sharpe_target"]),
        "calibration": 0.5 if math.isnan(ece) else max(0.0, 1 - ece / s["ece_cap"]),
    }
    score = 100.0 * sum(w[k] * v for k, v in parts.items()) / sum(w.values())
    return max(0.0, score - (s["drift_penalty"] if drift else 0.0))


def target_state(score: float, rules: dict[str, Any]) -> str:
    t = rules["thresholds"]
    for st in ("ACTIVE", "WARNING", "REDUCED"):
        if score >= t[st]:
            return st
    return "QUARANTINED"


def transition(prev: str, score: float, rules: dict[str, Any], quarantine_streak: int = 0) -> str:
    """Next state given the previous one. Pure function."""
    if prev == "RESEARCH":
        return "RESEARCH"
    tgt = target_state(score, rules)
    pi, ti = STATES.index(prev), STATES.index(tgt)
    if ti > pi:  # downgrade (any size)
        nxt = tgt
    elif ti < pi:  # upgrade: one step, with hysteresis
        up = STATES[pi - 1]
        thr = rules["thresholds"].get(up, rules["thresholds"]["REDUCED"])
        nxt = up if score >= thr + rules.get("recovery_margin", 0) else prev
    else:
        nxt = prev
    limit = rules["quarantine_to_research"]
    if nxt == "QUARANTINED" and prev == "QUARANTINED" and quarantine_streak + 1 >= limit:
        return "RESEARCH"
    return nxt


class HealthBook:
    """Persistent per-model health state under ``root`` (default data/paper)."""

    def __init__(self, root: Path = Path("data/paper"), rules: dict[str, Any] | None = None) -> None:
        self.root = root
        self.rules = rules if rules is not None else load_rules()
        self.state_path = root / "model_health.json"
        self.history_path = root / "model_health.jsonl"

    def states(self) -> dict[str, dict[str, Any]]:
        if not self.state_path.exists():
            return {}
        return dict(json.loads(self.state_path.read_text(encoding="utf-8")))

    def _save(self, st: dict[str, dict[str, Any]]) -> None:
        from engine.live.journal import atomic_write_text

        atomic_write_text(self.state_path, json.dumps(st, indent=1, sort_keys=True, default=str))

    def evaluate(self, df: pd.DataFrame, now: pd.Timestamp, drifted: set[str] | None = None,
                 models: list[str] | None = None) -> dict[str, dict[str, Any]]:
        """Update every model seen in the ledger (plus ``models``). Returns the new state map."""
        st = self.states()
        drifted = drifted or set()
        r = resolved(df)
        ids = set(models or []) | set(st) | (set(df["model_id"]) if not df.empty else set())
        hist: list[dict[str, Any]] = []
        for mid in sorted(ids):
            cur = st.get(mid, {"state": "ACTIVE", "quarantine_streak": 0})
            sub = r if r.empty else r[r["model_id"] == mid].sort_values("expiry").tail(self.rules["window"])
            m = summarize(sub)
            if m["n"] < self.rules["min_samples"]:
                cur = {**cur, "score": cur.get("score"), "n": m["n"], "note": "insufficient samples"}
                st[mid] = cur
                continue
            score = health_score(m, self.rules, mid in drifted)
            prev = str(cur["state"])
            nxt = transition(prev, score, self.rules, int(cur.get("quarantine_streak", 0)))
            streak = int(cur.get("quarantine_streak", 0)) + 1 if nxt == "QUARANTINED" else 0
            new = {"state": nxt, "score": round(score, 2), "n": m["n"], "quarantine_streak": streak,
                   "updated": now.isoformat(), "size_multiplier": self.rules["size_multiplier"][nxt],
                   "note": "drift penalty" if mid in drifted else ""}
            st[mid] = new
            hist.append({"model_id": mid, "ts": now.isoformat(), "prev": prev, **new, **{
                k: m[k] for k in ("hit_rate", "expectancy", "sharpe", "ece")}})
        self._save(st)
        append_jsonl(self.history_path, hist)
        return st

    def reinstate(self, model_id: str, now: pd.Timestamp, reason: str) -> None:
        """Human action: move a RESEARCH/QUARANTINED model back to REDUCED (logged)."""
        st = self.states()
        prev = st.get(model_id, {}).get("state", "ACTIVE")
        mult = float((self.rules.get("size_multiplier") or {}).get("REDUCED", 0.4))
        st[model_id] = {**st.get(model_id, {}), "state": "REDUCED", "quarantine_streak": 0,
                        "size_multiplier": mult, "updated": now.isoformat(),
                        "note": f"reinstated: {reason}"}
        self._save(st)
        append_jsonl(self.history_path, [{"model_id": model_id, "ts": now.isoformat(), "prev": prev,
                                          "state": "REDUCED", "note": f"reinstated: {reason}"}])

    def history(self) -> list[dict[str, Any]]:
        return read_jsonl(self.history_path)
