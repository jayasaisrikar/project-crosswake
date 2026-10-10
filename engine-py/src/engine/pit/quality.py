"""Data-quality validation. Extends engine.data.integrity (same Issue / IntegrityReport types).

* validate_bars(df, ...)    per-symbol cleaned bar frame (column ts + OHLCV + is_filled):
      tz      ts must be tz-aware UTC
      order   strictly increasing (non-monotonic -> critical), duplicates -> critical
      grid    hour alignment, missing hours between first and last bar
      ohlc    non-finite / <= 0 prices, high < low, high/low not bracketing open/close, volume < 0
      stale   longest run of is_filled bars (> max_stale_hours -> medium)
      jump    |log return| between consecutive REAL bars above `max_abs_log_jump` -> medium
* validate_funding(df, ...) per-symbol funding frame: tz, order, duplicates, non-finite rates,
      |rate| above `max_abs_rate` -> medium.
* validate_dataset(data)    engine.data.integrity.check_dataset plus the stale/jump checks on panels.

All checks are per-row / trailing, so a verdict about an earlier row never changes when later
data arrives.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.contracts import MARKETS, Dataset
from engine.data.integrity import IntegrityReport, _longest_run, check_dataset

DEFAULT_MAX_STALE_HOURS = 72
DEFAULT_MAX_ABS_LOG_JUMP = np.log(3.0)  # a >3x or <1/3x move in one real bar
DEFAULT_MAX_ABS_FUNDING = 0.05          # 5% per event


def _check_ts(rep: IntegrityReport, ts: pd.Series, check_hour: bool, market: str | None,
              symbol: str | None) -> pd.DatetimeIndex | None:
    if not isinstance(ts.dtype, pd.DatetimeTZDtype):
        rep.add("tz", "critical", f"timestamps are not tz-aware (dtype {ts.dtype})",
                market=market, symbol=symbol)
        return None
    idx = pd.DatetimeIndex(ts)
    if str(idx.tz) != "UTC":
        rep.add("tz", "high", f"timestamps in {idx.tz}, expected UTC", market=market, symbol=symbol)
        idx = idx.tz_convert("UTC")
    na = np.asarray(idx.isna(), dtype=bool)
    rep.add("missing", "high", "null timestamps", market=market, symbol=symbol, n=int(na.sum()))
    idx = idx[~na]
    diffs = np.diff(idx.tz_convert(None).to_numpy().astype("int64"))
    rep.add("order", "critical", "non-monotonic timestamps (decreasing step)",
            market=market, symbol=symbol, n=int((diffs < 0).sum()))
    rep.add("dupes", "critical", "duplicate timestamps",
            market=market, symbol=symbol, n=int(idx.duplicated().sum()))
    if check_hour and len(idx):
        rep.add("grid", "critical", "timestamps not hour-aligned", market=market, symbol=symbol,
                n=int((idx != idx.floor("h")).sum()))
        u = idx.unique().sort_values()
        full = pd.date_range(u[0], u[-1], freq="h")
        rep.add("missing", "high", "missing hours between first and last bar", market=market,
                symbol=symbol, n=int(len(full) - len(u.intersection(full))))
    return idx


def validate_bars(df: pd.DataFrame, symbol: str | None = None, market: str | None = None,
                  max_stale_hours: int = DEFAULT_MAX_STALE_HOURS,
                  max_abs_log_jump: float = DEFAULT_MAX_ABS_LOG_JUMP) -> IntegrityReport:
    rep = IntegrityReport()
    if "ts" not in df.columns:
        rep.add("schema", "critical", "missing ts column", market=market, symbol=symbol)
        return rep
    _check_ts(rep, df["ts"], True, market, symbol)
    filled = df["is_filled"].fillna(True).astype(bool) if "is_filled" in df else \
        pd.Series(False, index=df.index)
    real = ~filled
    px = [c for c in ("open", "high", "low", "close") if c in df.columns]
    missing_px = real & df[px].isna().any(axis=1) if px else real & False
    rep.add("missing", "high", "real bars with missing prices", market=market, symbol=symbol,
            n=int(missing_px.sum()))
    if px:
        vals = df[px].to_numpy(dtype=float)
        bad = real.to_numpy() & ~missing_px.to_numpy() & (~np.isfinite(vals) | (vals <= 0)).any(axis=1)
        rep.add("ohlc", "critical", "non-finite or <= 0 price", market=market, symbol=symbol,
                n=int(bad.sum()))
    if {"open", "high", "low", "close"} <= set(df.columns):
        o, h, lo, c = df["open"], df["high"], df["low"], df["close"]
        rep.add("ohlc", "critical", "high < low", market=market, symbol=symbol,
                n=int((real & (h < lo)).sum()))
        rep.add("ohlc", "critical", "high/low do not bracket open/close", market=market, symbol=symbol,
                n=int((real & (h >= lo) & ((h < np.maximum(o, c)) | (lo > np.minimum(o, c)))).sum()))
    if "volume" in df.columns:
        rep.add("ohlc", "high", "negative volume", market=market, symbol=symbol,
                n=int((real & (df["volume"] < 0)).sum()))
    run = _longest_run(filled.to_numpy())
    rep.stats["longest_stale_run"] = run
    if run > max_stale_hours:
        rep.add("stale", "medium", f"stale (is_filled) run of {run}h > {max_stale_hours}h",
                market=market, symbol=symbol)
    if "close" in df.columns:
        rc = df["close"].where(real & (df["close"] > 0))
        lr = np.log(rc.dropna()).diff().abs()
        rep.add("jump", "medium", f"|log return| between real bars > {max_abs_log_jump:.3f}",
                market=market, symbol=symbol, n=int((lr > max_abs_log_jump).sum()))
    return rep


def validate_funding(df: pd.DataFrame, symbol: str | None = None,
                     max_abs_rate: float = DEFAULT_MAX_ABS_FUNDING) -> IntegrityReport:
    rep = IntegrityReport()
    if "ts" not in df.columns or "rate" not in df.columns:
        rep.add("schema", "critical", "funding frame needs ts and rate", symbol=symbol)
        return rep
    _check_ts(rep, df["ts"], False, "funding", symbol)
    r = df["rate"].astype(float)
    rep.add("missing", "high", "null funding rates", symbol=symbol, n=int(r.isna().sum()))
    rep.add("funding", "critical", "non-finite funding rate", symbol=symbol,
            n=int((r.notna() & ~np.isfinite(r)).sum()))
    rep.add("funding", "medium", f"|rate| > {max_abs_rate}", symbol=symbol,
            n=int((r.abs() > max_abs_rate).sum()))
    return rep


def validate_dataset(data: Dataset, max_stale_hours: int = DEFAULT_MAX_STALE_HOURS,
                     max_abs_log_jump: float = DEFAULT_MAX_ABS_LOG_JUMP) -> IntegrityReport:
    """engine.data.integrity.check_dataset + stale-run and outlier-jump checks on the panels."""
    rep = check_dataset(data)
    for m in MARKETS:
        md = data.market(m)
        for sym in md.close.columns:
            fil = md.is_filled[sym].fillna(True).astype(bool)
            c = md.close[sym]
            real = ~fil & c.notna()
            if not real.any():
                continue
            window = (c.index >= c[real].index[0]) & (c.index <= c[real].index[-1])
            run = _longest_run((fil & window).to_numpy())
            if run > max_stale_hours:
                rep.add("stale", "medium", f"stale run of {run}h > {max_stale_hours}h",
                        market=m, symbol=sym)
            lr = np.log(c.where(real & (c > 0)).dropna()).diff().abs()
            rep.add("jump", "medium", f"|log return| between real bars > {max_abs_log_jump:.3f}",
                    market=m, symbol=sym, n=int((lr > max_abs_log_jump).sum()))
    return rep
