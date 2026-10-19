"""Recent hourly bars + funding from Binance PUBLIC REST, merged with on-disk cleaned history.

Read-only GET requests to public endpoints only (no API keys, no order endpoints):
  spot   https://api.binance.com/api/v3/klines
  perp   https://fapi.binance.com/fapi/v1/klines
  fund   https://fapi.binance.com/fapi/v1/fundingRate
Only CLOSED bars are kept (open_time + 1h <= now AND Binance close_time < now); the in-progress bar
is dropped.

Failure policy (O7 / O18):
  * 451 (region blocked), 403 (forbidden) and 418 (IP ban) are FATAL for the whole step: no retry,
    `FatalFeedError` propagates and the step aborts before any ledger mutation.
  * 429 / 5xx / network errors are retried with backoff, honouring `Retry-After`.
  * HTTP 400 means "symbol not listed" ONLY for Binance error code -1121; any other 400 is a FeedError.
  * Every request respects a step-wide `Deadline`; when it runs out, `DeadlineExceeded` aborts the
    step (still before any ledger mutation, because fetching happens first).
Bar cache (O15): closed bars and funding fetched live are appended to `cache_dir` (parquet, atomic
writes) and merged like `data/cleaned`, so each step only downloads bars newer than the cache.
"""

from __future__ import annotations

import logging
import os
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
    """HTTP 400 with Binance code -1121 'Invalid symbol' -> not listed on that market."""


class FatalFeedError(FeedError):
    """Non-retryable for the whole step (451 region block, 403 forbidden, 418 IP ban)."""


class DeadlineExceeded(FeedError):
    """The step-wide fetch deadline ran out."""


FATAL_STATUS = (403, 418, 451)


class Deadline:
    """Monotonic step deadline shared by every request of a step (and across versions)."""

    def __init__(self, seconds: float | None) -> None:
        self.end = None if seconds is None else time.monotonic() + float(seconds)

    def remaining(self) -> float:
        return float("inf") if self.end is None else self.end - time.monotonic()

    def check(self, what: str = "") -> None:
        if self.remaining() <= 0:
            raise DeadlineExceeded(f"step deadline exceeded {what}".strip())


@dataclass
class FeedResult:
    data: Dataset
    last_bar: pd.Timestamp | None
    errors: list[str] = field(default_factory=list)


def _ms(t: pd.Timestamp) -> int:
    return int(t.value // 1_000_000)


def _retry_after(r: Any) -> float | None:
    try:
        v = (getattr(r, "headers", None) or {}).get("Retry-After")
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def get_json(session: requests.Session, url: str, params: dict[str, Any], retries: int = 4,
             timeout: float = 15.0, deadline: Deadline | None = None) -> Any:
    last: str = ""
    dl = deadline or Deadline(None)
    for attempt in range(retries):
        dl.check(f"before {url}")
        wait = min(2.0 ** attempt, 10.0)
        try:
            r = session.get(url, params=params, timeout=max(0.5, min(timeout, dl.remaining())))
            sc = int(r.status_code)
            if sc in FATAL_STATUS:
                raise FatalFeedError(f"HTTP {sc} from {url.split('?')[0]} (region block / ban: not retried)")
            if sc == 400:
                body = str(getattr(r, "text", ""))[:200]
                if "-1121" in body:
                    raise SymbolNotFound(f"{url} {params.get('symbol')}: {body}")
                raise FeedError(f"HTTP 400 {url} {params.get('symbol')}: {body}")
            if sc == 429 or sc >= 500:
                last = f"HTTP {sc}"
                ra = _retry_after(r)
                if ra is not None:
                    wait = ra
            else:
                r.raise_for_status()
                return r.json()
        except FeedError:
            raise
        except (requests.RequestException, ValueError) as e:
            last = f"{type(e).__name__}: {e}"
        if attempt < retries - 1:
            if wait >= dl.remaining():
                raise DeadlineExceeded(f"{url} {params.get('symbol')}: {last}; retry wait {wait:.0f}s "
                                       "exceeds the step deadline")
            time.sleep(wait)
    raise FeedError(f"{url} {params.get('symbol')}: {last}")


def parse_klines(rows: list[list[Any]], now: pd.Timestamp) -> pd.DataFrame:
    """Binance kline rows -> cleaned-bar frame; drops the in-progress bar (open + 1h > now)."""
    if not rows:
        return pd.DataFrame(columns=BAR_COLS)
    df = pd.DataFrame([r[:9] for r in rows],
                      columns=["ts", "open", "high", "low", "close", "volume", "close_time",
                               "quote_volume", "trades"])
    close_ms = df["close_time"].astype("int64")
    df["ts"] = pd.to_datetime(df["ts"].astype("int64"), unit="ms", utc=True).dt.as_unit("ns")
    for c in ("open", "high", "low", "close", "volume", "quote_volume", "trades"):
        df[c] = df[c].astype("float64")
    keep = (df["ts"] + HOUR <= now) & (close_ms < _ms(now))
    df = df[keep].drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
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


def _cache_file(cache_dir: Path, kind: str, symbol: str) -> Path:
    return Path(cache_dir) / kind / f"{symbol}.parquet"


def _atomic_parquet(df: pd.DataFrame, p: Path) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, p)


def load_cached_bars(cache_dir: Path | None, market: str, symbol: str, start: pd.Timestamp) -> pd.DataFrame:
    if cache_dir is None:
        return pd.DataFrame(columns=BAR_COLS)
    p = _cache_file(cache_dir, market, symbol)
    try:
        df = pd.read_parquet(p) if p.exists() else pd.DataFrame(columns=BAR_COLS)
    except (OSError, ValueError) as e:      # a corrupt cache file is just refetched
        log.warning("bar cache %s unreadable (%s); ignoring", p, e)
        return pd.DataFrame(columns=BAR_COLS)
    if df.empty:
        return pd.DataFrame(columns=BAR_COLS)
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.as_unit("ns")
    return df[df["ts"] >= start][BAR_COLS].reset_index(drop=True)


def save_cached_bars(cache_dir: Path | None, market: str, symbol: str, new: pd.DataFrame,
                     keep_from: pd.Timestamp) -> None:
    if cache_dir is None or new.empty:
        return
    old = load_cached_bars(cache_dir, market, symbol, keep_from)
    both = pd.concat([old, new[BAR_COLS]]) if len(old) else new[BAR_COLS]
    both = both.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    _atomic_parquet(both[both["ts"] >= keep_from], _cache_file(cache_dir, market, symbol))


def load_cached_funding(cache_dir: Path | None, symbol: str) -> pd.Series:
    empty = pd.Series(dtype="float64", index=pd.DatetimeIndex([], tz="UTC", name="ts"))
    if cache_dir is None:
        return empty
    p = _cache_file(cache_dir, "funding", symbol)
    try:
        df = pd.read_parquet(p) if p.exists() else None
    except (OSError, ValueError):
        return empty
    if df is None or df.empty:
        return empty
    idx = pd.DatetimeIndex(pd.to_datetime(df["ts"], utc=True)).as_unit("ns")
    return pd.Series(df["rate"].astype("float64").to_numpy(), index=idx, dtype="float64")


def save_cached_funding(cache_dir: Path | None, symbol: str, s: pd.Series, keep_from: pd.Timestamp) -> None:
    if cache_dir is None or s.empty:
        return
    both = pd.concat([load_cached_funding(cache_dir, symbol), s])
    both = both[~both.index.duplicated(keep="last")].sort_index()
    both = both[both.index >= keep_from]
    _atomic_parquet(pd.DataFrame({"ts": both.index, "rate": both.to_numpy()}),
                    _cache_file(cache_dir, "funding", symbol))


def build_live_dataset(
    session: requests.Session,
    symbols: Iterable[str],
    now: pd.Timestamp,
    root: str | Path = "data/cleaned",
    history_days: int = 200,
    quote: str = "USDT",
    retries: int = 4,
    timeout: float = 15.0,
    cache_dir: str | Path | None = None,
    deadline: Deadline | None = None,
) -> FeedResult:
    """Dataset shaped like engine.data.load output, ending at the last CLOSED hourly bar.

    Raises FatalFeedError / DeadlineExceeded (whole step must abort); other per-symbol feed errors
    are collected in `errors`."""
    syms = list(symbols)
    now = pd.Timestamp(now).tz_convert("UTC") if pd.Timestamp(now).tzinfo else pd.Timestamp(now, tz="UTC")
    last_closed = now.floor("h") - HOUR
    start = (now - pd.Timedelta(days=history_days)).floor("h")
    keep_from = start - pd.Timedelta(days=7)
    cdir = Path(cache_dir) if cache_dir is not None else None
    disk = load_dataset(root, syms, start=start, end=last_closed)
    errors: list[str] = []
    kw: dict[str, Any] = {"retries": retries, "timeout": timeout, "deadline": deadline}

    fetched: dict[Market, dict[str, pd.DataFrame]] = {"spot": {}, "perp": {}}
    for m in ("spot", "perp"):
        md = disk.market(m)  # type: ignore[arg-type]
        for s in syms:
            col = md.close[s].dropna() if s in md.close.columns else pd.Series(dtype="float64")
            real = col[~md.is_filled[s].reindex(col.index).fillna(True)] if len(col) else col
            cached = load_cached_bars(cdir, m, s, start)
            creal = cached[~cached["is_filled"].astype(bool)]["ts"] if len(cached) else pd.Series([])
            lasts = [x for x in (real.index[-1] if len(real) else None,
                                 creal.iloc[-1] if len(creal) else None) if x is not None]
            fstart = max(max(lasts) + HOUR, start) if lasts else start
            try:
                new = fetch_klines(session, m, s, fstart, now, quote, **kw)  # type: ignore[arg-type]
            except SymbolNotFound:
                new = pd.DataFrame(columns=BAR_COLS)
            except (FatalFeedError, DeadlineExceeded):
                raise
            except FeedError as e:
                errors.append(f"{m} {s}: {e}")
                new = pd.DataFrame(columns=BAR_COLS)
            save_cached_bars(cdir, m, s, new, keep_from)
            parts = [x for x in (cached, new) if len(x)]
            fetched[m][s] = (pd.concat(parts).drop_duplicates("ts", keep="last").sort_values("ts")
                             .reset_index(drop=True) if parts else pd.DataFrame(columns=BAR_COLS))

    fund_cols: dict[str, pd.Series] = {}
    for s in syms:
        old = disk.funding[s].dropna() if s in disk.funding.columns else pd.Series(dtype="float64")
        cf = load_cached_funding(cdir, s)
        old = pd.concat([old, cf]) if len(cf) else old
        old = old[~old.index.duplicated(keep="last")].sort_index() if len(old) else old
        fstart = max(old.index[-1] + pd.Timedelta(milliseconds=1), start) if len(old) else start
        try:
            new_f = fetch_funding(session, s, fstart, now, quote, **kw)
        except SymbolNotFound:
            new_f = pd.Series(dtype="float64")
        except (FatalFeedError, DeadlineExceeded):
            raise
        except FeedError as e:
            errors.append(f"funding {s}: {e}")
            new_f = pd.Series(dtype="float64")
        save_cached_funding(cdir, s, new_f, keep_from)
        both = pd.concat([old, new_f]) if len(new_f) else old
        both = both[~both.index.duplicated(keep="last")].sort_index()
        fund_cols[s] = both[both.index >= start] if len(both) else both
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
