"""Convert cleaned per-symbol parquet files (contracts.py layout) into PIT records.

Rules (DATA.md):
  * bars: event_time = bar open ts; publication = availability = ts + 1h (bar close).
    One row per field in BAR_FIELDS; is_filled is stored as 0.0/1.0.
  * funding: event_time = publication = availability = settlement ts (as stamped, incl. ms jitter).
Nothing is synthesized here: only rows present in data/cleaned are converted.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pandas as pd

from engine.contracts import MARKETS, Market
from engine.pit.store import PIT_COLUMNS, PITStore

BAR_FIELDS = ("open", "high", "low", "close", "volume", "quote_volume", "is_filled")
BAR_DELAY = pd.Timedelta(hours=1)
FUNDING_FIELD = "funding_rate"
FUNDING_SOURCE = "binance_funding"


def bar_source(market: Market) -> str:
    return f"binance_{market}"


def _now() -> pd.Timestamp:
    return pd.Timestamp.now(tz="UTC").floor("s")


def bars_to_pit(bars: pd.DataFrame, asset: str, market: Market,
                ingestion_time: pd.Timestamp | None = None) -> pd.DataFrame:
    """Cleaned bar frame (column ts + BAR_FIELDS) -> long PIT records."""
    ing = ingestion_time if ingestion_time is not None else _now()
    ts = pd.DatetimeIndex(bars["ts"]).tz_convert("UTC")
    fields = [f for f in BAR_FIELDS if f in bars.columns]
    parts = []
    for f in fields:
        parts.append(pd.DataFrame({
            "event_time": ts,
            "publication_time": ts + BAR_DELAY,
            "availability_time": ts + BAR_DELAY,
            "ingestion_time": ing,
            "source": bar_source(market),
            "asset": asset,
            "field": f,
            "value": bars[f].astype("float64").to_numpy(),
        }))
    if not parts:
        return pd.DataFrame(columns=list(PIT_COLUMNS))
    return pd.concat(parts, ignore_index=True)


def funding_to_pit(funding: pd.DataFrame, asset: str,
                   ingestion_time: pd.Timestamp | None = None) -> pd.DataFrame:
    """Cleaned funding frame (ts, rate) -> long PIT records (available at settlement)."""
    ing = ingestion_time if ingestion_time is not None else _now()
    ts = pd.DatetimeIndex(funding["ts"]).tz_convert("UTC")
    return pd.DataFrame({
        "event_time": ts,
        "publication_time": ts,
        "availability_time": ts,
        "ingestion_time": ing,
        "source": FUNDING_SOURCE,
        "asset": asset,
        "field": FUNDING_FIELD,
        "value": funding["rate"].astype("float64").to_numpy(),
    })


def load_cleaned_to_pit(root: str | Path = "data/cleaned", symbols: Iterable[str] | None = None,
                        markets: Iterable[Market] = MARKETS, include_funding: bool = True,
                        ingestion_time: pd.Timestamp | None = None) -> PITStore:
    """Build a PITStore from data/cleaned (bars per market + funding)."""
    root = Path(root)
    ing = ingestion_time if ingestion_time is not None else _now()
    store = PITStore()
    wanted = set(symbols) if symbols is not None else None
    for m in markets:
        d = root / "bars" / m
        for p in sorted(d.glob("*.parquet")) if d.exists() else []:
            if wanted is None or p.stem in wanted:
                store.append(bars_to_pit(pd.read_parquet(p), p.stem, m, ing))
    if include_funding:
        d = root / "funding"
        for p in sorted(d.glob("*.parquet")) if d.exists() else []:
            if wanted is None or p.stem in wanted:
                store.append(funding_to_pit(pd.read_parquet(p), p.stem, ing))
    return store
