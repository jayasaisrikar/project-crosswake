"""D3: PIT revisions are never visible before they were known; strict as_of; D9 universe cache."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from engine.pit import PITStore, bars_to_pit
from engine.pit.universe import universe_at


def _bars(filled: int) -> pd.DataFrame:
    return pd.DataFrame({"ts": [pd.Timestamp("2022-11-14 06:00", tz="UTC")], "close": [1.5],
                         "is_filled": [float(filled)]})


def test_reingested_revision_not_backdated() -> None:
    first = pd.Timestamp("2022-11-14 08:00", tz="UTC")
    later = pd.Timestamp("2026-10-10 00:00", tz="UTC")
    st = PITStore()
    st.append(bars_to_pit(_bars(0), "FTT", "perp", first))
    st.append(bars_to_pit(_bars(1), "FTT", "perp", later))       # re-clean flags the bar
    t = pd.Timestamp("2022-11-14 07:00", tz="UTC")
    v = st.as_of(t, fields=["is_filled"])
    assert v["value"].tolist() == [0.0]                           # the original value, not the revision
    assert st.as_of(later, fields=["is_filled"])["value"].tolist() == [1.0]
    # unchanged re-ingest adds nothing
    n = len(st)
    st.append(bars_to_pit(_bars(1), "FTT", "perp", later + pd.Timedelta(days=1)))
    assert len(st) == n


def test_strict_mode_requires_ingestion() -> None:
    st = PITStore()
    st.append(bars_to_pit(_bars(0), "FTT", "perp", pd.Timestamp("2026-10-10", tz="UTC")))
    t = pd.Timestamp("2022-11-14 07:00", tz="UTC")
    assert len(st.as_of(t)) == 2                                  # backfill: historical availability
    assert st.as_of(t, strict=True).empty                         # but this store did not hold it then


def test_universe_cache_sees_reclean(tmp_path: Path) -> None:
    d = tmp_path / "bars" / "perp"
    d.mkdir(parents=True)
    ts = pd.date_range("2024-01-01", periods=10, freq="h", tz="UTC")
    pd.DataFrame({"ts": ts, "is_filled": [False] * 10}).to_parquet(d / "AAA.parquet")
    t = ts[-1] + pd.Timedelta(hours=1)
    assert universe_at(t, root=tmp_path) == ["AAA"]
    pd.DataFrame({"ts": ts, "is_filled": [True] * 10}).to_parquet(d / "AAA.parquet")
    assert universe_at(t, root=tmp_path) == []
