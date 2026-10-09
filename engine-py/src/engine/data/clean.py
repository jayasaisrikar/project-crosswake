"""Parse raw Binance zips into cleaned hourly parquet files (see engine.contracts for layout)."""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

KLINE_COLS = [
    "open_time", "open", "high", "low", "close", "volume", "close_time",
    "quote_volume", "trades", "taker_buy_volume", "taker_buy_quote_volume", "ignore",
]
BAR_COLS = ["ts", "open", "high", "low", "close", "volume", "quote_volume", "trades", "is_filled"]
HOUR = pd.Timedelta(hours=1)
US_THRESHOLD = 10**15  # epoch ms ~1.7e12, epoch us ~1.7e15
DISCONTINUITY = 0.9    # >90% jump between consecutive real bars (open vs prev close)


def to_utc(values: pd.Series) -> pd.Series:
    """Epoch ints (ms or us, detected per value magnitude) -> tz-aware UTC timestamps."""
    v = pd.to_numeric(values, errors="coerce").astype("float64")
    ms = np.where(v >= US_THRESHOLD, v / 1000.0, v)
    return pd.Series(
        pd.to_datetime(np.round(ms).astype("int64"), unit="ms", utc=True), index=values.index
    ).astype("datetime64[ns, UTC]")


def detect_unit(first_ts: float) -> str:
    return "us" if first_ts >= US_THRESHOLD else "ms"


def _read_csv_text(text: str, ncols: int | None = None) -> pd.DataFrame:
    """Read a header-or-not CSV: drop any non-numeric first-column rows (headers)."""
    df = pd.read_csv(io.StringIO(text), header=None, dtype=str)
    first = df[0].astype(str).str.strip()
    df = df[first.str.fullmatch(r"\d+")].reset_index(drop=True)
    if ncols is not None:
        df = df.iloc[:, :ncols]
    return df


def parse_kline_csv(text: str) -> pd.DataFrame:
    """One CSV file -> DataFrame(ts, open, high, low, close, volume, quote_volume, trades)."""
    df = _read_csv_text(text, ncols=len(KLINE_COLS))
    df.columns = KLINE_COLS[: df.shape[1]]
    if df.empty:
        return pd.DataFrame(columns=BAR_COLS[:-1])
    out = pd.DataFrame({"ts": to_utc(df["open_time"])})
    for c in ("open", "high", "low", "close", "volume", "quote_volume", "trades"):
        out[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    return out


def parse_funding_csv(text: str) -> pd.DataFrame:
    df = _read_csv_text(text)
    if df.empty:
        empty_ts = pd.Series(dtype="datetime64[ns, UTC]")
        return pd.DataFrame({"ts": empty_ts, "rate": pd.Series(dtype="float64")})
    return pd.DataFrame({
        "ts": to_utc(df[0]),
        "rate": pd.to_numeric(df[df.columns[-1]], errors="coerce").astype("float64"),
    })


def _zip_texts(paths: Iterable[Path]) -> Iterable[str]:
    for p in paths:
        with zipfile.ZipFile(p) as zf:
            for name in zf.namelist():
                if name.lower().endswith(".csv"):
                    yield zf.read(name).decode("utf-8", errors="replace")


def _raw_zips(raw_root: Path, kind: str, symbol: str) -> list[Path]:
    d = raw_root / kind / symbol
    return sorted(d.rglob("*.zip")) if d.exists() else []


def truncate_at_discontinuity(df: pd.DataFrame, threshold: float = DISCONTINUITY) -> tuple[pd.DataFrame, Any]:
    """Cut the series before the first bar whose open differs >threshold from the previous close.

    Handles ticker reuse (e.g. LUNA -> LUNC rename, new LUNA listed under the old pair): the old
    series is kept up to its last bar. Comparing open vs previous close avoids flagging genuine
    intra-bar crashes. Returns (truncated df, break ts or None).
    """
    if len(df) < 2:
        return df, None
    prev_close = df["close"].shift(1)
    ratio = df["open"] / prev_close
    brk = (ratio > 1 / (1 - threshold)) | (ratio < 1 - threshold)
    if not brk.any():
        return df, None
    i = int(np.argmax(brk.to_numpy()))
    return df.iloc[:i].reset_index(drop=True), df["ts"].iloc[i]


def clean_bars(raw: pd.DataFrame, truncate_breaks: bool = True) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Dedupe, sort, validate, truncate breaks, and forward-fill the full hourly index."""
    df = raw.dropna(subset=["ts"]).sort_values("ts")
    n_dupes = int(df["ts"].duplicated().sum())
    df = df.drop_duplicates("ts", keep="last")
    df = df[df["ts"] == df["ts"].dt.floor("h")]  # only hour-aligned bars
    o, h, low, c = df["open"], df["high"], df["low"], df["close"]
    bad = (
        df[["open", "high", "low", "close"]].isna().any(axis=1)
        | (df[["open", "high", "low", "close"]] <= 0).any(axis=1)
        | (h < np.maximum(o, c)) | (low > np.minimum(o, c)) | (h < low)
        | (df["volume"] < 0)
    )
    n_bad = int(bad.sum())
    df = df[~bad].reset_index(drop=True)
    brk_ts = None
    if truncate_breaks:
        df, brk_ts = truncate_at_discontinuity(df)
    info: dict[str, Any] = {"duplicates": n_dupes, "bad_rows": n_bad,
                            "truncated_at": None if brk_ts is None else str(brk_ts)}
    if df.empty:
        return pd.DataFrame(columns=BAR_COLS), {**info, "n_bars": 0, "n_filled": 0}

    idx = pd.date_range(df["ts"].iloc[0], df["ts"].iloc[-1], freq="h")
    full = df.set_index("ts").reindex(idx)
    raw_close = full["close"]
    missing = raw_close.isna()
    # Frozen contract: a bar that is PRESENT in the archive but carries no trading — zero volume and
    # o=h=l=c equal to the previous close. This is what Binance published for FTT/perps that were halted
    # after an exchange/counterparty failure (FTX, Nov 2022). Such bars are not executable prices, so they
    # must be treated exactly like a synthesized (stale) bar. The flat test (h==l) excludes genuinely quiet
    # but tradable hours, which almost always still show an intrabar range. See audit.core.frozen_mask.
    frozen = (
        (~missing)
        & (full["volume"].fillna(-1.0) == 0.0)
        & (full["open"] == full["high"]) & (full["high"] == full["low"])
        & (full["low"] == raw_close) & (raw_close == raw_close.shift(1))
    )
    filled = (missing | frozen).fillna(False).astype(bool)
    full["close"] = raw_close.ffill()
    for col in ("open", "high", "low"):
        full[col] = full[col].fillna(full["close"])
    for col in ("volume", "quote_volume", "trades"):
        full[col] = full[col].fillna(0.0)
    full["is_filled"] = filled.to_numpy()
    full.index.name = "ts"
    out = full.reset_index()[BAR_COLS]
    out["ts"] = out["ts"].astype("datetime64[ns, UTC]")

    # longest run of consecutive filled hours
    f = filled.to_numpy()
    max_gap = 0
    run = 0
    for x in f:
        run = run + 1 if x else 0
        max_gap = max(max_gap, run)
    info.update({
        "first_ts": str(out["ts"].iloc[0]), "last_ts": str(out["ts"].iloc[-1]),
        "n_bars": len(out), "n_filled": int(f.sum()), "max_gap_hours": max_gap,
    })
    return out, info


def clean_funding(raw: pd.DataFrame) -> pd.DataFrame:
    df = raw.dropna().sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)
    df["ts"] = df["ts"].astype("datetime64[ns, UTC]")
    return df[["ts", "rate"]]


def clean_all(
    symbols: Iterable[str],
    markets: Iterable[str] = ("spot", "perp"),
    raw_root: str | Path = "data/raw",
    out_root: str | Path = "data/cleaned",
) -> dict[str, Any]:
    raw, out = Path(raw_root), Path(out_root)
    audit: dict[str, Any] = {"bars": {}, "funding": {}}
    symbols = list(symbols)
    for market in markets:
        (out / "bars" / market).mkdir(parents=True, exist_ok=True)
        audit["bars"][market] = {}
        for sym in symbols:
            zips = _raw_zips(raw, market, sym)
            target = out / "bars" / market / f"{sym}.parquet"
            if not zips:
                audit["bars"][market][sym] = {"status": "missing"}
                target.unlink(missing_ok=True)
                continue
            frames = [parse_kline_csv(t) for t in _zip_texts(zips)]
            bars, info = clean_bars(pd.concat([f for f in frames if not f.empty], ignore_index=True))
            if bars.empty:
                audit["bars"][market][sym] = {"status": "empty", **info}
                continue
            bars.to_parquet(target, index=False)
            audit["bars"][market][sym] = {"status": "ok", "files": len(zips), **info}

    (out / "funding").mkdir(parents=True, exist_ok=True)
    for sym in symbols:
        zips = _raw_zips(raw, "funding", sym)
        target = out / "funding" / f"{sym}.parquet"
        if not zips:
            audit["funding"][sym] = {"status": "missing"}
            target.unlink(missing_ok=True)
            continue
        fund = clean_funding(pd.concat([parse_funding_csv(t) for t in _zip_texts(zips)], ignore_index=True))
        brk = audit["bars"].get("perp", {}).get(sym, {}).get("truncated_at")
        if brk:  # ticker reuse: drop funding of the successor contract too
            fund = fund[fund["ts"] < pd.Timestamp(brk)].reset_index(drop=True)
        fund.to_parquet(target, index=False)
        audit["funding"][sym] = {
            "status": "ok", "n": len(fund),
            "first_ts": str(fund["ts"].iloc[0]) if len(fund) else None,
            "last_ts": str(fund["ts"].iloc[-1]) if len(fund) else None,
        }
    (out / "audit.json").write_text(json.dumps(audit, indent=1))
    return audit
