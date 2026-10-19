"""Append-only research experiment registry (experiments/exp_registry.jsonl).

IDs are immutable and monotonic: EXP-000001, EXP-000002, ... Records are never edited or deleted;
a correction is a NEW record referencing the old id. Every trial counts toward its family's
trial count, which feeds the Deflated Sharpe Ratio.
"""

from __future__ import annotations

import hashlib
import json
import platform
import re
import subprocess
from dataclasses import dataclass, field
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

DEFAULT_PATH = Path("experiments/exp_registry.jsonl")
Decision = Literal["REJECT", "INCONCLUSIVE", "WATCH", "PROMOTE"]
DECISIONS: tuple[str, ...] = ("REJECT", "INCONCLUSIVE", "WATCH", "PROMOTE")
_ID_RE = re.compile(r"^EXP-(\d{6,})$")
_PACKAGES = ("numpy", "pandas", "scipy", "statsmodels", "arch", "pyyaml")


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def git_state() -> tuple[str | None, bool | None]:
    sha = _git("rev-parse", "HEAD")
    st = _git("status", "--porcelain")
    return sha, (bool(st) if st is not None else None)


def package_versions() -> dict[str, str]:
    out = {"python": platform.python_version()}
    for p in _PACKAGES:
        try:
            out[p] = metadata.version(p)
        except metadata.PackageNotFoundError:
            continue
    return out


def dataset_hash(obj: Any) -> str:
    """Stable content hash of a Series/DataFrame (or any JSON-able object)."""
    if isinstance(obj, pd.Series | pd.DataFrame):
        h = pd.util.hash_pandas_object(obj, index=True).to_numpy()
        blob = h.tobytes() + str(list(obj.columns) if isinstance(obj, pd.DataFrame) else [obj.name]).encode()
    else:
        blob = json.dumps(obj, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def _jsonable(v: Any) -> Any:
    if isinstance(v, np.floating | np.integer):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    if isinstance(v, float) and not np.isfinite(v):
        return None
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, list | tuple):
        return [_jsonable(x) for x in v]
    return v


@dataclass
class ExperimentRecord:
    hypothesis_id: str
    family: str
    model_version: str
    params: dict[str, Any]
    seed: int | None
    dataset_hash: str
    periods: dict[str, Any]                 # train/val/test (OOS) periods
    cost_model: dict[str, Any]
    results: dict[str, Any]
    stats: dict[str, Any]
    decision: str
    rejection_reason: str = ""
    reasons: list[str] = field(default_factory=list)
    feature_versions: dict[str, str] = field(default_factory=dict)
    notes: str = ""


class ResearchRegistry:
    def __init__(self, path: str | Path = DEFAULT_PATH) -> None:
        self.path = Path(path)

    def records(self, family: str | None = None) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        out = [json.loads(x) for x in self.path.read_text(encoding="utf-8").splitlines() if x.strip()]
        return [r for r in out if family is None or r.get("family") == family]

    def next_id(self) -> str:
        recs = self.records()
        last = 0
        for r in recs:
            m = _ID_RE.match(str(r.get("id", "")))
            if m:
                last = max(last, int(m.group(1)))
        return f"EXP-{last + 1:06d}"

    def trial_count(self, family: str) -> int:
        """Total trials ever registered in a family (all decisions count; feeds DSR)."""
        return len(self.records(family))

    def trial_sharpes(self, family: str, key: str = "sharpe_daily") -> list[float]:
        vals = []
        for r in self.records(family):
            v = (r.get("results") or {}).get(key)
            if isinstance(v, int | float) and np.isfinite(v):
                vals.append(float(v))
        return vals

    def register(self, rec: ExperimentRecord) -> str:
        if rec.decision not in DECISIONS:
            raise ValueError(f"decision must be one of {DECISIONS}")
        sha, dirty = git_state()
        exp_id = self.next_id()
        row = {
            "id": exp_id,
            "registered_at": datetime.now(UTC).isoformat(),
            "git_commit": sha,
            "git_dirty": dirty,
            "versions": package_versions(),
            **_jsonable(rec.__dict__),
        }
        row["family_trial_number"] = self.trial_count(rec.family) + 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:  # append-only, never rewritten
            f.write(json.dumps(row, sort_keys=False, default=str) + "\n")
        return exp_id

    def verify(self) -> None:
        """Raise if IDs are not strictly increasing by one (tampering / deletion)."""
        for i, r in enumerate(self.records(), start=1):
            if r.get("id") != f"EXP-{i:06d}":
                raise RuntimeError(f"registry line {i} has id {r.get('id')}, expected EXP-{i:06d}")
