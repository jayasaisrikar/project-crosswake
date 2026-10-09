"""Combine sleeve backtests and build simple benchmarks."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from engine.backtest.engine import CostModelLike, run_backtest
from engine.contracts import MARKETS, BacktestResult, Dataset, TargetWeights


def combine(
    results: dict[str, BacktestResult], allocation: dict[str, float], initial_capital: float
) -> BacktestResult:
    """Each sleeve is treated as run with initial_capital*alloc. Sleeve results are rescaled linearly from
    their own meta["initial_capital"] (exact when the sleeve was already run at that capital)."""
    if not results:
        raise ValueError("no sleeves")
    idx = pd.DatetimeIndex(sorted(set().union(*[r.equity.index for r in results.values()])))
    equity = pd.Series(0.0, index=idx)
    costs = pd.DataFrame(0.0, index=idx, columns=["fees", "spread", "impact", "funding"])
    positions: dict[str, pd.DataFrame] = {}
    trades = []
    for k, r in results.items():
        cap = float(initial_capital) * float(allocation.get(k, 0.0))
        base = float(r.meta.get("initial_capital", r.equity.iloc[0] if len(r.equity) else 1.0))
        sc = cap / base if base else 0.0
        e = r.equity.reindex(idx).ffill().fillna(base) * sc if sc else pd.Series(cap, index=idx)
        equity = equity + e
        costs = costs.add(r.costs.reindex(index=idx, columns=costs.columns).fillna(0.0) * sc, fill_value=0.0)
        for m, p in r.positions.items():
            pp = p.reindex(idx).ffill().fillna(0.0) * sc
            positions[m] = pp if m not in positions else positions[m].add(pp, fill_value=0.0)
        if len(r.trades):
            t = r.trades.copy()
            for c in ("qty_notional", "fee", "spread", "impact"):
                t[c] = t[c] * sc
            t["sleeve"] = k
            trades.append(t)
    prev = equity.shift(1, fill_value=float(initial_capital))
    returns = (equity / prev - 1.0).where(prev > 0, 0.0)
    tcols = ["ts", "symbol", "market", "side", "qty_notional", "price", "fee", "spread", "impact", "sleeve"]
    if trades:
        trades_df = pd.concat(trades, ignore_index=True).sort_values("ts", kind="stable")
    else:
        trades_df = pd.DataFrame(columns=tcols)
    meta = {
        "initial_capital": float(initial_capital),
        "allocation": dict(allocation),
        "sleeves": {k: r.meta for k, r in results.items()},
        "n_trades": len(trades_df),
        "ruined": bool(equity.min() <= 0) if len(equity) else False,
    }
    return BacktestResult("combined", equity.rename("equity"), returns.rename("returns"), positions,
                          trades_df.reset_index(drop=True), costs, meta)


@dataclass
class _BuyHold:
    symbol: str
    market: str
    name: str = "buy_hold"

    def target_weights(self, data: Dataset) -> TargetWeights:
        frames = {}
        for m in MARKETS:
            c = data.market(m).close
            if m == self.market and self.symbol in c.columns:
                first = c[self.symbol].first_valid_index()
                frames[m] = pd.DataFrame({self.symbol: [1.0]}, index=pd.DatetimeIndex([first]))
            else:
                frames[m] = pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC"))
        return TargetWeights(spot=frames["spot"], perp=frames["perp"])


def benchmark_buy_hold(
    data: Dataset,
    symbol: str = "BTC",
    market: str = "spot",
    initial_capital: float = 100_000.0,
    cost_model: CostModelLike | None = None,
    start: object = None,
    end: object = None,
) -> BacktestResult:
    if cost_model is None:
        raise ValueError("cost_model required")
    strat = _BuyHold(symbol, market, name=f"buy_hold_{market}_{symbol}")
    return run_backtest(strat, data, cost_model, initial_capital, start=start, end=end, name=strat.name)
