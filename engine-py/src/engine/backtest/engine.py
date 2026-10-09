"""Event-driven hourly backtester (integrity core).

Timing: weights decided at bar t (index ts = bar open, decision uses bar t close) are executed at the
OPEN of bar t+1. Funding events at ts are charged on positions held into ts (before any trade at the
bar opening at ts), marked at the last perp close before ts. A position opened by the fill at the open of the
settlement bar is NOT charged (fills are modelled as occurring just after the settlement snapshot).
Binance funding timestamps carry ms jitter (e.g. 08:00:00.001); they are snapped to the nearest hour.
No fills on synthesized (is_filled) bars: their price is stale, so the trade is skipped (counted in
meta["n_skipped_stale"]) and retried at the next decision. Forced exits on delisting are priced at the last
real close.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol

import numpy as np
import pandas as pd

from engine.contracts import MARKETS, BacktestResult, CostBreakdown, Dataset, MarketData, Strategy

FORCED_EXIT_COST_MULT = 2.0


class CostModelLike(Protocol):
    def trade_cost(
        self, symbol: str, market: Any, notional_abs: float, price: float, adv_quote: float, daily_vol: float
    ) -> CostBreakdown: ...


AdvVolFn = Callable[[MarketData, int], tuple[pd.DataFrame, pd.DataFrame]]


def _fallback_adv_vol(md: MarketData, days: int = 30) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Causal fallback: trailing mean daily quote volume and std of daily returns from hourly bars."""
    h = days * 24
    adv = md.quote_volume.rolling(h, min_periods=24).sum() / days
    r = md.close.pct_change(fill_method=None)
    vol = r.rolling(h, min_periods=24).std() * np.sqrt(24.0)
    return adv, vol


def _get_adv_vol_fn() -> AdvVolFn:
    try:
        from engine.costs import rolling_adv_and_vol  # type: ignore[import-not-found,unused-ignore]

        return rolling_adv_and_vol  # type: ignore[no-any-return,unused-ignore]
    except ImportError:
        return _fallback_adv_vol


def _bar_index(data: Dataset) -> pd.DatetimeIndex:
    idx = data.spot.close.index.union(data.perp.close.index)
    return pd.DatetimeIndex(idx).sort_values()


def run_backtest(
    strategy: Strategy,
    data: Dataset,
    cost_model: CostModelLike,
    initial_capital: float,
    start: Any = None,
    end: Any = None,
    name: str | None = None,
    min_trade_frac: float = 0.001,
    adv_days: int = 30,
    adv_vol_fn: AdvVolFn | None = None,
) -> BacktestResult:
    tw = strategy.target_weights(data)
    w_frames = {"spot": tw.spot, "perp": tw.perp}
    sw = w_frames["spot"]
    if sw is not None and len(sw) and (sw.fillna(0.0) < 0).any().any():
        raise ValueError("negative spot weights: spot cannot be short")

    idx = _bar_index(data)
    T = len(idx)
    fn = adv_vol_fn or _get_adv_vol_fn()

    # ---- flatten (market, symbol) into one column space -------------------------------------
    cols: list[tuple[str, str]] = []
    for m in MARKETS:
        md = data.market(m)
        syms = list(md.close.columns)
        wf = w_frames[m]
        if wf is not None:
            syms += [s for s in wf.columns if s not in syms and (wf[s].fillna(0.0) != 0).any()]
        cols += [(m, s) for s in syms]
    N = len(cols)
    opn = np.full((T, N), np.nan)
    stale = np.zeros((T, N), dtype=bool)
    cls = np.full((T, N), np.nan)
    adv = np.zeros((T, N))
    vol = np.zeros((T, N))
    W = np.full((T, N), np.nan)  # weights by decision bar
    has_dec = np.zeros(T, dtype=bool)
    for m in MARKETS:
        md = data.market(m)
        a, v = fn(md, adv_days)
        jj = [j for j, c in enumerate(cols) if c[0] == m]
        syms = [cols[j][1] for j in jj]
        opn[:, jj] = md.open.reindex(index=idx, columns=syms).to_numpy(float)
        cls[:, jj] = md.close.reindex(index=idx, columns=syms).to_numpy(float)
        stale[:, jj] = md.is_filled.reindex(index=idx, columns=syms).fillna(False).to_numpy(bool)
        adv[:, jj] = np.nan_to_num(a.reindex(index=idx, columns=syms).to_numpy(float))
        vol[:, jj] = np.nan_to_num(v.reindex(index=idx, columns=syms).to_numpy(float))
        wf = w_frames[m]
        if wf is None or not len(wf):
            continue
        pos = idx.get_indexer(pd.DatetimeIndex(wf.index))
        if (pos < 0).any():
            # decision timestamps not on the bar grid: map to the last bar at or before them
            pos = np.searchsorted(idx.values, pd.DatetimeIndex(wf.index).values, side="right") - 1
        wv = wf.reindex(columns=syms).fillna(0.0).to_numpy(float)
        ok = pos >= 0
        W[np.ix_(pos[ok], jj)] = wv[ok]
        has_dec[pos[ok]] = True
    W = np.nan_to_num(W)
    cls_ff = pd.DataFrame(cls).ffill().to_numpy()

    perp_j = np.array([j for j, c in enumerate(cols) if c[0] == "perp"], dtype=int)
    fund_ev: dict[int, np.ndarray] = {}  # bar i -> rate vector over perp_j (applied at start of bar i)
    if len(perp_j) and data.funding is not None and len(data.funding):
        fsyms = [cols[j][1] for j in perp_j]
        f = data.funding.reindex(columns=fsyms).fillna(0.0)
        # snap ms jitter (08:00:00.001) to the settlement hour; side="left" alone would push it to 09:00
        fts = pd.DatetimeIndex(f.index).round("h")
        bi = np.searchsorted(idx.values, fts.values, side="left")
        fv = f.to_numpy(float)
        for k, b in enumerate(bi):
            if 0 < b < T:
                fund_ev[int(b)] = fund_ev.get(int(b), 0.0) + fv[k]

    # ---- range -----------------------------------------------------------------------------
    i0 = 0 if start is None else int(idx.searchsorted(pd.Timestamp(start), side="left"))
    i1 = T if end is None else int(idx.searchsorted(pd.Timestamp(end), side="right"))

    qty = np.zeros(N)
    cash = float(initial_capital)
    eq_arr = np.full(T, np.nan)
    pos_arr = np.zeros((T, N))
    c_fee = np.zeros(T)
    c_spr = np.zeros(T)
    c_imp = np.zeros(T)
    c_fund = np.zeros(T)
    trades: list[tuple] = []
    turnover = 0.0
    ruined = False
    n_skipped_stale = 0
    cost_mult = float(getattr(cost_model, "multiplier", getattr(cost_model, "stress_multiplier", 1.0)))

    def _cost(j: int, notional: float, price: float, dec: int) -> CostBreakdown:
        m, s = cols[j]
        return cost_model.trade_cost(s, m, abs(notional), price, float(adv[dec, j]), float(vol[dec, j]))

    last_i = i0
    for i in range(i0, i1):
        last_i = i
        # 1) funding on positions held into this bar's open
        if i in fund_ev and len(perp_j):
            q = qty[perp_j]
            if np.any(q != 0):
                mark = np.nan_to_num(cls_ff[i - 1, perp_j])
                pay = float(np.sum(q * mark * fund_ev[i]))
                cash -= pay
                c_fund[i] += pay
        # 2) execute decision from bar i-1 at open of bar i
        if i > i0 and has_dec[i - 1]:
            px = opn[i]
            ref = np.where(np.isnan(px), cls_ff[i - 1], px)
            equity = cash + float(np.nansum(qty * np.nan_to_num(ref)))
            if equity > 0:
                tgt = W[i - 1] * equity
                for j in range(N):
                    p = px[j]
                    if not np.isfinite(p) or p <= 0:
                        continue
                    diff = tgt[j] - qty[j] * p
                    if abs(diff) < min_trade_frac * equity or diff == 0:
                        continue
                    if stale[i, j]:
                        n_skipped_stale += 1
                        continue
                    cb = _cost(j, diff, p, i - 1)
                    cash -= diff + cb.fees + cb.spread + cb.impact
                    qty[j] += diff / p
                    if abs(qty[j] * p) < 1e-9 * equity:
                        qty[j] = 0.0
                    c_fee[i] += cb.fees
                    c_spr[i] += cb.spread
                    c_imp[i] += cb.impact
                    turnover += abs(diff)
                    trades.append((idx[i], cols[j][1], cols[j][0], "buy" if diff > 0 else "sell",
                                   diff, p, cb.fees, cb.spread, cb.impact))
        # 3) forced exits on delisting (close NaN while holding)
        c = cls[i]
        dead = np.nonzero((qty != 0) & np.isnan(c))[0]
        for j in dead:
            p = cls_ff[i, j] if np.isfinite(cls_ff[i, j]) else 0.0
            notional = -qty[j] * p
            cb = _cost(int(j), notional, p, max(i - 1, 0)) if p > 0 else CostBreakdown()
            fee, spr, imp = (FORCED_EXIT_COST_MULT * cb.fees, FORCED_EXIT_COST_MULT * cb.spread,
                             FORCED_EXIT_COST_MULT * cb.impact)
            cash -= notional + fee + spr + imp
            qty[j] = 0.0
            c_fee[i] += fee
            c_spr[i] += spr
            c_imp[i] += imp
            turnover += abs(notional)
            trades.append((idx[i], cols[j][1], cols[j][0], "forced_exit", notional, p, fee, spr, imp))
        # 4) mark to market at close
        notion = qty * np.nan_to_num(cls_ff[i])
        pos_arr[i] = notion
        eq = cash + float(notion.sum())
        if eq <= 0:
            ruined = True
            qty[:] = 0.0
            pos_arr[i] = 0.0
            eq_arr[i] = 0.0
            eq_arr[i + 1 : i1] = 0.0
            break
        eq_arr[i] = eq

    rng = idx[i0:i1]
    equity_s = pd.Series(eq_arr[i0:i1], index=rng, name="equity")
    prev = equity_s.shift(1, fill_value=float(initial_capital))
    returns = (equity_s / prev - 1.0).where(prev > 0, 0.0).rename("returns")
    positions: dict[str, pd.DataFrame] = {}
    for m in MARKETS:
        jj = [j for j, c in enumerate(cols) if c[0] == m]
        positions[m] = pd.DataFrame(pos_arr[i0:i1][:, jj], index=rng, columns=[cols[j][1] for j in jj])
    trades_df = pd.DataFrame(
        trades, columns=["ts", "symbol", "market", "side", "qty_notional", "price", "fee", "spread", "impact"]
    )
    costs = pd.DataFrame(
        {"fees": c_fee[i0:i1], "spread": c_spr[i0:i1], "impact": c_imp[i0:i1], "funding": c_fund[i0:i1]},
        index=rng,
    )
    gross = sum((p.abs().sum(axis=1) for p in positions.values()), pd.Series(0.0, index=rng))
    net = sum((p.sum(axis=1) for p in positions.values()), pd.Series(0.0, index=rng))
    eq_safe = equity_s.where(equity_s > 0)
    gl = (gross / eq_safe).dropna()
    nl = (net / eq_safe).dropna()
    years = max(len(rng) / 8760.0, 1e-9)
    meta: dict[str, Any] = {
        "strategy": getattr(strategy, "name", type(strategy).__name__),
        "initial_capital": float(initial_capital),
        "params": {"min_trade_frac": min_trade_frac, "adv_days": adv_days, "start": str(start),
                   "end": str(end),
                   "forced_exit_cost_mult": FORCED_EXIT_COST_MULT},
        "cost_multiplier": cost_mult,
        "n_trades": len(trades_df),
        "n_forced_exits": int((trades_df["side"] == "forced_exit").sum()) if len(trades_df) else 0,
        "turnover": turnover,
        "turnover_annual": float(turnover / float(initial_capital) / years),
        "exposure": {
            "gross_mean": float(gl.mean()) if len(gl) else 0.0,
            "gross_max": float(gl.max()) if len(gl) else 0.0,
            "net_mean": float(nl.mean()) if len(nl) else 0.0,
            "time_in_market": float((gl > 1e-9).mean()) if len(gl) else 0.0,
        },
        "n_skipped_stale": n_skipped_stale,
        "ruined": ruined,
        "last_bar": str(idx[last_i]) if T else None,
    }
    return BacktestResult(
        name=str(name or getattr(strategy, "name", "backtest")),
        equity=equity_s,
        returns=returns,
        positions=positions,
        trades=trades_df,
        costs=costs,
        meta=meta,
    )
