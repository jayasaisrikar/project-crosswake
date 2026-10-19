"""Small JSONL helpers shared by the monitor and events packages."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_jsonl(p: Path) -> list[dict[str, Any]]:
    """Read a JSONL file; missing file -> []; malformed lines are skipped."""
    if not p.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def append_jsonl(p: Path, rows: list[dict[str, Any]]) -> None:
    """Append rows (never rewrites existing content)."""
    if not rows:
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, default=str, sort_keys=True) + "\n")
