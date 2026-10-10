"""Explicit NO TRADE gate with enumerated reasons. Every check that fails is reported (not just the first)."""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from enum import StrEnum

import pandas as pd

from engine.research.contract import Prediction


class NoTradeReason(StrEnum):
    INSUFFICIENT_EDGE = "insufficient_edge"
    EXCESSIVE_SPREAD = "excessive_spread"
    POOR_LIQUIDITY = "poor_liquidity"
    MODEL_DISAGREEMENT = "model_disagreement"
    UNCERTAIN_REGIME = "uncertain_regime"
    STALE_DATA = "stale_data"
    RISK_LIMITS = "risk_limits"
    POOR_MODEL_HEALTH = "poor_model_health"
    EXCESSIVE_CORRELATION = "excessive_correlation"
    INSUFFICIENT_CONFIDENCE = "insufficient_confidence"


@dataclass(frozen=True)
class NoTradeConfig:
    min_net_edge: float = 0.0
    max_half_spread_bps: float = 10.0
    min_adv_quote: float = 1e6
    max_disagreement: float = 0.5
    min_regime_prob: float = 0.6
    max_data_age_hours: float = 2.0
    min_model_health: float = 0.5
    max_portfolio_corr: float = 0.8
    min_confidence: float = 0.52
    require_calibrated: bool = True     # NaN confidence => NO TRADE


@dataclass(frozen=True)
class TradeContext:
    now: pd.Timestamp
    last_data_time: pd.Timestamp | None = None
    half_spread_bps: float = 0.0
    adv_quote: float | None = None
    regime_prob: float = 1.0            # P(current regime label); low => uncertain
    model_health: float = 1.0           # e.g. rolling live/OOS hit-rate ratio in [0,1]
    corr_to_book: float = 0.0           # |corr| of this trade with existing book
    risk_halt: bool = False             # from engine.live.risk.check_risk(...).halt
    risk_reasons: tuple[str, ...] = ()


@dataclass
class NoTradeDecision:
    trade: bool
    reasons: list[NoTradeReason] = field(default_factory=list)
    details: list[str] = field(default_factory=list)


def evaluate(pred: Prediction, ctx: TradeContext, cfg: NoTradeConfig | None = None) -> NoTradeDecision:
    cfg = cfg or NoTradeConfig()
    d = NoTradeDecision(trade=True)

    def fail(r: NoTradeReason, msg: str) -> None:
        d.reasons.append(r)
        d.details.append(f"{r.value}: {msg}")

    ne = pred.expected_net_edge
    if pred.direction == 0 or not math.isfinite(ne) or ne < cfg.min_net_edge or ne <= 0:
        fail(NoTradeReason.INSUFFICIENT_EDGE, f"net edge {ne} (direction {pred.direction})")
    if ctx.half_spread_bps > cfg.max_half_spread_bps:
        fail(NoTradeReason.EXCESSIVE_SPREAD, f"{ctx.half_spread_bps:.2f}bps > {cfg.max_half_spread_bps}")
    if ctx.adv_quote is None or not math.isfinite(ctx.adv_quote) or ctx.adv_quote < cfg.min_adv_quote:
        fail(NoTradeReason.POOR_LIQUIDITY, f"ADV {ctx.adv_quote} < {cfg.min_adv_quote}")
    disp = pred.features.get("sign_dispersion", 0.0)
    if disp > cfg.max_disagreement:
        fail(NoTradeReason.MODEL_DISAGREEMENT, f"sign dispersion {disp:.2f} > {cfg.max_disagreement}")
    if ctx.regime_prob < cfg.min_regime_prob:
        fail(NoTradeReason.UNCERTAIN_REGIME, f"regime prob {ctx.regime_prob:.2f} < {cfg.min_regime_prob}")
    if ctx.last_data_time is None:
        fail(NoTradeReason.STALE_DATA, "no data")
    else:
        age = (ctx.now - ctx.last_data_time) / pd.Timedelta(hours=1)
        if age > cfg.max_data_age_hours:
            fail(NoTradeReason.STALE_DATA, f"data age {age:.1f}h > {cfg.max_data_age_hours}h")
    if ctx.risk_halt:
        fail(NoTradeReason.RISK_LIMITS, "; ".join(ctx.risk_reasons) or "risk halt")
    if ctx.model_health < cfg.min_model_health:
        fail(NoTradeReason.POOR_MODEL_HEALTH, f"health {ctx.model_health:.2f} < {cfg.min_model_health}")
    if abs(ctx.corr_to_book) > cfg.max_portfolio_corr:
        fail(NoTradeReason.EXCESSIVE_CORRELATION, f"|corr| {ctx.corr_to_book:.2f} > {cfg.max_portfolio_corr}")
    c = pred.confidence
    if not math.isfinite(c):
        if cfg.require_calibrated:
            fail(NoTradeReason.INSUFFICIENT_CONFIDENCE, "uncalibrated (NaN) confidence")
    elif c < cfg.min_confidence:
        fail(NoTradeReason.INSUFFICIENT_CONFIDENCE, f"confidence {c:.3f} < {cfg.min_confidence}")
    d.trade = not d.reasons
    return d


def gate(pred: Prediction, ctx: TradeContext,
         cfg: NoTradeConfig | None = None) -> tuple[Prediction, NoTradeDecision]:
    """Apply the gate: on NO TRADE returns pred with direction=0 and the reasons joined in `reason`."""
    dec = evaluate(pred, ctx, cfg)
    if dec.trade:
        return pred, dec
    return replace(pred, direction=0, reason=" | ".join(dec.details)), dec
