"""Append-only prediction ledger.

* ``predictions.jsonl``: one line per prediction = ``Prediction.to_record()`` + ``signal_id`` +
  ``entry_price`` + ``logged_at``. Lines are only ever appended; a signal_id is written once.
* ``resolutions.jsonl``: one line per resolved prediction, keyed by ``signal_id``, holding the
  realized outcome. Original prediction fields are never edited.

Resolution uses the last price at or before expiry and happens only once ``now >= expiry``. That
price must be at most ``max_gap_hours`` (default 2 bars) older than expiry; otherwise the row is left
unresolved (O9: stale history must never write a permanent, wrong outcome).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

from engine.monitor._io import append_jsonl, read_jsonl
from engine.research.contract import Prediction

DEFAULT_DIR = Path("data/paper")


def signal_id(p: Prediction) -> str:
    key = f"{p.model_id}|{p.asset}|{p.timestamp.isoformat()}|{p.horizon_hours}"
    return hashlib.sha1(key.encode()).hexdigest()[:16]


@dataclass
class Ledger:
    root: Path = DEFAULT_DIR

    @property
    def predictions_path(self) -> Path:
        return self.root / "predictions.jsonl"

    @property
    def resolutions_path(self) -> Path:
        return self.root / "resolutions.jsonl"

    def predictions(self) -> list[dict[str, Any]]:
        return read_jsonl(self.predictions_path)

    def resolutions(self) -> list[dict[str, Any]]:
        return read_jsonl(self.resolutions_path)

    def append(self, preds: Iterable[Prediction], entry_prices: Mapping[str, float],
               now: pd.Timestamp | None = None, tail_bytes: int | None = None) -> list[str]:
        """Append predictions; duplicates (same signal_id) are skipped. Returns new signal_ids.

        `tail_bytes` bounds the dedup read to the end of the file (O19); safe when the predictions
        being appended are for the latest timestamp, as in the hourly step."""
        from engine.live.journal import tail_rows

        src = tail_rows(self.predictions_path, tail_bytes) if tail_bytes else self.predictions()
        seen = {r.get("signal_id") for r in src}
        logged = (now or pd.Timestamp.now(tz="UTC")).isoformat()
        rows: list[dict[str, Any]] = []
        for p in preds:
            sid = signal_id(p)
            if sid in seen:
                continue
            seen.add(sid)
            rec = p.to_record()
            rec.update(signal_id=sid, entry_price=float(entry_prices.get(p.asset, math.nan)),
                       logged_at=logged)
            rows.append(rec)
        append_jsonl(self.predictions_path, rows)
        return [r["signal_id"] for r in rows]


def _price_at(series: pd.Series, t: pd.Timestamp, max_gap_hours: float | None = None) -> float:
    s = series.dropna().sort_index()
    s = s[s.index <= t]
    if not len(s):
        return math.nan
    if max_gap_hours is not None and (t - s.index[-1]) / pd.Timedelta(hours=1) > max_gap_hours:
        return math.nan        # price too old for this timestamp: do not resolve on stale history
    return float(s.iloc[-1])


def resolve(ledger: Ledger, prices: Mapping[str, pd.Series], now: pd.Timestamp,
            max_gap_hours: float = 2.0, tail_bytes: int | None = None) -> list[dict[str, Any]]:
    """Resolve expired, unresolved predictions. Appends to resolutions.jsonl; returns the new rows.

    `tail_bytes` limits the scan to the end of both files (hourly step); the full scan is the default."""
    from engine.live.journal import tail_rows

    res = tail_rows(ledger.resolutions_path, tail_bytes) if tail_bytes else ledger.resolutions()
    preds = tail_rows(ledger.predictions_path, tail_bytes) if tail_bytes else ledger.predictions()
    done = {r.get("signal_id") for r in res}
    out: list[dict[str, Any]] = []
    for rec in preds:
        sid = rec.get("signal_id")
        if sid in done:
            continue
        expiry = pd.Timestamp(rec["expiry"])
        if now < expiry or rec.get("asset") not in prices:
            continue
        series = prices[rec["asset"]]
        entry = float(rec.get("entry_price", math.nan))
        if math.isnan(entry):
            entry = _price_at(series, pd.Timestamp(rec["timestamp"]))
        exit_px = _price_at(series, expiry, max_gap_hours)
        if math.isnan(entry) or math.isnan(exit_px) or entry <= 0:
            continue
        realized = exit_px / entry - 1.0
        direction = int(rec.get("direction", 0))
        cost = float(rec.get("expected_cost", 0.0)) if direction else 0.0
        out.append({
            "signal_id": sid,
            "model_id": rec.get("model_id"),
            "asset": rec["asset"],
            "resolved_at": now.isoformat(),
            "exit_price": exit_px,
            "entry_price_used": entry,
            "realized_return": realized,
            "signed_return": direction * realized,
            "net_return": direction * realized - cost,
            "error": realized - float(rec.get("expected_return", 0.0)),
            "hit": None if direction == 0 else bool(realized * direction > 0),
        })
        done.add(sid)
    append_jsonl(ledger.resolutions_path, out)
    return out


def joined(ledger: Ledger) -> pd.DataFrame:
    """Predictions left-joined with their resolution (unresolved rows have NaN outcomes)."""
    preds = pd.DataFrame(ledger.predictions())
    if preds.empty:
        return preds
    res = pd.DataFrame(ledger.resolutions())
    if not res.empty:
        res = res.drop(columns=[c for c in ("model_id", "asset") if c in res.columns])
        preds = preds.merge(res, on="signal_id", how="left")
    for c in ("timestamp", "expiry"):
        preds[c] = pd.to_datetime(preds[c], utc=True)
    return preds
