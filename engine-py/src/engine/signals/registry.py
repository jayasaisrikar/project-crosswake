"""Build enabled strategies from the experiment config."""

from __future__ import annotations

from typing import Any

from engine.contracts import Strategy
from engine.signals.breakout import BreakoutStrategy
from engine.signals.carry import CarryStrategy
from engine.signals.leadlag import BtcImpulseFollow, LeadLagStrategy
from engine.signals.regime import TrendRegimeStrategy
from engine.signals.trend import TrendStrategy
from engine.signals.xsmom import XSMomStrategy

_REGISTRY: dict[str, type] = {
    "trend": TrendStrategy,
    "carry": CarryStrategy,
    "breakout": BreakoutStrategy,
    "xsmom": XSMomStrategy,
    "trend_regime": TrendRegimeStrategy,
    "leadlag": LeadLagStrategy,
    "btc_impulse": BtcImpulseFollow,
}


def build_strategies(exp_cfg: dict[str, Any]) -> list[Strategy]:
    out: list[Strategy] = []
    for name, params in exp_cfg.get("strategies", {}).items():
        if name in _REGISTRY and isinstance(params, dict) and params.get("enabled", False):
            out.append(_REGISTRY[name](params))
    return out
