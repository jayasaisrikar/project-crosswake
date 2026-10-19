"""Pure audit helpers (no I/O). Every function works on engine contracts / plain pandas objects.

Conventions (match engine.backtest.engine):
  * positions are hourly NOTIONALS marked at the forward-filled close, after that bar's trades/exits;
  * a trade at bar ts is filled at the OPEN of ts (forced exits at the last available close);
  * funding at settlement hour h is charged on the perp notional held at the close of bar h-1:
        paid = position_notional[h-1] * rate        (positive = paid, negative = received).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import BacktestResult, Dataset

LEG_COLS = ["gross_long", "gross_short", "gross"]


# --------------------------------------------------------------------------- P&L attribution
def leg_pnl(pos: pd.DataFrame, open_: pd.DataFrame, close: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Split per-bar, per-symbol gross market P&L into the long and short leg.

    Units held into bar t (q_old) earn (ref_t - c_{t-1}) where ref = open (or previous close if no open);
    units held after the bar-t trade (q_new) earn (c_t - ref_t). Each piece is attributed to the sign of
    the quantity that earned it, so a long->short flip at the open is split correctly.
    `close` must already be forward-filled on the position index (as the engine marks positions).
    Returns {"long": df, "short": df, "gross": df} with the same shape as `pos`.
    """
    c = close.reindex(index=pos.index, columns=pos.columns)
    o = open_.reindex(index=pos.index, columns=pos.columns)
    c_prev = c.shift(1)
    ref = o.where(np.isfinite(o) & (o > 0), c_prev)
    q_new = (pos / c).where(pos != 0, 0.0).fillna(0.0)
    q_old = q_new.shift(1, fill_value=0.0)
    p_old = (q_old * (ref - c_prev)).fillna(0.0)
    p_new = (q_new * (c - ref)).fillna(0.0)
    long_ = p_old.where(q_old > 0, 0.0) + p_new.where(q_new > 0, 0.0)
    short = p_old.where(q_old < 0, 0.0) + p_new.where(q_new < 0, 0.0)
    return {"long": long_, "short": short, "gross": long_ + short}


def ledger_gross(pos: pd.DataFrame, trades: pd.DataFrame, market: str) -> pd.DataFrame:
    """Accounting gross P&L per symbol: d(position notional) - traded notional (exact, from the ledger)."""
    t = trades[trades["market"] == market] if len(trades) else trades
    traded = (t.groupby(["ts", "symbol"])["qty_notional"].sum().unstack("symbol")
              if len(t) else pd.DataFrame(index=pos.index))
    traded.index = pd.DatetimeIndex(traded.index)
    traded = traded.reindex(index=pos.index, columns=pos.columns).fillna(0.0)
    d = pos.diff()
    d.iloc[0] = pos.iloc[0]
    return d - traded


def attribution_table(
    pos: pd.DataFrame,
    open_: pd.DataFrame,
    close_ff: pd.DataFrame,
    trades: pd.DataFrame,
    funding_by_symbol: pd.DataFrame | None,
    market: str,
) -> pd.DataFrame:
    """Per (year, symbol): gross long, gross short, gross, fees, spread, impact, funding, net (all USDT).

    `funding_by_symbol` is hourly paid funding per symbol (positive = paid). Net = gross - costs - funding.
    A residual column checks gross(long+short from prices) against the ledger gross.
    """
    legs = leg_pnl(pos, open_, close_ff)
    led = ledger_gross(pos, trades, market)
    yr = pd.DatetimeIndex(pos.index).year
    out: list[pd.DataFrame] = []
    names = {"gross_long": legs["long"], "gross_short": legs["short"], "gross": legs["gross"],
             "ledger_gross": led}
    for k, df in names.items():
        st: pd.Series = df.groupby(yr).sum().stack()  # type: ignore[assignment]
        out.append(st.to_frame(name=k))
    t = trades[trades["market"] == market] if len(trades) else trades
    for col, name in (("fee", "fees"), ("spread", "spread"), ("impact", "impact")):
        g: pd.Series = (t.assign(year=pd.DatetimeIndex(t["ts"]).year).groupby(["year", "symbol"])[col].sum()
                        if len(t) else pd.Series(dtype=float))
        out.append(g.rename(name).to_frame())
    if funding_by_symbol is not None and len(funding_by_symbol):
        f: pd.Series = funding_by_symbol.groupby(  # type: ignore[assignment]
            pd.DatetimeIndex(funding_by_symbol.index).year).sum().stack()
        out.append(f.to_frame(name="funding"))
    tab = pd.concat(out, axis=1).fillna(0.0)
    tab.index.names = ["year", "symbol"]
    if "funding" not in tab:
        tab["funding"] = 0.0
    tab["costs"] = tab["fees"] + tab["spread"] + tab["impact"]
    tab["net"] = tab["gross"] - tab["costs"] - tab["funding"]
    tab["residual_vs_ledger"] = tab["gross"] - tab["ledger_gross"]
    return tab.sort_index()


# --------------------------------------------------------------------------- funding
def bar_index(data: Dataset) -> pd.DatetimeIndex:
    return pd.DatetimeIndex(data.spot.close.index.union(data.perp.close.index)).sort_values()


def funding_ledger(perp_pos: pd.DataFrame, funding: pd.DataFrame, idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Independent per-event funding ledger.

    One row per raw funding event with a non-zero position: settlement hour (ts rounded to the hour),
    the notional held at the close of the previous bar, rate, paid (= notional * rate).
    Events at or before the first bar of the run, or past its last bar, are not charged (as in the engine).
    """
    rows: list[dict[str, Any]] = []
    pos_idx = pd.DatetimeIndex(perp_pos.index)
    if not len(pos_idx):
        return pd.DataFrame(columns=["event_ts", "settle_ts", "symbol", "notional", "rate", "paid"])
    for sym in perp_pos.columns:
        if sym not in funding.columns:
            continue
        f = funding[sym].dropna()
        if not len(f):
            continue
        settle = pd.DatetimeIndex(f.index).round("h")
        # engine: bar b = first bar >= settle (searchsorted left on the FULL bar index), charged if 0<b<T
        b = idx.searchsorted(settle, side="left")
        p = perp_pos[sym]
        for ev, st, bi_, r in zip(f.index, settle, b, f.to_numpy(float), strict=True):
            bi = int(bi_)
            if bi <= 0 or bi >= len(idx):
                continue
            bar = idx[bi]
            if bar <= pos_idx[0] or bar > pos_idx[-1]:
                continue
            prev = idx[bi - 1]
            n = float(p.get(prev, 0.0))
            if n == 0.0 or not np.isfinite(n):
                continue
            rows.append({"event_ts": ev, "settle_ts": st, "charge_bar": bar, "symbol": sym, "notional": n,
                         "rate": float(r), "paid": n * float(r)})
    return pd.DataFrame(rows)


def funding_intervals(funding: pd.DataFrame) -> pd.DataFrame:
    """Contiguous stretches of constant settlement interval per symbol (hours)."""
    rows: list[dict[str, Any]] = []
    for sym in funding.columns:
        f = funding[sym].dropna()
        if len(f) < 2:
            continue
        ts = pd.DatetimeIndex(f.index).round("h")
        dh = pd.Series((ts[1:] - ts[:-1]) / pd.Timedelta(hours=1), index=ts[1:])
        grp = (dh != dh.shift()).cumsum()
        for _, g in dh.groupby(grp):
            rows.append({"symbol": sym, "interval_h": float(g.iloc[0]), "start": g.index[0] - pd.Timedelta(
                hours=float(g.iloc[0])), "end": g.index[-1], "n_events": len(g)})
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- data sanity
def runs(mask: pd.Series, min_len: int = 1) -> pd.DataFrame:
    """Contiguous True runs of a boolean series: first, last, n."""
    m = mask.fillna(False).astype(bool)
    rows: list[dict[str, Any]] = []
    g = (m != m.shift()).cumsum()
    for _, s in m[m].groupby(g[m]):
        if len(s) >= min_len:
            rows.append({"first": s.index[0], "last": s.index[-1], "n": len(s)})
    return pd.DataFrame(rows, columns=["first", "last", "n"])


def frozen_mask(open_: pd.Series, high: pd.Series, low: pd.Series, close: pd.Series,
                volume: pd.Series) -> pd.Series:
    """'Real' bars (is_filled=False) that carry no trading: zero volume and o=h=l=c=previous close."""
    flat = (open_ == high) & (high == low) & (low == close) & (close == close.shift(1))
    return (volume.fillna(0.0) == 0) & flat


def trade_flags(trades: pd.DataFrame, data: Dataset) -> pd.DataFrame:
    """Annotate each trade with the state of its fill bar: stale (is_filled), frozen (zero-volume flat
    'real' bar), after the last real bar, price != bar open (normal trades), forced-exit price vs last
    REAL (non-filled) close."""
    if not len(trades):
        return trades.assign(stale=[], frozen=[], after_last_real=[], px_mismatch=[])
    out = trades.copy()
    out["ts"] = pd.DatetimeIndex(out["ts"])
    stale, frozen, after, mism, last_real_close = [], [], [], [], []
    cache: dict[tuple[str, str], tuple[pd.Series, pd.Series, pd.Series, Any]] = {}
    rec: Any
    for rec in out.itertuples(index=False):
        key = (str(rec.market), str(rec.symbol))
        if key not in cache:
            md = data.market(rec.market)  # type: ignore[arg-type]
            s = rec.symbol
            fil = md.is_filled[s] if s in md.is_filled else pd.Series(dtype=bool)
            fz = frozen_mask(md.open[s], md.high[s], md.low[s], md.close[s], md.volume[s]) \
                if s in md.close else pd.Series(dtype=bool)
            real_close = md.close[s].where(~fil) if s in md.close else pd.Series(dtype=float)
            lr = real_close.last_valid_index()
            cache[key] = (fil, fz, real_close, lr)
        fil, fz, real_close, lr = cache[key]
        ts = rec.ts
        md = data.market(rec.market)  # type: ignore[arg-type]
        stale.append(bool(fil.get(ts, True)) if rec.side != "forced_exit" else False)
        frozen.append(bool(fz.get(ts, False)) if rec.side != "forced_exit" else False)
        after.append(bool(lr is not None and ts > lr + pd.Timedelta(hours=1)) and rec.side != "forced_exit")
        if rec.side == "forced_exit":
            lrc = real_close.loc[:ts].dropna()
            v = float(lrc.iloc[-1]) if len(lrc) else np.nan
            last_real_close.append(v)
            mism.append(bool(np.isfinite(v) and abs(float(rec.price) / v - 1) > 1e-9))
        else:
            o = md.open[rec.symbol].get(ts, np.nan) if rec.symbol in md.open else np.nan
            last_real_close.append(np.nan)
            mism.append(bool(not np.isfinite(o) or abs(float(rec.price) / float(o) - 1) > 1e-9))
    out["stale_bar"] = stale
    out["frozen_bar"] = frozen
    out["after_last_real_bar"] = after
    out["price_mismatch"] = mism
    out["last_real_close"] = last_real_close
    return out


def implausible_bars(data: Dataset, thresh: float = 0.5) -> pd.DataFrame:
    """Real bars with |close/prev close - 1| > thresh, or |open/prev close - 1| > thresh."""
    rows = []
    for m in ("spot", "perp"):
        md = data.market(m)  # type: ignore[arg-type]
        real = ~md.is_filled
        pc = md.close.shift(1)
        rc = md.close / pc - 1.0
        ro = md.open / pc - 1.0
        bad = ((rc.abs() > thresh) | (ro.abs() > thresh)) & real
        for ts, sym in zip(*np.nonzero(bad.to_numpy()), strict=True):
            t = md.close.index[ts]
            s = md.close.columns[sym]
            rows.append({"market": m, "symbol": s, "ts": t, "prev_close": pc.iat[ts, sym],
                         "open": md.open.iat[ts, sym], "close": md.close.iat[ts, sym],
                         "ret_close": rc.iat[ts, sym], "ret_open_gap": ro.iat[ts, sym]})
    return pd.DataFrame(rows)


def equity_identity(res: BacktestResult) -> pd.Series:
    """Per-bar residual of  equity_t = cash_t + sum positions_t  rebuilt from flows only:
    cash_t = cap - cum(traded) - cum(costs) - cum(funding). Should be ~0 everywhere."""
    cap = float(res.meta["initial_capital"])
    tr = res.trades
    traded = (tr.groupby("ts")["qty_notional"].sum() if len(tr) else pd.Series(dtype=float))
    traded.index = pd.DatetimeIndex(traded.index)
    traded = traded.reindex(res.equity.index).fillna(0.0)
    c = res.costs[["fees", "spread", "impact", "funding"]].sum(axis=1)
    cash = cap - traded.cumsum() - c.cumsum()
    pos = sum((p.sum(axis=1) for p in res.positions.values()), pd.Series(0.0, index=res.equity.index))
    return (cash + pos - res.equity).where(res.equity > 0, 0.0)

