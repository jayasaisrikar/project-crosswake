"""Measured quoted half-spreads (bps) per symbol and market -> data/cleaned/spreads.json.

Perp (USDT-M): measured from Binance `bookTicker` archives on data.binance.vision
  (data/futures/um/daily/bookTicker/{SYM}USDT/{SYM}USDT-bookTicker-YYYY-MM-DD.zip, sha256-verified).
  Archive availability (checked 2026-10-09 via the S3 bucket listing): daily files exist ONLY for
  2023-05-16 .. 2024-03-30 (monthly 2023-05 .. 2024-04); the feed was discontinued afterwards and
  never existed for LUNA/FTT perps. Quotes are sampled time-weighted (last quote in each 1 s bucket,
  forward-filled), so a burst of updates does not dominate the statistic.
Spot, and perps without bookTicker: Abdi & Ranaldo (2017) close-high-low estimator on 1h klines
  ("A Simple Estimation of Bid-Ask Spreads from Daily Close, High, and Low Prices", Review of
  Financial Studies 30(12), 4437-4480), computed per calendar month with negative moments set to 0:
      eta_t = (ln H_t + ln L_t) / 2,   c_t = ln C_t
      S^2   = max(4 * mean[(c_t - eta_t)(c_t - eta_{t+1})], 0)       (S = full relative spread)
  half-spread = S / 2. Applied to 1h bars it also absorbs intrabar volatility/microstructure noise
  and is therefore biased UP vs. quoted spreads in liquid books: a conservative estimate. Every
  entry records its `source` so this is visible downstream.

Volatility regimes (bookTicker only): each sampled hour is bucketed by its realized vol (sum of
squared 1-min mid log returns) into terciles within the symbol; median half-spread per tercile.
"""

from __future__ import annotations

import json
import logging
import zipfile
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from engine.data.download import BASE_URL, FileResult, _fetch_one

log = logging.getLogger(__name__)

BOOK_TICKER_PATH = "data/futures/um/daily/bookTicker/{pair}/{pair}-bookTicker-{day}.zip"
BOOK_TICKER_FIRST = "2023-05-16"
BOOK_TICKER_LAST = "2024-03-30"
# One mid-quarter day per quarter the archive covers (2023Q2 is only partially covered).
DEFAULT_SAMPLE_DAYS = ("2023-06-15", "2023-09-15", "2023-12-15", "2024-03-15")
STATS = ("median", "p75", "p95")
# Floor for estimator-sourced entries. Measured calibration (spreads.json "calibration_ar_vs_bookTicker"):
# on 1h bars the AR second moment is usually NEGATIVE (vol dominates), giving 0 for most months even
# where the true quoted half-spread is 0.02-2 bp, so a zero estimate is uninformative, not "free".
# Floor = the engine's previous assumed default half-spread (2 bp).
AR_FLOOR_BPS = 2.0


# ---------------------------------------------------------------------------------------------
# bookTicker
# ---------------------------------------------------------------------------------------------
def download_book_tickers(
    symbols: Iterable[str], days: Iterable[str] = DEFAULT_SAMPLE_DAYS, raw_root: str | Path = "data/raw",
    quote: str = "USDT", workers: int = 4,
) -> list[FileResult]:
    raw = Path(raw_root) / "bookTicker"
    tasks = []
    for sym in symbols:
        pair = f"{sym}{quote}"
        for day in days:
            rel = BOOK_TICKER_PATH.format(pair=pair, day=day)
            tasks.append(("bookTicker", sym, day, f"{BASE_URL}/{rel}", raw / sym / Path(rel).name))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(lambda t: _fetch_one(*t), tasks))


def read_book_ticker(path: str | Path) -> pd.DataFrame:
    """Time-weighted 1 s snapshots: columns bid, ask, mid, hs_bps; index UTC second."""
    with zipfile.ZipFile(path) as zf, zf.open(zf.namelist()[0]) as fh:
        df = pd.read_csv(fh, usecols=["best_bid_price", "best_ask_price", "transaction_time"])
    df.columns = pd.Index(["bid", "ask", "t"])
    df = df[(df["bid"] > 0) & (df["ask"] >= df["bid"])]
    df.index = pd.to_datetime(df.pop("t"), unit="ms", utc=True)
    snap = df.sort_index().resample("1s").last().ffill().dropna()
    snap["mid"] = (snap["bid"] + snap["ask"]) / 2
    snap["hs_bps"] = (snap["ask"] - snap["bid"]) / 2 / snap["mid"] * 1e4
    return snap


def _stats(x: pd.Series) -> dict[str, float]:
    x = x.dropna()
    return {"median": float(x.median()), "p75": float(x.quantile(0.75)), "p95": float(x.quantile(0.95))}


def book_ticker_summary(paths: list[Path]) -> dict[str, Any] | None:
    snaps = [read_book_ticker(p) for p in paths]
    snaps = [s for s in snaps if len(s)]
    if not snaps:
        return None
    allq = pd.concat(snaps)
    out: dict[str, Any] = _stats(allq["hs_bps"])
    # vol regimes: realized vol per hour from 1-min mid returns
    hourly = []
    for s in snaps:
        r = np.log(s["mid"].resample("1min").last()).diff()
        rv = (r**2).resample("1h").sum()
        hs = s["hs_bps"].resample("1h").median()
        hourly.append(pd.DataFrame({"rv": rv, "hs": hs}).dropna())
    h = pd.concat(hourly)
    if len(h) >= 9:
        terc = pd.qcut(h["rv"].rank(method="first"), 3, labels=["low", "mid", "high"])
        med = h.groupby(terc, observed=True)["hs"].median()
        out["by_vol_regime_median"] = {str(k): float(v) for k, v in med.items()}
    out.update(source="bookTicker", n_days=len(snaps), n_seconds=int(len(allq)),
               days=sorted({str(s.index[0].date()) for s in snaps}))
    return out


# ---------------------------------------------------------------------------------------------
# Abdi-Ranaldo (2017)
# ---------------------------------------------------------------------------------------------
def abdi_ranaldo_half_spread_bps(high: pd.Series, low: pd.Series, close: pd.Series,
                                 freq: str = "MS") -> pd.Series:
    """Per-period (default calendar month) Abdi-Ranaldo half-spread in bps from bar H/L/C."""
    df = pd.DataFrame({"h": high, "l": low, "c": close}).dropna()
    df = df[(df["h"] > 0) & (df["l"] > 0) & (df["c"] > 0)]
    if df.empty:
        return pd.Series(dtype=float)
    eta = (np.log(df["h"]) + np.log(df["l"])) / 2
    c = np.log(df["c"])
    prod = ((c - eta) * (c - eta.shift(-1))).dropna()
    m = prod.groupby(pd.Grouper(freq=freq)).mean()
    s2 = (4 * m).clip(lower=0.0)
    return (np.sqrt(s2) / 2 * 1e4).dropna()


def abdi_ranaldo_summary(
    bars: pd.DataFrame, start: str | None = None, end: str | None = None
) -> dict[str, Any] | None:
    if "is_filled" in bars:
        bars = bars[~bars["is_filled"].astype(bool)]
    bars = bars.loc[start:end] if (start or end) else bars
    ar = abdi_ranaldo_half_spread_bps(bars["high"], bars["low"], bars["close"])
    if ar.empty:
        return None
    raw = _stats(ar)
    out: dict[str, Any] = {k: max(v, AR_FLOOR_BPS) for k, v in raw.items()}
    out.update(source="abdi_ranaldo_2017_1h_monthly", n_months=int(len(ar)), raw=raw,
               floor_bps=AR_FLOOR_BPS, share_zero_months=float((ar == 0).mean()))
    return out


def _load_bars(cleaned_root: Path, market: str, sym: str) -> pd.DataFrame | None:
    p = cleaned_root / "bars" / market / f"{sym}.parquet"
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    if "ts" in df:
        df = df.set_index(pd.DatetimeIndex(df["ts"]))
    return df


# ---------------------------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------------------------
def build_spreads(
    symbols: Iterable[str], days: Iterable[str] = DEFAULT_SAMPLE_DAYS, raw_root: str | Path = "data/raw",
    cleaned_root: str | Path = "data/cleaned", download: bool = True,
) -> dict[str, Any]:
    symbols = list(symbols)
    days = list(days)
    cleaned = Path(cleaned_root)
    files: list[FileResult] = download_book_tickers(symbols, days, raw_root) if download else []
    by_sym: dict[str, list[Path]] = {}
    for r in files:
        if r.status in ("ok", "cached") and r.path:
            by_sym.setdefault(r.symbol, []).append(Path(r.path))
        elif r.status == "error":
            log.warning("bookTicker %s %s: %s", r.symbol, r.period, r.error)
    if not download:
        for sym in symbols:
            ps = sorted((Path(raw_root) / "bookTicker" / sym).glob("*.zip"))
            if ps:
                by_sym[sym] = ps

    out: dict[str, Any] = {"spot": {}, "perp": {}}
    calib: dict[str, Any] = {}
    for sym in symbols:
        bt = book_ticker_summary(by_sym[sym]) if sym in by_sym else None
        pb = _load_bars(cleaned, "perp", sym)
        ar_perp_full = abdi_ranaldo_summary(pb) if pb is not None else None
        if bt is not None:
            out["perp"][sym] = bt
            same = abdi_ranaldo_summary(pb, BOOK_TICKER_FIRST, BOOK_TICKER_LAST) if pb is not None else None
            if same is not None:
                calib[sym] = {"bookTicker_median": bt["median"],
                              "ar_perp_same_period_raw_median": same["raw"]["median"]}
        elif ar_perp_full is not None:
            out["perp"][sym] = ar_perp_full
        sb = _load_bars(cleaned, "spot", sym)
        ar_spot = abdi_ranaldo_summary(sb) if sb is not None else None
        if ar_spot is not None:
            out["spot"][sym] = ar_spot
    return {
        "unit": "half-spread, bps of mid",
        "generated_at": datetime.now(UTC).isoformat(),
        "book_ticker_archive_range": [BOOK_TICKER_FIRST, BOOK_TICKER_LAST],
        "sample_days": days,
        "methods": {
            "bookTicker": "Binance USDT-M bookTicker archive, 1 s time-weighted snapshots, (ask-bid)/2/mid",
            "abdi_ranaldo_2017_1h_monthly": "Abdi & Ranaldo (2017, RFS) CHL estimator on 1h klines, per "
                                            "month, negatives->0; conservative (upward-biased) estimate",
        },
        "calibration_ar_vs_bookTicker": calib,
        "spot": out["spot"],
        "perp": out["perp"],
    }


def write_spreads(payload: dict[str, Any], path: str | Path = "data/cleaned/spreads.json") -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload, indent=1))
    return p


def main() -> None:  # pragma: no cover - CLI helper: `uv run python -m engine.data.spreads [--no-download]`
    import sys

    import yaml

    logging.basicConfig(level=logging.INFO)
    uni = yaml.safe_load(Path("config/universe.yaml").read_text())
    print(write_spreads(build_spreads(uni["symbols"], download="--no-download" not in sys.argv)))


if __name__ == "__main__":  # pragma: no cover
    main()
