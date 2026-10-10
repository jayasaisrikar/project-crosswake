"""PIT event schema + availability rule + append-only store.

Availability rule: an event is visible at decision time ``t`` only if it is backtest-eligible AND
``publication_timestamp < t`` AND ``availability_timestamp < t`` (strict). ``ingestion_timestamp`` is
recorded for audit; in live use it is also required to be < t (we cannot act on what we had not
ingested). Events without a trustworthy publication timestamp are ``backtest_ineligible``.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd

from engine.monitor._io import append_jsonl, read_jsonl

EVENTS_PATH = Path("data/events/events.jsonl")
TS_FIELDS = ("publication_timestamp", "availability_timestamp", "ingestion_timestamp")


@dataclass
class Event:
    event_id: str
    source: str
    publication_timestamp: pd.Timestamp | None
    availability_timestamp: pd.Timestamp | None
    ingestion_timestamp: pd.Timestamp
    asset: str
    event_type: str
    importance: float                 # 0..1
    novelty: float                    # 0..1 (1 = never seen similar text for this asset)
    sentiment: float                  # -1..1
    affected_assets: tuple[str, ...] = ()
    raw_text: str = ""
    processed_text: str = ""
    backtest_ineligible: bool = False
    ineligible_reason: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.publication_timestamp is None or self.availability_timestamp is None:
            self.backtest_ineligible = True
            self.ineligible_reason = self.ineligible_reason or "missing trustworthy publication timestamp"

    def to_record(self) -> dict[str, Any]:
        d = asdict(self)
        for k in TS_FIELDS:
            d[k] = None if d[k] is None else pd.Timestamp(d[k]).isoformat()
        d["affected_assets"] = list(self.affected_assets)
        return d

    @classmethod
    def from_record(cls, d: dict[str, Any]) -> Event:
        kw = dict(d)
        for k in TS_FIELDS:
            kw[k] = None if kw.get(k) in (None, "") else pd.Timestamp(kw[k])
        kw["affected_assets"] = tuple(kw.get("affected_assets") or ())
        return cls(**{k: v for k, v in kw.items() if k in cls.__dataclass_fields__})


def make_event_id(source: str, key: str) -> str:
    return hashlib.sha1(f"{source}|{key}".encode()).hexdigest()[:16]


def events_available_at(events: Iterable[Event], t: pd.Timestamp, live: bool = False) -> list[Event]:
    """Events strictly published AND available before ``t`` (and ingested before ``t`` when live)."""
    out = []
    for e in events:
        if e.backtest_ineligible or e.publication_timestamp is None or e.availability_timestamp is None:
            continue
        if e.publication_timestamp < t and e.availability_timestamp < t and (
                not live or e.ingestion_timestamp < t):
            out.append(e)
    return out


class EventStore:
    """Append-only JSONL store, deduped by event_id."""

    def __init__(self, path: Path = EVENTS_PATH) -> None:
        self.path = path

    def load(self) -> list[Event]:
        return [Event.from_record(r) for r in read_jsonl(self.path)]

    def add(self, events: Iterable[Event]) -> int:
        seen = {r.get("event_id") for r in read_jsonl(self.path)}
        rows = []
        for e in events:
            if e.event_id not in seen:
                seen.add(e.event_id)
                rows.append(e.to_record())
        append_jsonl(self.path, rows)
        return len(rows)
