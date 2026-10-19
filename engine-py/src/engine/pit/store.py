"""Point-in-time (PIT) record store.

Every observation is one long-format row:

    event_time        when the fact refers to (bar OPEN for bars, settlement ts for funding)
    publication_time  when the source published it
    availability_time when WE may use it in a decision (>= publication_time)
    ingestion_time    when it was written into this store (audit only; historical backfills are
                      ingested "today" but were available at availability_time)
    source            e.g. "binance_perp", "binance_spot", "binance_funding"
    asset             base symbol, e.g. "BTC"
    field             e.g. "close", "funding_rate"
    value             float

A key is (source, asset, field, event_time). A key may have several revisions; `as_of(t)` keeps
only rows with availability_time <= t and, per key, the LATEST revision known at t (ordered by
availability_time, then publication_time, then ingestion_time). Revisions that become available
after t are never visible at t.

Revisions (D3): when an appended row's key ALREADY exists with a different value, it is a revision
we only learned about at ingestion, so its availability_time is raised to
max(availability_time, ingestion_time). Re-ingesting an unchanged value is a no-op (dropped).
First-time backfills keep their historical availability (that is when the source published them).
`as_of(t, strict=True)` additionally requires ingestion_time <= t (what this store actually held at
t), the right mode for replaying a live system.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pandas as pd

TIME_COLUMNS = ("event_time", "publication_time", "availability_time", "ingestion_time")
PIT_COLUMNS = (*TIME_COLUMNS, "source", "asset", "field", "value")
KEY = ["source", "asset", "field", "event_time"]
_REVISION_ORDER = ["availability_time", "publication_time", "ingestion_time"]


def _utc(t: str | pd.Timestamp) -> pd.Timestamp:
    ts = pd.Timestamp(t)
    if ts.tzinfo is None:
        raise ValueError(f"naive timestamp {t!r}: PIT times must be tz-aware UTC")
    return ts.tz_convert("UTC")


def empty_records() -> pd.DataFrame:
    df = pd.DataFrame({c: pd.Series(dtype="datetime64[ns, UTC]") for c in TIME_COLUMNS})
    for c in ("source", "asset", "field"):
        df[c] = pd.Series(dtype="object")
    df["value"] = pd.Series(dtype="float64")
    return df[list(PIT_COLUMNS)]


def validate_records(df: pd.DataFrame) -> pd.DataFrame:
    """Coerce + validate a PIT frame. Raises ValueError on schema / ordering violations."""
    missing = [c for c in PIT_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"PIT records missing columns {missing}")
    out = df[list(PIT_COLUMNS)].copy()
    for c in TIME_COLUMNS:
        s = out[c]
        if not isinstance(s.dtype, pd.DatetimeTZDtype):
            raise ValueError(f"column {c} must be tz-aware datetime (got {s.dtype})")
        out[c] = s.dt.tz_convert("UTC").astype("datetime64[ns, UTC]")
    if out[list(TIME_COLUMNS[:3])].isna().any().any():
        raise ValueError("event/publication/availability times must not be null")
    if (out["availability_time"] < out["publication_time"]).any():
        raise ValueError("availability_time precedes publication_time")
    if (out["publication_time"] < out["event_time"]).any():
        raise ValueError("publication_time precedes event_time")
    for c in ("source", "asset", "field"):
        out[c] = out[c].astype("object")
    out["value"] = out["value"].astype("float64")
    return out


class PITStore:
    """In-memory PIT table with parquet persistence."""

    def __init__(self, records: pd.DataFrame | None = None) -> None:
        self._df = empty_records() if records is None else validate_records(records)

    @property
    def records(self) -> pd.DataFrame:
        return self._df

    def __len__(self) -> int:
        return len(self._df)

    def append(self, records: pd.DataFrame) -> None:
        """Add rows (new keys or revisions). Exact duplicates and unchanged re-ingests are dropped;
        revisions of existing keys become available no earlier than their ingestion_time."""
        new = validate_records(records)
        if len(self._df) and len(new):
            new = self._as_revisions(new)
        frames = [f for f in (self._df, new) if len(f)]
        if not frames:
            return
        self._df = pd.concat(frames, ignore_index=True).drop_duplicates(ignore_index=True)

    def _as_revisions(self, new: pd.DataFrame) -> pd.DataFrame:
        old = self._df
        sub = old[old["source"].isin(new["source"].unique()) & old["asset"].isin(new["asset"].unique())
                  & old["field"].isin(new["field"].unique())]
        if sub.empty:
            return new
        latest = (sub.sort_values(_REVISION_ORDER, kind="mergesort", na_position="first")
                  .drop_duplicates(subset=KEY, keep="last")[[*KEY, "value"]]
                  .rename(columns={"value": "_prev"}))
        m = new.merge(latest, on=KEY, how="left", indicator=True)
        exists = (m["_merge"] == "both").to_numpy()
        same = exists & ((m["value"] == m["_prev"]) | (m["value"].isna() & m["_prev"].isna())).to_numpy()
        out = new.loc[~same].copy()
        rev = exists[~same]
        if rev.any():
            ing = out["ingestion_time"]
            raised = out["availability_time"].where(ing.isna() | (out["availability_time"] >= ing), ing)
            out.loc[rev, "availability_time"] = raised[rev]
        return out.reset_index(drop=True)

    @classmethod
    def from_parquet(cls, path: str | Path) -> PITStore:
        return cls(pd.read_parquet(path))

    def to_parquet(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        self._df.to_parquet(p, index=False)

    def as_of(
        self,
        t: str | pd.Timestamp,
        *,
        assets: Iterable[str] | None = None,
        fields: Iterable[str] | None = None,
        sources: Iterable[str] | None = None,
        strict: bool = False,
    ) -> pd.DataFrame:
        """Rows knowable at t: availability_time <= t, latest revision per key as known at t.

        strict=True also requires ingestion_time <= t (rows this store had not ingested at t are
        invisible): use it to replay what a live process could actually have seen.
        """
        tt = _utc(t)
        df = self._df
        m = df["availability_time"] <= tt
        if strict:
            m &= df["ingestion_time"].notna() & (df["ingestion_time"] <= tt)
        if assets is not None:
            m &= df["asset"].isin(list(assets))
        if fields is not None:
            m &= df["field"].isin(list(fields))
        if sources is not None:
            m &= df["source"].isin(list(sources))
        sub = df[m]
        if sub.empty:
            return sub.reset_index(drop=True)
        sub = sub.sort_values(_REVISION_ORDER, kind="mergesort", na_position="first")
        latest = sub.drop_duplicates(subset=KEY, keep="last")
        return latest.sort_values(["source", "asset", "field", "event_time"]).reset_index(drop=True)

    def panel(self, t: str | pd.Timestamp, field: str, source: str, strict: bool = False) -> pd.DataFrame:
        """Wide view as of t: index event_time, columns asset."""
        rows = self.as_of(t, fields=[field], sources=[source], strict=strict)
        if rows.empty:
            return pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC", name="event_time"))
        wide = rows.pivot(index="event_time", columns="asset", values="value").sort_index()
        wide.columns.name = None
        return wide
