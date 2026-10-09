"""Performance metrics on hourly simple-return series (UTC index)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def _clean(returns: pd.Series) -> pd.Series:
    r = pd.Series(returns, dtype=float).dropna()
    return r.sort_index()


def _compound(r: pd.Series) -> float:
    return float(np.prod(1.0 + r.to_numpy()) - 1.0) if len(r) else 0.0


def _resample_compound(returns: pd.Series, rule: str) -> pd.Series:
    r = _clean(returns)
    out = (1.0 + r).resample(rule).prod() - 1.0
    counts = r.resample(rule).count()
    return out[counts > 0]


def daily_returns(returns: pd.Series) -> pd.Series:
    """Compound hourly returns into UTC calendar-day returns."""
    return _resample_compound(returns, "1D")


def drawdown_series(returns: pd.Series) -> pd.Series:
    """Drawdown (<= 0) of the compounded equity curve, relative to the running peak (start = 1)."""
    r = _clean(returns)
    eq = (1.0 + r).cumprod()
    peak = np.maximum(eq.cummax(), 1.0)
    return pd.Series(eq / peak - 1.0, index=r.index)


def monthly_returns(returns: pd.Series) -> pd.DataFrame:
    """Year x month (1..12) table of compounded returns, plus a compounded 'Year' column."""
    r = _clean(returns)
    if r.empty:
        return pd.DataFrame(columns=[*range(1, 13), "Year"], dtype=float)
    m = _resample_compound(r, "MS")
    idx = pd.DatetimeIndex(m.index)
    table = pd.DataFrame({"year": idx.year, "month": idx.month, "ret": m.to_numpy()})
    out = table.pivot(index="year", columns="month", values="ret").reindex(columns=range(1, 13))
    out["Year"] = yearly_returns(r).reindex(out.index).to_numpy()
    out.index.name = None
    out.columns.name = None
    return out


def yearly_returns(returns: pd.Series) -> pd.Series:
    """Compounded calendar-year returns indexed by integer year."""
    y = _resample_compound(returns, "YS")
    return pd.Series(y.to_numpy(), index=pd.DatetimeIndex(y.index).year, dtype=float)


def _round_trip_pnls(trades: pd.DataFrame) -> pd.Series | None:
    """Pair entries/exits per (market, symbol): a round trip closes when the position returns to 0.

    PnL of a round trip = -sum(signed notional cash flows) - costs. Returns None if columns missing.
    """
    need = {"symbol", "side", "qty_notional", "price"}
    if not need.issubset(trades.columns) or trades.empty:
        return None
    t = trades.copy()
    if "ts" in t.columns:
        t = t.sort_values("ts", kind="stable")
    side = t["side"].astype(str).str.lower()
    sign = np.where(side.isin(["buy", "long", "b", "1"]), 1.0, -1.0)
    notional = t["qty_notional"].astype(float).abs().to_numpy() * sign
    units = notional / t["price"].astype(float).to_numpy()
    cost = np.zeros(len(t))
    for c in ("fee", "spread", "impact"):
        if c in t.columns:
            cost += t[c].fillna(0.0).astype(float).to_numpy()
    keys = t["symbol"].astype(str)
    if "market" in t.columns:
        keys = t["market"].astype(str) + ":" + keys
    pnls: list[float] = []
    state: dict[str, list[float]] = {}
    for k, u, n, fc in zip(keys.tolist(), units, notional, cost, strict=True):
        pos, cash = state.get(k, [0.0, 0.0])
        new_pos = pos + u
        cash += -n - fc
        if pos != 0.0 and (abs(new_pos) < 1e-9 * max(abs(pos), 1.0) or np.sign(new_pos) != np.sign(pos)):
            if abs(new_pos) < 1e-9 * max(abs(pos), 1.0):
                pnls.append(cash)
                state[k] = [0.0, 0.0]
            else:  # flip: close at this price, remainder opens a new trip
                price = n / u if u != 0 else 0.0
                carry = new_pos * price  # notional of the residual open position
                pnls.append(cash + carry)
                state[k] = [new_pos, -carry]
            continue
        state[k] = [new_pos, cash]
    return pd.Series(pnls, dtype=float) if pnls else None


def _trade_stats(pnls: pd.Series) -> dict[str, float]:
    wins, losses = pnls[pnls > 0], pnls[pnls < 0]
    gross_loss = -losses.sum()
    return {
        "hit_rate": float((pnls > 0).mean()) if len(pnls) else float("nan"),
        "expectancy": float(pnls.mean()) if len(pnls) else float("nan"),
        "profit_factor": float(wins.sum() / gross_loss) if gross_loss > 0 else float("inf"),
        "n_trades": float(len(pnls)),
    }


def performance_summary(
    returns: pd.Series,
    trades: pd.DataFrame | None = None,
    periods_per_year: int = 8760,
    positions: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """Headline statistics. `returns` are hourly simple returns (UTC index)."""
    r = _clean(returns)
    n = len(r)
    total = _compound(r)
    years = n / periods_per_year if n else float("nan")
    cagr = (1.0 + total) ** (1.0 / years) - 1.0 if n and total > -1 else float("nan")
    mu, sd = float(r.mean()) if n else float("nan"), float(r.std(ddof=1)) if n > 1 else float("nan")
    ann_vol = sd * np.sqrt(periods_per_year)
    sharpe = mu / sd * np.sqrt(periods_per_year) if sd and sd > 0 else float("nan")
    downside = np.sqrt(np.mean(np.minimum(r.to_numpy(), 0.0) ** 2)) if n else float("nan")
    sortino = mu / downside * np.sqrt(periods_per_year) if downside > 0 else float("nan")

    dd = drawdown_series(r)
    max_dd = float(dd.min()) if n else 0.0
    dd_start = dd_end = dd_trough = None
    dd_duration = pd.Timedelta(0)
    if n and max_dd < 0:
        dd_trough = dd.idxmin()
        before = dd.loc[:dd_trough]
        at_peak = before[before >= 0]
        dd_start = at_peak.index[-1] if len(at_peak) else r.index[0]
        after = dd.loc[dd_trough:]
        rec = after[after >= 0]
        dd_end = rec.index[0] if len(rec) else None
        dd_duration = (dd_end if dd_end is not None else r.index[-1]) - dd_start
    calmar = cagr / abs(max_dd) if max_dd < 0 else float("nan")

    d = daily_returns(r)
    m = _resample_compound(r, "MS")
    out: dict[str, Any] = {
        "total_return": total,
        "cagr": cagr,
        "ann_vol": ann_vol,
        "sharpe": sharpe,
        "sortino": sortino,
        "calmar": calmar,
        "max_drawdown": max_dd,
        "max_dd_start": dd_start,
        "max_dd_trough": dd_trough,
        "max_dd_end": dd_end,
        "max_dd_duration": dd_duration,
        "worst_day": float(d.min()) if len(d) else float("nan"),
        "worst_month": float(m.min()) if len(m) else float("nan"),
        "best_month": float(m.max()) if len(m) else float("nan"),
        "pct_positive_months": float((m > 0).mean()) if len(m) else float("nan"),
        "n_periods": n,
    }
    pnls = _round_trip_pnls(trades) if trades is not None else None
    if pnls is not None:
        out.update(_trade_stats(pnls))
        out["trade_basis"] = "round_trip"
    else:
        out.update(_trade_stats(d[d != 0]))
        out["trade_basis"] = "daily_return"
    if positions is not None and len(positions):
        out["exposure"] = float((positions.fillna(0.0).abs().sum(axis=1) > 0).mean())
    else:
        out["exposure"] = float((r != 0).mean()) if n else float("nan")
    return out
