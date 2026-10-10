"""Frozen strategy versions (v001, v002, ...). A version's rules never change after freezing.

Each version is one YAML file under config/versions/ holding the strategy block, the universe, the
pass/fail gate, a written hypothesis and the paper ledger directory. `params_hash` covers
strategies + symbols + gate; loading a file whose content no longer matches its hash is refused, so
an edited rule must become a new version (judged on new, unseen data). Failed versions stay listed.

live.yaml fingerprint (O16, migration note). The effective trading-relevant part of config/live.yaml
(`risk`, `paper` minus `dir`, `ensemble`) is hashed by `live_params_hash`. Versions frozen from now on
store it in `live_hash`, and `params_hash` then covers it too (a different live.yaml => refuse to run).
v001/v002 were frozen before this field existed: their `live_hash` is empty, their `params_hash` is
unchanged (the field only enters the hash when non-empty), and every signals row they write now
carries the `live_hash` actually in effect, so any live.yaml change is visible in the track record.
They also never get the ensemble layer (it can only run on a version whose pinned live_hash
includes `ensemble.enabled: true`), so enabling it requires freezing a new version.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

DEFAULT_GATE: dict[str, Any] = {
    "min_days": 90,                 # live paper days before any verdict
    "min_closed_trades": 30,        # round trips (open -> flat or flip)
    "min_profit_factor": 1.2,       # gross wins / gross losses over closed trades
    "require_ci_above_zero": True,  # 95% bootstrap CI of mean daily return > 0
    "max_drawdown": 0.25,           # fail outright if the paper drawdown exceeds this
}
STATUSES = ("live", "observe", "retired")


class VersionError(RuntimeError):
    pass


def params_hash(strategies: dict[str, Any], symbols: list[str], gate: dict[str, Any],
                live_hash: str = "") -> str:
    body: dict[str, Any] = {"strategies": strategies, "symbols": symbols, "gate": gate}
    if live_hash:                       # absent for versions frozen before O16 -> old hashes unchanged
        body["live_hash"] = live_hash
    blob = json.dumps(body, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def live_block(live_cfg: dict[str, Any]) -> dict[str, Any]:
    """The part of config/live.yaml that changes trading behaviour."""
    paper = {k: v for k, v in (live_cfg.get("paper") or {}).items() if k != "dir"}
    return {"risk": live_cfg.get("risk") or {}, "paper": paper, "ensemble": live_cfg.get("ensemble") or {}}


def live_params_hash(live_cfg: dict[str, Any]) -> str:
    blob = json.dumps(live_block(live_cfg), sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


@dataclass
class Version:
    id: str
    name: str
    hypothesis: str
    frozen_at: str
    live_start: str
    status: str
    paper_dir: str
    symbols: list[str]
    strategies: dict[str, Any]
    gate: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_GATE))
    notes: str = ""
    params_hash: str = ""
    live_hash: str = ""                     # live_params_hash at freeze time ("" = legacy, see above)
    research_model_ids: list[str] = field(default_factory=list)   # registry ids this descends from

    def check_live(self, live_cfg: dict[str, Any]) -> str:
        """Current live.yaml hash; raises VersionError if this version pinned a different one."""
        h = live_params_hash(live_cfg)
        if self.live_hash and h != self.live_hash:
            raise VersionError(f"{self.id}: config/live.yaml changed after freezing (live_hash "
                               f"{self.live_hash} != {h}); restore it or freeze a new version.")
        return h

    @property
    def exp_cfg(self) -> dict[str, Any]:
        """Shape expected by build_strategies / latest_signal."""
        return {"strategies": self.strategies}

    def to_dict(self) -> dict[str, Any]:
        d = {k: getattr(self, k) for k in self.__dataclass_fields__}
        for k in ("live_hash", "research_model_ids"):   # legacy files stay as they were frozen
            if not d[k]:
                d.pop(k)
        return d


def versions_dir(root: Path) -> Path:
    return root / "config" / "versions"


def load_version(root: Path, vid: str) -> Version:
    p = versions_dir(root) / f"{vid}.yaml"
    if not p.exists():
        raise VersionError(f"unknown version {vid!r} (no {p})")
    raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    v = Version(**raw)
    h = params_hash(v.strategies, v.symbols, v.gate, v.live_hash)
    if v.params_hash != h:
        raise VersionError(f"{vid}: rules changed after freezing (hash {v.params_hash} != {h}). "
                           "Frozen versions are immutable; freeze a new version instead.")
    if v.status not in STATUSES:
        raise VersionError(f"{vid}: status must be one of {STATUSES}")
    return v


def list_versions(root: Path) -> list[Version]:
    d = versions_dir(root)
    return [load_version(root, p.stem) for p in sorted(d.glob("v*.yaml"))] if d.exists() else []


def running_versions(root: Path) -> list[Version]:
    """Versions that take a paper step every hour (live + observe)."""
    return [v for v in list_versions(root) if v.status in ("live", "observe")]


def next_id(root: Path) -> str:
    ids = [int(v.id[1:]) for v in list_versions(root) if v.id[1:].isdigit()]
    return f"v{(max(ids) if ids else 0) + 1:03d}"


def freeze_version(root: Path, name: str, hypothesis: str, exp_cfg: dict[str, Any], symbols: list[str],
                   gate: dict[str, Any] | None = None, vid: str | None = None, status: str = "live",
                   paper_dir: str | None = None, notes: str = "", now: Any = None,
                   live_start: Any = None, live_cfg: dict[str, Any] | None = None,
                   research_model_ids: list[str] | None = None) -> Version:
    """Write config/versions/<id>.yaml with the enabled strategies of exp_cfg. Never overwrites."""
    if not hypothesis.strip():
        raise VersionError("a written hypothesis is required before freezing")
    vid = vid or next_id(root)
    path = versions_dir(root) / f"{vid}.yaml"
    if path.exists():
        raise VersionError(f"{vid} already exists; frozen versions are never overwritten")
    strategies = {k: v for k, v in exp_cfg.get("strategies", {}).items()
                  if k == "allocation" or (isinstance(v, dict) and v.get("enabled", False))}
    g = {**DEFAULT_GATE, **(gate or {})}
    ts = (pd.Timestamp(now) if now is not None else pd.Timestamp.now(tz="UTC")).tz_convert("UTC")
    v = Version(id=vid, name=name, hypothesis=hypothesis.strip(), frozen_at=ts.isoformat(),
                live_start=pd.Timestamp(live_start or ts.floor("h")).isoformat(), status=status,
                paper_dir=paper_dir or f"data/paper/{vid}", symbols=list(symbols), strategies=strategies,
                gate=g, notes=notes, live_hash=live_params_hash(live_cfg) if live_cfg is not None else "",
                research_model_ids=list(research_model_ids or []))
    v.params_hash = params_hash(v.strategies, v.symbols, v.gate, v.live_hash)
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (f"# {vid} - FROZEN {v.frozen_at}. Do not edit: the loader rejects any change "
              "(params_hash).\n# Change a rule => `engine version freeze` a NEW version.\n")
    path.write_text(header + yaml.safe_dump(v.to_dict(), sort_keys=False), encoding="utf-8")
    return v


def set_status(root: Path, vid: str, status: str, note: str = "") -> Version:
    """Status/notes are the only mutable fields (not part of the hash)."""
    if status not in STATUSES:
        raise VersionError(f"status must be one of {STATUSES}")
    v = load_version(root, vid)
    v.status = status
    if note:
        v.notes = (v.notes + "\n" if v.notes else "") + note
    p = versions_dir(root) / f"{vid}.yaml"
    head = "".join(line for line in p.read_text(encoding="utf-8").splitlines(keepends=True)
                   if line.startswith("#"))
    p.write_text(head + yaml.safe_dump(v.to_dict(), sort_keys=False), encoding="utf-8")
    return v
