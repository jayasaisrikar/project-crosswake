"""Hypothesis dataclass + loader for research/hypotheses_seed.yaml (file may be absent)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_PATH = Path("research/hypotheses_seed.yaml")


def _tup(v: Any) -> tuple[str, ...]:
    if v is None:
        return ()
    if isinstance(v, str):
        return (v,)
    if isinstance(v, dict):
        return tuple(f"{k}: {x}" for k, x in v.items())
    return tuple(str(x) for x in v)


@dataclass(frozen=True)
class Hypothesis:
    id: str
    statement: str = ""
    family: str = "default"
    research_ids: tuple[str, ...] = ()
    features: tuple[str, ...] = ()
    target: str = ""
    conditions: tuple[str, ...] = ()
    data_required: tuple[str, ...] = ()
    testable_now: bool = False
    params: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Hypothesis:
        if "id" not in d:
            raise ValueError(f"hypothesis without id: {d}")
        target = d.get("target", "")
        return cls(
            id=str(d["id"]),
            statement=str(d.get("statement", "") or ""),
            family=str(d.get("family", "default") or "default"),
            research_ids=_tup(d.get("research_ids")),
            features=_tup(d.get("features")),
            target=str(target) if target is not None else "",
            conditions=_tup(d.get("conditions")),
            data_required=_tup(d.get("data_required")),
            testable_now=bool(d.get("testable_now", False)),
            params=dict(d.get("params") or {}),
        )


def load_hypotheses(path: str | Path = DEFAULT_PATH) -> list[Hypothesis]:
    """Load hypotheses; [] when the file is absent/empty. Accepts a top-level list or a mapping
    with a `hypotheses` list."""
    p = Path(path)
    if not p.exists():
        return []
    raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    if raw is None:
        return []
    items = raw.get("hypotheses", []) if isinstance(raw, dict) else raw
    return [Hypothesis.from_dict(x) for x in items or [] if isinstance(x, dict)]
