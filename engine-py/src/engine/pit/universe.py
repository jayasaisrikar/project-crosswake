"""Point-in-time universe membership: `universe_at(t)`.

An asset is eligible at decision time t iff
  1. it is in the candidate set (data/cleaned/listings.json symbols that have cleaned bars, or all
     cleaned bar files when listings.json is absent),
  2. its listing month (listings.json first_month) has started by t,
  3. its FIRST real (is_filled False) bar was available by t (availability = bar open + 1h), and
  4. it had a real bar available within the last `stale_hours` before t, i.e.
     t - stale_hours < last_real_availability_before_or_at_t <= t.

Rule 4 retains delisted assets (LUNA, FTT, ...) up to their delisting and drops them once their
last real bar is older than `stale_hours`. It uses only bars available by t, so it is causal and
never depends on today's survivor list.

`ranked_universe_at` additionally applies engine.universe.pit_universe_mask (top-N by trailing
ADV) on data truncated to the last bar closed by t.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path

import pandas as pd

from engine.contracts import Market, MarketData
from engine.pit.adapters import BAR_DELAY
from engine.universe import pit_universe_mask

DEFAULT_STALE_HOURS = 72


def _utc(t: str | pd.Timestamp) -> pd.Timestamp:
    ts = pd.Timestamp(t)
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


def eligible_at(
    t: str | pd.Timestamp,
    real_bar_opens: Mapping[str, pd.DatetimeIndex],
    first_listed: Mapping[str, pd.Timestamp] | None = None,
    stale_hours: int = DEFAULT_STALE_HOURS,
) -> list[str]:
    """Pure core of universe_at. real_bar_opens: asset -> sorted open ts of its real bars."""
    tt = _utc(t)
    out: list[str] = []
    for asset, opens in real_bar_opens.items():
        if first_listed is not None:
            fl = first_listed.get(asset)
            if fl is None or fl > tt:
                continue
        avail = pd.DatetimeIndex(opens) + BAR_DELAY
        k = int(avail.searchsorted(tt, side="right"))  # bars available by t
        if k == 0:
            continue
        last = avail[k - 1]
        if tt - last < pd.Timedelta(hours=stale_hours):
            out.append(asset)
    return sorted(out)


def load_listings(path: str | Path = "data/cleaned/listings.json") -> dict[str, pd.Timestamp]:
    """asset -> start of first listing month (UTC). Empty if the file is missing."""
    p = Path(path)
    if not p.exists():
        return {}
    d = json.loads(p.read_text(encoding="utf-8"))
    return {s: pd.Timestamp(v["first_month"] + "-01", tz="UTC")
            for s, v in d.get("symbols", {}).items() if v.get("first_month")}


def _dir_signature(d: Path) -> tuple[tuple[str, int, int], ...]:
    """(name, mtime_ns, size) of every bar file: a re-clean changes it and invalidates the cache (D9)."""
    if not d.exists():
        return ()
    return tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in sorted(d.glob("*.parquet")))


def _real_bar_opens(root: str, market: str) -> dict[str, pd.DatetimeIndex]:
    return _real_bar_opens_cached(root, market, _dir_signature(Path(root) / "bars" / market))


@lru_cache(maxsize=8)
def _real_bar_opens_cached(root: str, market: str, signature: tuple[tuple[str, int, int], ...],
                           ) -> dict[str, pd.DatetimeIndex]:
    d = Path(root) / "bars" / market
    out: dict[str, pd.DatetimeIndex] = {}
    for p in sorted(d.glob("*.parquet")) if d.exists() else []:
        df = pd.read_parquet(p, columns=["ts", "is_filled"])
        ts = pd.DatetimeIndex(df["ts"]).tz_convert("UTC")
        out[p.stem] = ts[~df["is_filled"].astype(bool).to_numpy()].sort_values()
    return out


def universe_at(
    t: str | pd.Timestamp,
    root: str | Path = "data/cleaned",
    market: Market = "perp",
    stale_hours: int = DEFAULT_STALE_HOURS,
    listings_path: str | Path | None = None,
) -> list[str]:
    """Assets eligible at decision time t (see module docstring)."""
    root = Path(root)
    opens = _real_bar_opens(str(root.resolve()), market)
    listed = load_listings(listings_path if listings_path is not None else root / "listings.json")
    if listed:
        opens = {a: o for a, o in opens.items() if a in listed}
    return eligible_at(t, opens, listed or None, stale_hours)


def ranked_universe_at(md: MarketData, t: str | pd.Timestamp, **rules: object) -> list[str]:
    """engine.universe.pit_universe_mask membership for the last bar fully closed by t."""
    tt = _utc(t)
    bar = (tt - BAR_DELAY).floor("h")
    trunc = md.truncate(bar)
    if trunc.close.empty or trunc.close.index[-1] != bar:
        return []
    mask = pit_universe_mask(trunc, **rules)  # type: ignore[arg-type]
    row = mask.iloc[-1]
    return sorted(str(c) for c in row.index[row.to_numpy(dtype=bool)])
