"""Per-trade scorecard and pass/fail gate for a PAPER ledger (data/paper/<version>/).

Trades are rebuilt from the append-only fills.jsonl. A trade opens when a (market, symbol) position
leaves zero and closes when it returns to zero; a sign flip closes one trade and opens the next.
Rebalance trims/adds stay inside the open trade (average-cost accounting). Trade PnL is net of fees,
spread, impact and the funding paid while it was open. Trade return = PnL / largest notional held.

The gate is judged on the equity curve (daily returns) and on closed trades, and returns
PENDING until the minimum sample exists - never a verdict on too little data.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import pandas as pd

EPS = 1e-9


@dataclass
class Trade:
    market: str
    symbol: str
    side: str                       # "long" | "short"
    opened: str
    closed: str | None = None
    entry_price: float = 0.0        # average entry price
    exit_price: float | None = None
    qty: float = 0.0                # current signed qty (0 once closed)
    max_notional: float = 0.0
    realized: float = 0.0           # price PnL realized so far
    costs: float = 0.0
    funding: float = 0.0            # paid (+) / received (-)
    n_fills: int = 0

    @property
    def pnl(self) -> float:
        return self.realized - self.costs - self.funding

    @property
    def ret(self) -> float:
        return self.pnl / self.max_notional if self.max_notional > EPS else 0.0

    def unrealized(self, price: float | None) -> float:
        if price is None or not math.isfinite(price) or abs(self.qty) < EPS:
            return 0.0
        return self.qty * (price - self.entry_price)

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "pnl": self.pnl, "ret": self.ret}


def build_trades(fills: list[dict[str, Any]]) -> tuple[list[Trade], list[Trade]]:
    """Returns (closed, open) trades from ledger fill records (incl. funding rows)."""
    closed: list[Trade] = []
    open_: dict[tuple[str, str], Trade] = {}
    for f in sorted(fills, key=lambda r: (str(r.get("ts")), r.get("side") == "funding")):
        key = (str(f["market"]), str(f["symbol"]))
        tr = open_.get(key)
        if f.get("side") == "funding":
            if tr is not None:
                tr.funding += float(f.get("cost", 0.0))
            continue
        dq, px, cost = float(f["qty"]), float(f["price"]), float(f.get("cost", 0.0))
        if abs(dq) < EPS:
            continue
        ts = str(f["ts"])
        if tr is None:
            tr = open_[key] = Trade(key[0], key[1], "long" if dq > 0 else "short", ts)
        if tr.qty == 0 or (tr.qty > 0) == (dq > 0):            # open / add
            new_q = tr.qty + dq
            tr.entry_price = (tr.entry_price * tr.qty + px * dq) / new_q
            tr.qty, tr.costs, tr.n_fills = new_q, tr.costs + cost, tr.n_fills + 1
            tr.max_notional = max(tr.max_notional, abs(new_q * px))
            continue
        close_q = min(abs(dq), abs(tr.qty))                     # reduce / close / flip
        share = close_q / abs(dq)
        tr.realized += close_q * (px - tr.entry_price) * (1 if tr.qty > 0 else -1)
        tr.costs += cost * share
        tr.n_fills += 1
        tr.qty += math.copysign(close_q, dq)
        if abs(tr.qty * px) < 1e-6:
            tr.qty, tr.closed, tr.exit_price = 0.0, ts, px
            closed.append(open_.pop(key))
            rest = dq - math.copysign(close_q, dq)
            if abs(rest) > EPS:                                 # flip -> new trade, remaining cost
                nt = open_[key] = Trade(key[0], key[1], "long" if rest > 0 else "short", ts,
                                        entry_price=px, qty=rest, max_notional=abs(rest * px),
                                        costs=cost * (1 - share), n_fills=1)
                del nt
    return closed, list(open_.values())


def _boot_ci(x: np.ndarray, n: int = 2000, seed: int = 7) -> tuple[float, float]:
    if len(x) < 2:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = rng.choice(x, size=(n, len(x)), replace=True).mean(axis=1)
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def trade_stats(closed: list[Trade]) -> dict[str, Any]:
    r = np.array([t.ret for t in closed])
    p = np.array([t.pnl for t in closed])
    wins, losses = p[p > 0], p[p <= 0]
    lo, hi = _boot_ci(r)
    return {
        "n_closed": len(closed),
        "win_rate": float((p > 0).mean()) if len(p) else float("nan"),
        "avg_win": float(r[p > 0].mean()) if len(wins) else float("nan"),
        "avg_loss": float(r[p <= 0].mean()) if len(losses) else float("nan"),
        "expectancy": float(r.mean()) if len(r) else float("nan"),
        "expectancy_ci": [lo, hi],
        "profit_factor": float(wins.sum() / -losses.sum()) if losses.sum() < 0 else
        (float("inf") if len(wins) else float("nan")),
        "total_pnl": float(p.sum()),
    }


def equity_stats(equity: list[dict[str, Any]], initial: float) -> dict[str, Any]:
    if not equity:
        return {"days": 0, "total_return": 0.0, "max_drawdown": 0.0, "sharpe": float("nan"),
                "daily_mean": float("nan"), "daily_ci": [float("nan"), float("nan")], "last": initial}
    s = pd.Series([float(e["equity"]) for e in equity],
                  index=pd.DatetimeIndex([pd.Timestamp(e["ts"]) for e in equity]))
    s = s[~s.index.duplicated(keep="last")].sort_index()
    daily = s.resample("1D").last().dropna()
    rets = pd.concat([pd.Series([initial]), daily]).pct_change().dropna().to_numpy()
    dd = float((1 - s / s.cummax().clip(lower=initial)).max())
    sd = float(rets.std(ddof=1)) if len(rets) > 1 else float("nan")
    lo, hi = _boot_ci(rets)
    return {
        "days": int((s.index[-1] - s.index[0]) / pd.Timedelta(days=1)),
        "total_return": float(s.iloc[-1] / initial - 1),
        "max_drawdown": dd,
        "sharpe": float(rets.mean() / sd * math.sqrt(365)) if sd and sd > 0 else float("nan"),
        "daily_mean": float(rets.mean()) if len(rets) else float("nan"),
        "daily_ci": [lo, hi],
        "last": float(s.iloc[-1]),
    }


@dataclass
class GateResult:
    verdict: str                    # PENDING | PASS | FAIL
    checks: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""


def evaluate_gate(gate: dict[str, Any], eq: dict[str, Any], tr: dict[str, Any]) -> GateResult:
    checks: list[dict[str, Any]] = []

    def chk(name: str, ok: bool, value: Any, need: str, sample: bool = False) -> None:
        checks.append({"check": name, "ok": bool(ok), "value": value, "need": need, "sample": sample})

    chk("live days", eq["days"] >= gate["min_days"], eq["days"], f">= {gate['min_days']}", True)
    chk("closed trades", tr["n_closed"] >= gate["min_closed_trades"], tr["n_closed"],
        f">= {gate['min_closed_trades']}", True)
    dd_ok = eq["max_drawdown"] <= gate["max_drawdown"]
    chk("max drawdown", dd_ok, eq["max_drawdown"], f"<= {gate['max_drawdown']:.0%}")
    pf = tr["profit_factor"]
    chk("profit factor", isinstance(pf, float) and not math.isnan(pf) and pf >= gate["min_profit_factor"],
        pf, f">= {gate['min_profit_factor']}")
    if gate.get("require_ci_above_zero", True):
        lo = eq["daily_ci"][0]
        chk("daily-return 95% CI above 0", not math.isnan(lo) and lo > 0, lo, "> 0")

    if not dd_ok:
        return GateResult("FAIL", checks, f"drawdown {eq['max_drawdown']:.1%} breached the gate")
    if not all(c["ok"] for c in checks if c["sample"]):
        missing = ", ".join(f"{c['check']} {c['value']} (need {c['need']})" for c in checks
                            if c["sample"] and not c["ok"])
        return GateResult("PENDING", checks, f"not enough evidence yet: {missing}")
    if all(c["ok"] for c in checks):
        return GateResult("PASS", checks, "all criteria met on live paper data")
    bad = ", ".join(c["check"] for c in checks if not c["ok"])
    return GateResult("FAIL", checks, f"sample complete but failed: {bad}")


def scorecard(fills: list[dict[str, Any]], equity: list[dict[str, Any]], initial: float,
              gate: dict[str, Any]) -> dict[str, Any]:
    from engine.live.paper import effective_fills

    closed, open_ = build_trades(effective_fills(fills))   # duplicated rows (pre-journal crash) ignored
    tr, eq = trade_stats(closed), equity_stats(equity, initial)
    g = evaluate_gate(gate, eq, tr)
    return {"trades": tr, "equity": eq, "gate": {"verdict": g.verdict, "summary": g.summary,
                                                 "checks": g.checks},
            "closed": [t.to_dict() for t in closed], "open": [t.to_dict() for t in open_]}
