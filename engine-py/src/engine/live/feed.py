"""Recent hourly bars + funding from Binance PUBLIC REST, merged with on-disk cleaned history.

Read-only GET requests to public endpoints only (no API keys, no order endpoints):
  spot   https://api.binance.com/api/v3/klines
  perp   https://fapi.binance.com/fapi/v1/klines
  fund   https://fapi.binance.com/fapi/v1/fundingRate
Only CLOSED bars are kept (open_time + 1h <= now); the in-progress bar is dropped.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from engine.contracts import Dataset, Market, MarketData
from engine.data.load import FIELDS, load_dataset

log = logging.getLogger(__name__)

KLINE_URL: dict[Market, str] = {
    "spot": "https://api.binance.com/api/v3/klines",
    "perp": "https://fapi.binance.com/fapi/v1/klines",
}
FUNDING_URL = "https://fapi.binance.com/fapi/v1/fundingRate"
KLINE_LIMIT: dict[Market, int] = {"spot": 1000, "perp": 1500}
HOUR = pd.Timedelta(hours=1)
BAR_COLS = ["ts", "open", "high", "low", "close", "volume", "quote_volume", "trades", "is_filled"]


class FeedError(RuntimeError):
    pass


class SymbolNotFound(FeedError):
    """HTTP 400 'Invalid symbol' -> not listed on that market (not an exchange error)."""


@dataclass
class FeedResult:
    data: Dataset
    last_bar: pd.Timestamp | None
    errors: list[str] = field(default_factory=list)


def _ms(t: pd.Timestamp) -> int:
    return int(t.value // 1_000_000)


def get_json(session: requests.Session, url: str, params: dict[str, Any], retries: int = 4,
             timeout: float = 15.0) -> Any:
    last: str = ""
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code == 400:
                raise SymbolNotFound(f"{url} {params.get('symbol')}: {r.text[:200]}")
            if r.status_code in (418, 429) or r.status_code >= 500:
                last = f"HTTP {r.status_code}"
            else:
                r.raise_for_status()
                return r.json()
        except SymbolNotFound:
            raise
        except (requests.RequestException, ValueError) as e:
            last = f"{type(e).__name__}: {e}"
        if attempt < retries - 1:
            time.sleep(min(2.0 ** attempt, 10.0))
    raise FeedError(f"{url} {params.get('symbol')}: {last}")


def parse_klines(rows: list[list[Any]], now: pd.Timestamp) -> pd.DataFrame:
    """Binance kline rows -> cleaned-bar frame; drops the in-progress bar (open + 1h > now)."""
    if not rows:
        return pd.DataFrame(columns=BAR_COLS)
    df = pd.DataFrame([r[:9] for r in rows],
                      columns=["ts", "open", "high", "low", "close", "volume", "close_time",
                               "quote_volume", "trades"])
    df["ts"] = pd.to_datetime(df["ts"].astype("int64"), unit="ms", utc=True).dt.as_unit("ns")
    for c in ("open", "high", "low", "close", "volume", "quote_volume", "trades"):
        df[c] = df[c].astype("float64")
    df = df[df["ts"] + HOUR <= now].drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    # Frozen contract (same rule as engine.data.clean): zero volume, o=h=l=c = previous close. Binance
    # keeps publishing such bars for settled/halted perps (e.g. TONUSDT since 2026-07); they are not
    # executable prices and would read as zero volatility, so mark them synthetic (stale).
    df["is_filled"] = ((df["volume"] == 0.0) & (df["open"] == df["high"]) & (df["high"] == df["low"])
                       & (df["low"] == df["close"]) & (df["close"] == df["close"].shift(1)))
    return df[BAR_COLS]


def fetch_klines(session: requests.Session, market: Market, symbol: str, start: pd.Timestamp,
                 now: pd.Timestamp, quote: str = "USDT", **kw: Any) -> pd.DataFrame:
    url, limit = KLINE_URL[market], KLINE_LIMIT[market]
    out: list[pd.DataFrame] = []
    cur = start
    while cur + HOUR <= now:
        rows = get_json(session, url, {"symbol": f"{symbol}{quote}", "interval": "1h",
                                       "startTime": _ms(cur), "limit": limit}, **kw)
        df = parse_klines(rows, now)
        if df.empty:
            break
        out.append(df)
        nxt = df["ts"].iloc[-1] + HOUR
        if len(rows) < limit or nxt <= cur:
            break
        cur = nxt
    if not out:
        return pd.DataFrame(columns=BAR_COLS)
    return pd.concat(out).drop_duplicates("ts").sort_values("ts").reset_index(drop=True)


def fetch_funding(session: requests.Session, symbol: str, start: pd.Timestamp, now: pd.Timestamp,
                  quote: str = "USDT", **kw: Any) -> pd.Series:
    rows: list[dict[str, Any]] = []
    cur = start
    while True:
        batch = get_json(session, FUNDING_URL, {"symbol": f"{symbol}{quote}", "startTime": _ms(cur),
                                                "limit": 1000}, **kw)
        rows.extend(batch)
        if len(batch) < 1000:
            break
        cur = pd.Timestamp(int(batch[-1]["fundingTime"]) + 1, unit="ms", tz="UTC")
    if not rows:
        return pd.Series(dtype="float64", index=pd.DatetimeIndex([], tz="UTC", name="ts"))
    ts = pd.to_datetime([int(r["fundingTime"]) for r in rows], unit="ms", utc=True).as_unit("ns")
    s = pd.Series([float(r["fundingRate"]) for r in rows], index=ts, dtype="float64")
    s = s[s.index <= now]
    return s[~s.index.duplicated(keep="last")].sort_index()


def _bars_to_panels(frames: dict[str, pd.DataFrame], symbols: list[str]) -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    for f in FIELDS:
        cols = {s: df.set_index("ts")[f].astype("float64") for s, df in frames.items() if not df.empty}
        out[f] = pd.DataFrame(cols, columns=pd.Index(symbols), dtype="float64")
    return out


def _merge_market(disk: MarketData, fetched: dict[str, pd.DataFrame], idx: pd.DatetimeIndex,
                  symbols: list[str]) -> MarketData:
    """Fetched bars override disk bars; interior gaps forward-filled as is_filled (volume 0)."""
    fp = _bars_to_panels(fetched, symbols)
    real: dict[str, pd.DataFrame] = {}
    for f in FIELDS:
        d = getattr(disk, f).reindex(columns=symbols).astype("float64")
        if f == "is_filled":
            d = d.where(d == 0.0)  # keep only real (False) disk bars; synthesized ones recomputed
        real[f] = fp[f].combine_first(d).reindex(idx)
    is_real = real["close"].notna() & (real["is_filled"].fillna(1.0) == 0.0)
    close = real["close"].where(is_real)
    interior = close.ffill().notna() & close.bfill().notna()
    filled = interior & ~is_real
    c = close.ffill().where(interior)
    panels: dict[str, pd.DataFrame] = {}
    for f in ("open", "high", "low"):
        panels[f] = real[f].where(is_real).fillna(c.where(filled))
    panels["close"] = c
    for f in ("volume", "quote_volume"):
        panels[f] = real[f].where(is_real).fillna(0.0).where(interior)
    panels["is_filled"] = ~is_real
    idx.name = "ts"
    for p in panels.values():
        p.index.name = "ts"
    return MarketData(**panels)


def build_live_dataset(
    session: requests.Session,
    symbols: Iterable[str],
    now: pd.Timestamp,
    root: str | Path = "data/cleaned",
    history_days: int = 200,
    quote: str = "USDT",
    retries: int = 4,
    timeout: float = 15.0,
) -> FeedResult:
    """Dataset shaped like engine.data.load output, ending at the last CLOSED hourly bar."""
    syms = list(symbols)
    now = pd.Timestamp(now).tz_convert("UTC") if pd.Timestamp(now).tzinfo else pd.Timestamp(now, tz="UTC")
    last_closed = now.floor("h") - HOUR
    start = (now - pd.Timedelta(days=history_days)).floor("h")
    disk = load_dataset(root, syms, start=start, end=last_closed)
    errors: list[str] = []
    kw = {"retries": retries, "timeout": timeout}

    fetched: dict[Market, dict[str, pd.DataFrame]] = {"spot": {}, "perp": {}}
    for m in ("spot", "perp"):
        md = disk.market(m)  # type: ignore[arg-type]
        for s in syms:
            col = md.close[s].dropna() if s in md.close.columns else pd.Series(dtype="float64")
            real = col[~md.is_filled[s].reindex(col.index).fillna(True)] if len(col) else col
            fstart = max(real.index[-1] + HOUR, start) if len(real) else start
            try:
                fetched[m][s] = fetch_klines(session, m, s, fstart, now, quote, **kw)  # type: ignore[arg-type]
            except SymbolNotFound:
                fetched[m][s] = pd.DataFrame(columns=BAR_COLS)
            except FeedError as e:
                errors.append(f"{m} {s}: {e}")
                fetched[m][s] = pd.DataFrame(columns=BAR_COLS)

    fund_cols: dict[str, pd.Series] = {}
    for s in syms:
        old = disk.funding[s].dropna() if s in disk.funding.columns else pd.Series(dtype="float64")
        fstart = max(old.index[-1] + pd.Timedelta(milliseconds=1), start) if len(old) else start
        try:
            new = fetch_funding(session, s, fstart, now, quote, **kw)
        except SymbolNotFound:
            new = pd.Series(dtype="float64")
        except FeedError as e:
            errors.append(f"funding {s}: {e}")
            new = pd.Series(dtype="float64")
        both = pd.concat([old, new]) if len(new) else old
        fund_cols[s] = both[~both.index.duplicated(keep="last")].sort_index()
    funding = pd.DataFrame(fund_cols, columns=pd.Index(syms), dtype="float64").sort_index()
    if not isinstance(funding.index, pd.DatetimeIndex):
        funding.index = pd.DatetimeIndex([], tz="UTC")
    funding.index.name = "ts"

    idx = pd.date_range(start, last_closed, freq="h", tz="UTC", name="ts").as_unit("ns")
    spot = _merge_market(disk.spot, fetched["spot"], idx, syms)
    perp = _merge_market(disk.perp, fetched["perp"], idx, syms)
    real_any = (~spot.is_filled).any(axis=1) | (~perp.is_filled).any(axis=1)
    last_bar = real_any[real_any].index[-1] if real_any.any() else None
    if last_bar is not None and last_bar < idx[-1]:
        # trim trailing all-synthetic rows so the dataset ends at the last real closed bar
        spot, perp = spot.truncate(last_bar), perp.truncate(last_bar)
    data = Dataset(spot=spot, perp=perp, funding=funding.loc[:last_closed])
    return FeedResult(data=data, last_bar=last_bar, errors=errors)
