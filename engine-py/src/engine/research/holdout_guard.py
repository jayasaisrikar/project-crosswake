"""H2 holdout guard. Research/selection may only touch data strictly before H2_START.

`open_h2(reason)` is the ONLY sanctioned way to look at H2; every call is appended to
experiments/holdout_log.jsonl (never rewritten) so the number of H2 views is auditable.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from engine.research.contract import H2_START

DEFAULT_LOG = Path("experiments/holdout_log.jsonl")
H2_TAG = "H2"


class H2Violation(RuntimeError):
    """Raised when research code touches timestamps >= H2_START."""


def _as_index(obj: Any) -> pd.DatetimeIndex:
    if isinstance(obj, pd.DatetimeIndex):
        idx = obj
    elif isinstance(obj, pd.Series | pd.DataFrame):
        idx = pd.DatetimeIndex(obj.index)
    elif isinstance(obj, pd.Timestamp):
        idx = pd.DatetimeIndex([obj])
    else:
        idx = pd.DatetimeIndex(list(obj))
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    return idx


def assert_research_window(index: Any) -> None:
    """Raise H2Violation if any timestamp in `index` (index/Series/DataFrame/iterable) >= H2_START."""
    idx = _as_index(index)
    if len(idx) and idx.max() >= H2_START:
        raise H2Violation(
            f"research data reaches {idx.max()} >= H2_START {H2_START}; H2 is sealed "
            "(use holdout_guard.open_h2(reason) for a logged final evaluation)"
        )


def research_slice(obj: Any) -> Any:
    """Return a Series/DataFrame restricted to index < H2_START."""
    idx = _as_index(obj)
    return obj.loc[idx < H2_START]


def h2_openings(log_path: str | Path = DEFAULT_LOG) -> list[dict[str, Any]]:
    p = Path(log_path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            if rec.get("holdout") == H2_TAG:
                out.append(rec)
    return out


def h2_open_count(log_path: str | Path = DEFAULT_LOG) -> int:
    """Number of times H2 has been opened (counter)."""
    return len(h2_openings(log_path))


def open_h2(reason: str, log_path: str | Path = DEFAULT_LOG) -> int:
    """Log an H2 opening (append-only) and return the new total number of H2 openings."""
    if not reason or not reason.strip():
        raise ValueError("open_h2 requires a non-empty reason")
    p = Path(log_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    n = h2_open_count(p) + 1
    rec = {
        "timestamp": datetime.now(UTC).isoformat(),
        "reason": reason.strip(),
        "holdout": H2_TAG,
        "holdout_start": H2_START.isoformat(),
        "h2_opening_number": n,
    }
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    return n
