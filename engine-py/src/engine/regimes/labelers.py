"""Causal rule-based regime labelers on hourly panels. Every value at bar t uses only bars <= t;
thresholds come from EXPANDING quantiles of the indicator's own PAST values (shifted by one bar),
never from full-sample quantiles."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.contracts import Dataset

H_DAY = 24
MIN_HIST = 24 * 90  # bars of history before an expanding threshold is trusted


def _rets(ds: Dataset) -> pd.DataFrame:
    md = ds.perp
    close = md.close.where(~md.is_filled)
    return pd.DataFrame(np.log(close)).diff()


def _past_quantile(s: pd.Series, q: float) -> pd.Series:
    return s.expanding(min_periods=MIN_HIST).quantile(q).shift(1)


def trend(ds: Dataset, leader: str = "BTC") -> pd.Series:
    """bull: close > SMA30d > SMA90d; bear: close < SMA30d < SMA90d; else sideways."""
    c = ds.perp.close[leader].ffill()
    s30 = c.rolling(30 * H_DAY, min_periods=30 * H_DAY).mean()
    s90 = c.rolling(90 * H_DAY, min_periods=90 * H_DAY).mean()
    out = pd.Series("sideways", index=c.index, dtype=object)
    out[(c > s30) & (s30 > s90)] = "bull"
    out[(c < s30) & (s30 < s90)] = "bear"
    out[s90.isna()] = None
    return out


def realized_vol(ds: Dataset, leader: str = "BTC", days: int = 7) -> pd.Series:
    r = _rets(ds)[leader]
    return r.rolling(days * H_DAY, min_periods=days * H_DAY // 2).std() * np.sqrt(24 * 365)


def vol(ds: Dataset, leader: str = "BTC") -> pd.Series:
    rv = realized_vol(ds, leader)
    thr = _past_quantile(rv, 0.5)
    out = pd.Series(np.where(rv > thr, "high", "low"), index=rv.index, dtype=object)
    out[thr.isna() | rv.isna()] = None
    return out


def funding(ds: Dataset, leader: str = "BTC") -> pd.Series:
    """Last known funding print (ffilled to the hourly grid): negative if < 0, high if above the
    expanding 80th pct of past prints, else neutral."""
    idx = ds.perp.close.index
    if leader not in ds.funding.columns or ds.funding[leader].dropna().empty:
        return pd.Series(None, index=idx, dtype=object)
    f = ds.funding[leader].dropna()
    thr = f.expanding(min_periods=90).quantile(0.8).shift(1)
    lab = pd.Series(np.where(f < 0, "negative", np.where(f > thr, "high", "neutral")), index=f.index,
                    dtype=object)
    lab[thr.isna() & (f >= 0)] = None
    return lab.reindex(idx.union(lab.index)).ffill().reindex(idx)


def avg_alt_corr(ds: Dataset, leader: str = "BTC", days: int = 30) -> pd.Series:
    r = _rets(ds)
    alts = [c for c in r.columns if c != leader]
    if not alts:
        return pd.Series(np.nan, index=r.index)
    w = days * H_DAY
    return r[alts].rolling(w, min_periods=w // 2).corr(r[leader]).mean(axis=1)


def correlation(ds: Dataset, leader: str = "BTC") -> pd.Series:
    """high / low vs expanding terciles of 30d avg alt-BTC corr; breakdown if the 7d corr has fallen
    more than 0.25 below the 30d corr (takes precedence)."""
    c30 = avg_alt_corr(ds, leader, 30)
    c7 = avg_alt_corr(ds, leader, 7)
    hi, lo = _past_quantile(c30, 2 / 3), _past_quantile(c30, 1 / 3)
    out = pd.Series("mid", index=c30.index, dtype=object)
    out[c30 > hi] = "high"
    out[c30 < lo] = "low"
    out[(c7 < c30 - 0.25)] = "breakdown"
    out[hi.isna() | c30.isna()] = None
    return out


def leadership(ds: Dataset, leader: str = "BTC", days: int = 30) -> pd.Series:
    """BTC-dominance proxy: BTC 30d log return minus equal-weight alt 30d log return."""
    r = _rets(ds)
    alts = [c for c in r.columns if c != leader]
    w = days * H_DAY
    alt_sum = r[alts].rolling(w, min_periods=w // 2).sum().mean(axis=1)
    rel = r[leader].rolling(w, min_periods=w // 2).sum() - alt_sum
    out = pd.Series(np.where(rel > 0, "btc_led", "alt_led"), index=r.index, dtype=object)
    out[rel.isna()] = None
    return out


def panic(ds: Dataset, leader: str = "BTC") -> pd.Series:
    """panic: 24h realized vol > 2x its trailing 30d level AND drawdown from 30d high < -10%."""
    r = _rets(ds)[leader]
    v24 = r.rolling(H_DAY, min_periods=12).std()
    v30 = r.rolling(30 * H_DAY, min_periods=15 * H_DAY).std().shift(H_DAY)
    c = ds.perp.close[leader].ffill()
    dd = c / c.rolling(30 * H_DAY, min_periods=H_DAY).max() - 1
    out = pd.Series(np.where((v24 > 2 * v30) & (dd < -0.10), "panic", "normal"), index=r.index, dtype=object)
    out[v30.isna()] = None
    return out
