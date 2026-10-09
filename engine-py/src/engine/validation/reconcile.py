"""Independent cost and P&L reconciliation of a BacktestResult.

Checks (each row of the returned table):
  * per-trade fees   == fee_bps[market] * 1e-4 * |notional| * multiplier (x forced-exit multiplier)
  * per-trade spread == half_spread(symbol, market) * 1e-4 * |notional| * multiplier (x forced mult)
  * per-trade impact == recomputed square-root impact at the decision bar (only if `data` is given)
  * trades-ledger totals (fees/spread/impact) == result.costs totals, and per bar
  * accounting identity per bar:
        d(equity) = [d(sum positions) - traded notional]  -  (fees+spread+impact)  -  funding
    i.e. net P&L = gross market P&L - costs - funding   (funding column = amount PAID)
  * (if `data` given) gross market P&L recomputed from prices: positions held into the bar earn
    open - prev close, positions after the open trade earn close - open.
Every leg (entry and exit) is a separate ledger row, so both legs are covered.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import MARKETS, BacktestResult, Dataset

FORCED_EXIT_COST_MULT = 2.0


class _Row:
    def __init__(self, d: dict[Any, Any]) -> None:
        self.__dict__.update({str(k): v for k, v in d.items()})


def _row(check: str, expected: float, actual: float, tol: float) -> dict[str, Any]:
    diff = float(actual - expected)
    return {"check": check, "expected": float(expected), "actual": float(actual), "abs_diff": abs(diff),
            "tol": tol, "ok": bool(abs(diff) <= tol)}


def reconcile(
    result: BacktestResult,
    cost_model: Any,
    data: Dataset | None = None,
    adv_days: int = 30,
    rtol: float = 1e-9,
    atol: float = 1e-6,
) -> dict[str, Any]:
    tr = result.trades
    costs = result.costs
    cap = float(result.meta.get("initial_capital", result.equity.iloc[0] if len(result.equity) else 0.0))
    tol_abs = atol + rtol * max(cap, 1.0)
    mult = float(getattr(cost_model, "multiplier", 1.0))
    rows: list[dict[str, Any]] = []
    per_trade: list[dict[str, Any]] = []

    # ---- per-trade fee / spread / impact -----------------------------------------------------
    adv_vol: dict[str, tuple[pd.DataFrame, pd.DataFrame]] = {}
    if data is not None:
        from engine.costs import rolling_adv_and_vol

        adv_vol = {m: rolling_adv_and_vol(data.market(m), adv_days) for m in MARKETS}
        bar_idx = data.spot.close.index.union(data.perp.close.index).sort_values()
    for k, rec_in in enumerate(tr.to_dict("records")):
        t: Any = _Row(rec_in)
        n = abs(float(t.qty_notional))
        fm = FORCED_EXIT_COST_MULT if t.side == "forced_exit" else 1.0
        exp_fee = cost_model.fee_bps[t.market] * 1e-4 * n * mult * fm
        exp_spr = cost_model.half_spread(t.symbol, t.market) * 1e-4 * n * mult * fm
        rec = {"trade": k, "ts": t.ts, "symbol": t.symbol, "market": t.market,
               "fee_diff": float(t.fee) - exp_fee, "spread_diff": float(t.spread) - exp_spr}
        if data is not None:
            pos = int(bar_idx.searchsorted(t.ts, side="left"))
            dec = bar_idx[max(pos - 1, 0)]
            a, v = adv_vol[t.market]
            adv = float(a[t.symbol].get(dec, np.nan)) if t.symbol in a else np.nan
            vol = float(v[t.symbol].get(dec, np.nan)) if t.symbol in v else np.nan
            adv = 0.0 if not np.isfinite(adv) else adv          # engine nan_to_num's ADV/vol
            vol = 0.0 if not np.isfinite(vol) else vol
            exp_imp = cost_model.trade_cost(t.symbol, t.market, n, float(t.price), adv, vol).impact * fm
            rec["impact_diff"] = float(t.impact) - exp_imp
        per_trade.append(rec)
    pt = pd.DataFrame(per_trade)
    for col in ("fee_diff", "spread_diff", "impact_diff"):
        if col in pt:
            worst = float(pt[col].abs().max()) if len(pt) else 0.0
            rows.append(_row(f"per_trade_max_{col}", 0.0, worst, tol_abs))

    # ---- ledger vs cost table ----------------------------------------------------------------
    for led, col in (("fee", "fees"), ("spread", "spread"), ("impact", "impact")):
        rows.append(_row(f"total_{col}", float(tr[led].sum()) if len(tr) else 0.0, float(costs[col].sum()),
                         tol_abs))
        by_bar = tr.groupby("ts")[led].sum() if len(tr) else pd.Series(dtype=float)
        gap = (costs[col] - by_bar.reindex(costs.index).fillna(0.0)).abs().max()
        rows.append(_row(f"per_bar_max_{col}_gap", 0.0, float(gap) if len(costs) else 0.0, tol_abs))

    # ---- accounting identity ---------------------------------------------------------------
    eq = result.equity
    pos_sum = sum((p.sum(axis=1) for p in result.positions.values()), pd.Series(0.0, index=eq.index))
    traded = (tr.groupby("ts")["qty_notional"].sum() if len(tr) else pd.Series(dtype=float)) \
        .reindex(eq.index).fillna(0.0)
    tcost = costs[["fees", "spread", "impact"]].sum(axis=1)
    fund = costs["funding"]
    d_eq = eq.diff()
    if len(eq):
        d_eq.iloc[0] = eq.iloc[0] - cap
    gross = pos_sum.diff().fillna(pos_sum.iloc[0] if len(pos_sum) else 0.0) - traded
    implied = gross - tcost - fund
    live = eq > 0
    resid = (d_eq - implied)[live]
    rows.append(_row("identity_max_bar_residual", 0.0, float(resid.abs().max()) if len(resid) else 0.0,
                     tol_abs))
    total_net = float(eq.iloc[-1] - cap) if len(eq) else 0.0
    rows.append(_row("identity_total_net_pnl", float(gross.sum() - tcost.sum() - fund.sum()), total_net,
                     tol_abs * max(len(eq), 1)))

    # ---- gross P&L from prices --------------------------------------------------------------
    if data is not None and len(eq):
        g_px = pd.Series(0.0, index=eq.index)
        for m in MARKETS:
            p = result.positions[m]
            if p.shape[1] == 0:
                continue
            md = data.market(m)
            full_idx = bar_idx
            c = md.close.reindex(index=full_idx, columns=p.columns).ffill()
            o = md.open.reindex(index=full_idx, columns=p.columns)
            c_prev = c.shift(1).reindex(eq.index)
            c_now = c.reindex(eq.index)
            ref = o.reindex(eq.index).where(lambda x: np.isfinite(x) & (x > 0), c_prev)
            q_now = (p / c_now).where(p != 0, 0.0).fillna(0.0)
            q_old = q_now.shift(1, fill_value=0.0)
            pnl = q_old * (ref - c_prev).fillna(0.0) + q_now * (c_now - ref).fillna(0.0)
            g_px = g_px.add(pnl.sum(axis=1), fill_value=0.0)
        gap = (g_px - gross)[live].abs().max()
        rows.append(_row("gross_pnl_from_prices_max_bar_gap", 0.0, float(gap), tol_abs))

    table = pd.DataFrame(rows)
    bad = table[~table["ok"]]
    return {
        "ok": bool(bad.empty),
        "n_discrepancies": int(len(bad)),
        "table": table,
        "discrepancies": bad.reset_index(drop=True),
        "per_trade": pt,
        "totals": {"gross_pnl": float(gross.sum()), "fees": float(costs["fees"].sum()),
                   "spread": float(costs["spread"].sum()), "impact": float(costs["impact"].sum()),
                   "funding_paid": float(fund.sum()), "net_pnl": total_net},
    }
