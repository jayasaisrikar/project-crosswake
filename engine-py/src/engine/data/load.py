"""Load cleaned parquet files into wide panels (engine.contracts.Dataset)."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pandas as pd

from engine.contracts import MARKETS, Dataset, MarketData

FIELDS = ("open", "high", "low", "close", "volume", "quote_volume", "is_filled")


def _ts(x: str | pd.Timestamp | None) -> pd.Timestamp | None:
    if x is None:
        return None
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def _available(d: Path) -> list[str]:
    return sorted(p.stem for p in d.glob("*.parquet")) if d.exists() else []


def _load_market(d: Path, symbols: list[str], start: pd.Timestamp | None, end: pd.Timestamp | None,
                 ) -> MarketData:
    frames: dict[str, pd.DataFrame] = {}
    for sym in symbols:
        p = d / f"{sym}.parquet"
        if not p.exists():
            continue
        df = pd.read_parquet(p).set_index("ts")
        df.index = pd.DatetimeIndex(df.index).tz_convert("UTC").as_unit("ns")
        frames[sym] = df.loc[start:end]
    if frames:
        idx = frames[next(iter(frames))].index
        for df in frames.values():
            idx = idx.union(df.index)
    else:
        idx = pd.DatetimeIndex([], tz="UTC", name="ts")
    idx.name = "ts"
    panels: dict[str, pd.DataFrame] = {}
    for f in FIELDS:
        cols = {s: df[f].reindex(idx) for s, df in frames.items()}
        panel = pd.DataFrame(cols, index=idx, columns=pd.Index(symbols)).astype("float64")
        panels[f] = panel
    # is_filled: float with NaN outside listing would be ambiguous -> True where not a real bar
    panels["is_filled"] = panels["is_filled"].fillna(1.0).astype(bool)
    return MarketData(**panels)


def load_dataset(
    root: str | Path = "data/cleaned",
    symbols: Iterable[str] | None = None,
    start: str | pd.Timestamp | None = None,
    end: str | pd.Timestamp | None = None,
) -> Dataset:
    """Wide hourly panels per market; NaN before listing / after delisting.

    Columns are the requested symbols (or all found). is_filled is True where no real bar exists.
    """
    root = Path(root)
    s, e = _ts(start), _ts(end)
    if symbols is None:
        found: set[str] = set()
        for m in MARKETS:
            found.update(_available(root / "bars" / m))
        found.update(_available(root / "funding"))
        syms = sorted(found)
    else:
        syms = list(symbols)
    spot = _load_market(root / "bars" / "spot", syms, s, e)
    perp = _load_market(root / "bars" / "perp", syms, s, e)

    fund: dict[str, pd.Series] = {}
    for sym in syms:
        p = root / "funding" / f"{sym}.parquet"
        if p.exists():
            df = pd.read_parquet(p).set_index("ts")
            df.index = pd.DatetimeIndex(df.index).tz_convert("UTC").as_unit("ns")
            fund[sym] = df["rate"].loc[s:e]
    funding = pd.DataFrame(fund, columns=pd.Index(syms)).astype("float64")
    if not isinstance(funding.index, pd.DatetimeIndex):
        funding.index = pd.DatetimeIndex([], tz="UTC")
    funding.index.name = "ts"
    return Dataset(spot=spot, perp=perp, funding=funding.sort_index())
