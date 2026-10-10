"""Expected net edge = |E[gross return]| - fees - spread - slippage - impact - funding - buffer.

All cost terms are fractions of notional over the ROUND TRIP (entry + exit). Fees, half-spread and
square-root impact come from `engine.costs.CostModel` (its parameters are reused, never changed).
Slippage (beyond half-spread), expected funding and the adverse-move buffer are extra inputs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import cast

from engine.contracts import Market
from engine.costs import CostModel
from engine.research.contract import Direction, Prediction


@dataclass(frozen=True)
class MarketState:
    cost_model: CostModel
    market: str = "perp"                    # "spot" | "perp"
    notional: float = 10_000.0              # intended trade size (quote)
    price: float = 1.0
    adv_quote: float | None = None          # daily quote volume (None -> worst-case participation)
    daily_vol: float | None = None
    funding_rate_per_8h: float = 0.0        # expected perp funding; positive => longs pay
    slippage_bps: float = 0.0               # per side, beyond half-spread
    adverse_buffer: float = 0.0             # fraction; safety margin for adverse selection
    min_net_edge: float = 0.0               # NO TRADE if net edge < this (fraction)


@dataclass(frozen=True)
class EdgeBreakdown:
    fees: float
    spread: float
    slippage: float
    impact: float
    funding: float
    buffer: float

    @property
    def total(self) -> float:
        return self.fees + self.spread + self.slippage + self.impact + self.funding + self.buffer


def cost_breakdown(direction: int, horizon_hours: int, ms: MarketState, symbol: str) -> EdgeBreakdown:
    """Round-trip cost fractions for a position of sign `direction` held `horizon_hours`."""
    n = abs(ms.notional)
    if n == 0:
        return EdgeBreakdown(0.0, 0.0, 0.0, 0.0, 0.0, ms.adverse_buffer)
    one = ms.cost_model.trade_cost(symbol, cast(Market, ms.market), n, ms.price, ms.adv_quote, ms.daily_vol)
    fees, spread, impact = 2 * one.fees / n, 2 * one.spread / n, 2 * one.impact / n
    slip = 2 * ms.slippage_bps * 1e-4 * ms.cost_model.multiplier
    funding = 0.0
    if ms.market == "perp":
        # longs pay positive funding, shorts pay negative funding; conservatively never credited.
        funding = max(direction * ms.funding_rate_per_8h * horizon_hours / 8.0, 0.0)
    return EdgeBreakdown(fees, spread, slip, impact, funding, ms.adverse_buffer)


def apply_edge(pred: Prediction, market_state: MarketState) -> Prediction:
    """Fill expected_cost / expected_net_edge; direction=0 with reason if net edge < threshold."""
    er = pred.expected_return
    if not math.isfinite(er) or er == 0.0:
        return replace(pred, direction=0, expected_cost=float("nan"), expected_net_edge=float("nan"),
                       reason="insufficient_edge: no expected return")
    d: Direction = 1 if er > 0 else -1
    bd = cost_breakdown(d, pred.horizon_hours, market_state, pred.asset)
    net = abs(er) - bd.total
    if net < market_state.min_net_edge or net <= 0:
        return replace(pred, direction=0, expected_cost=bd.total, expected_net_edge=net,
                       reason=f"insufficient_edge: net {net:.5f} < threshold {market_state.min_net_edge:.5f}"
                              f" (|ER| {abs(er):.5f}, cost {bd.total:.5f})")
    return replace(pred, direction=d, expected_cost=bd.total, expected_net_edge=net)


def marginal_edge(expected_return: float, w_current: float, w_target: float, equity: float,
                  ms: MarketState, symbol: str, horizon_hours: int) -> tuple[float, float]:
    """(net edge, cost) as fractions of the TRADED notional for moving w_current -> w_target.

    Unlike `apply_edge` (a round trip from flat), the cost here is the ONE-WAY marginal turnover cost
    of |w_target - w_current| * equity, and the expected gain is the asset's expected return over the
    sleeve's holding horizon in the direction of the change. A continuation (no weight change) costs
    nothing and returns (0.0, 0.0): callers must never veto an unchanged position for edge (O8)."""
    dw = w_target - w_current
    n = abs(dw) * equity
    if n <= 1e-9 or not math.isfinite(n):
        return 0.0, 0.0
    if not math.isfinite(expected_return):
        return float("nan"), float("nan")
    one = ms.cost_model.trade_cost(symbol, cast(Market, ms.market), n, ms.price, ms.adv_quote, ms.daily_vol)
    d = 1 if dw > 0 else -1
    cost = one.total / n + ms.slippage_bps * 1e-4 * ms.cost_model.multiplier + ms.adverse_buffer
    if ms.market == "perp":
        cost += max(d * ms.funding_rate_per_8h * horizon_hours / 8.0, 0.0)
    return d * expected_return - cost, cost
