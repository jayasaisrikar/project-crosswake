"""Base hourly features. All strictly causal: row t uses only Dataset.truncate(t).

Conventions:
  * prices are perp closes on REAL bars (is_filled bars -> NaN, so stale prints never enter);
  * returns are log returns; "1h ret" at t = log(close_t / close_{t-1});
  * rolling windows are counted in hourly rows with min_periods = window (no partial windows),
    except funding statistics, which use the last N funding EVENTS with ts <= t;
  * vol figures are per-hour standard deviations (not annualized).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.contracts import Dataset
from engine.features.registry import feature

BTC = "BTC"
ETH = "ETH"
FUNDING_WINDOW_EVENTS = 90


def _px(d: Dataset, market: str = "perp") -> pd.DataFrame:
    md = d.market("perp" if market == "perp" else "spot")
    c = md.close.where(~md.is_filled.reindex_like(md.close).fillna(True).astype(bool))
    return c.where(c > 0)


def _logret(d: Dataset, h: int) -> pd.DataFrame:
    p = _px(d)
    lp = pd.DataFrame(np.log(p.to_numpy()), index=p.index, columns=p.columns)
    return lp - lp.shift(h)


def _r1(d: Dataset) -> pd.DataFrame:
    return _logret(d, 1)


def _btc_col(d: Dataset, panel: pd.DataFrame) -> pd.Series:
    if BTC not in panel.columns:
        return pd.Series(np.nan, index=panel.index)
    return panel[BTC]


def _broadcast(s: pd.Series, like: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(np.repeat(s.to_numpy()[:, None], like.shape[1], axis=1),
                       index=like.index, columns=like.columns)
    return out.where(like.notna())


def _funding_events_asof(d: Dataset, stat: pd.DataFrame | None = None) -> pd.DataFrame:
    """Per-asset funding event series (or a per-event statistic) as of each hourly row t."""
    idx = d.perp.close.index
    src = d.funding if stat is None else stat
    cols = {}
    for sym in d.perp.close.columns:
        if sym not in src.columns:
            cols[sym] = pd.Series(np.nan, index=idx)
            continue
        ev = src[sym].dropna().sort_index()
        ev = ev[~ev.index.duplicated(keep="last")]
        cols[sym] = ev.reindex(idx, method="ffill") if len(ev) else pd.Series(np.nan, index=idx)
    return pd.DataFrame(cols, index=idx, columns=d.perp.close.columns)


def _per_event(d: Dataset, fn: object) -> pd.DataFrame:
    out = {}
    for sym in d.funding.columns:
        ev = d.funding[sym].dropna().sort_index()
        ev = ev[~ev.index.duplicated(keep="last")]
        out[sym] = fn(ev)  # type: ignore[operator]
    return pd.DataFrame(out)


# --- returns ---------------------------------------------------------------------------------------

@feature("ret_1h", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=2)
def ret_1h(d: Dataset) -> pd.DataFrame:
    """1h log return of perp close."""
    return _logret(d, 1)


@feature("ret_4h", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=5)
def ret_4h(d: Dataset) -> pd.DataFrame:
    """4h log return of perp close."""
    return _logret(d, 4)


@feature("ret_24h", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=25)
def ret_24h(d: Dataset) -> pd.DataFrame:
    """24h log return of perp close."""
    return _logret(d, 24)


@feature("ret_7d", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=169)
def ret_7d(d: Dataset) -> pd.DataFrame:
    """168h log return of perp close."""
    return _logret(d, 168)


# --- volatility / momentum -------------------------------------------------------------------------

@feature("rv_24h", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=25)
def rv_24h(d: Dataset) -> pd.DataFrame:
    """Realized vol: std of 1h log returns over 24 rows (per-hour units)."""
    return _r1(d).rolling(24, min_periods=24).std()


@feature("rv_7d", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=169)
def rv_7d(d: Dataset) -> pd.DataFrame:
    """Realized vol: std of 1h log returns over 168 rows (per-hour units)."""
    return _r1(d).rolling(168, min_periods=168).std()


@feature("vol_adj_mom_7d", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=169)
def vol_adj_mom_7d(d: Dataset) -> pd.DataFrame:
    """ret_7d / (rv_7d * sqrt(168)): 7d return in units of its own 7d vol."""
    den = _r1(d).rolling(168, min_periods=168).std() * np.sqrt(168)
    return _logret(d, 168) / den.where(den > 0)


@feature("volume_z_7d", version=1, inputs=("perp.quote_volume", "perp.is_filled"), lookback_hours=168)
def volume_z_7d(d: Dataset) -> pd.DataFrame:
    """z-score of log(1+quote_volume) vs the trailing 168 real bars (incl. t)."""
    md = d.perp
    qv = md.quote_volume.where(~md.is_filled.reindex_like(md.quote_volume).fillna(True).astype(bool))
    q = qv.where(qv >= 0)
    x = pd.DataFrame(np.log1p(q.to_numpy()), index=q.index, columns=q.columns)
    roll = x.rolling(168, min_periods=168)
    sd = roll.std()
    return (x - roll.mean()) / sd.where(sd > 0)


# --- funding / basis --------------------------------------------------------------------------------

@feature("funding_z_90evt", version=1, inputs=("funding", "perp.close"), lookback_hours=24 * 31)
def funding_z_90evt(d: Dataset) -> pd.DataFrame:
    """z-score of the latest funding rate (ts <= t) vs the last 90 funding events."""
    def z(ev: pd.Series) -> pd.Series:
        r = ev.rolling(FUNDING_WINDOW_EVENTS, min_periods=FUNDING_WINDOW_EVENTS)
        sd = r.std()
        return (ev - r.mean()) / sd.where(sd > 0)
    return _funding_events_asof(d, _per_event(d, z))


@feature("funding_change", version=1, inputs=("funding", "perp.close"), lookback_hours=24 * 2)
def funding_change(d: Dataset) -> pd.DataFrame:
    """Latest funding rate minus the previous event's rate (per event, ts <= t)."""
    return _funding_events_asof(d, _per_event(d, lambda ev: ev.diff()))


@feature("basis_perp_spot", version=1,
         inputs=("perp.close", "perp.is_filled", "spot.close", "spot.is_filled"), lookback_hours=1)
def basis_perp_spot(d: Dataset) -> pd.DataFrame:
    """perp_close / spot_close - 1 on bars where both legs are real."""
    perp = _px(d, "perp")
    spot = _px(d, "spot").reindex(index=perp.index, columns=perp.columns)
    return perp / spot - 1.0


# --- cross-asset -----------------------------------------------------------------------------------

@feature("btc_ret_lag1h", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=3)
def btc_ret_lag1h(d: Dataset) -> pd.DataFrame:
    """BTC 1h log return one bar earlier (t-1), broadcast to every listed asset."""
    r = _r1(d)
    return _broadcast(_btc_col(d, r).shift(1), _px(d))


@feature("btc_ret_lag2h", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=4)
def btc_ret_lag2h(d: Dataset) -> pd.DataFrame:
    """BTC 1h log return two bars earlier (t-2), broadcast to every listed asset."""
    r = _r1(d)
    return _broadcast(_btc_col(d, r).shift(2), _px(d))


@feature("ethbtc_rs_7d", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=169)
def ethbtc_rs_7d(d: Dataset) -> pd.DataFrame:
    """ETH/BTC relative strength: ret_7d(ETH) - ret_7d(BTC). Single column 'ETHBTC'."""
    r = _logret(d, 168)
    eth = r[ETH] if ETH in r.columns else pd.Series(np.nan, index=r.index)
    return pd.DataFrame({"ETHBTC": eth - _btc_col(d, r)}, index=r.index)


@feature("btc_beta_7d", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=169)
def btc_beta_7d(d: Dataset) -> pd.DataFrame:
    """Rolling 168-row OLS beta of asset 1h returns on BTC 1h returns (168 hourly rows, both legs real)."""
    r = _r1(d)
    b = _btc_col(d, r)
    out = {}
    for c in r.columns:
        ok = r[c].notna() & b.notna()
        x, y = r[c].where(ok), b.where(ok)
        cov = x.rolling(168, min_periods=168).cov(y)
        var = y.rolling(168, min_periods=168).var()
        out[c] = cov / var.where(var > 0)
    return pd.DataFrame(out, index=r.index, columns=r.columns).where(r.notna())


@feature("btc_corr_7d", version=1, inputs=("perp.close", "perp.is_filled"), lookback_hours=169)
def btc_corr_7d(d: Dataset) -> pd.DataFrame:
    """Rolling 168-row correlation of asset vs BTC 1h returns (168 hourly rows, both legs real)."""
    r = _r1(d)
    b = _btc_col(d, r)
    out = {}
    for c in r.columns:
        ok = r[c].notna() & b.notna()
        out[c] = r[c].where(ok).rolling(168, min_periods=168).corr(b.where(ok))
    return pd.DataFrame(out, index=r.index, columns=r.columns).where(r.notna())


@feature("drawdown_30d", version=2, inputs=("perp.close", "perp.is_filled"), lookback_hours=720)
def drawdown_30d(d: Dataset) -> pd.DataFrame:
    """close / max(close over trailing 720 rows incl. t) - 1  (<= 0); full 720-row windows only."""
    p = _px(d)
    return p / p.rolling(720, min_periods=720).max() - 1.0
