"""Model registry: model_id -> (factory, default params, perturbation grid)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import product
from typing import Any

from engine.models import baseline, rules, statistical, stubs
from engine.research.contract import SignalModel


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    family: str
    level: str                                   # "baseline" | "L1" | "L2" | "stub"
    factory: Callable[..., Any]
    defaults: dict[str, Any]
    grid: dict[str, list[Any]] = field(default_factory=dict)


def _spec(cls: Any, level: str, grid: dict[str, list[Any]] | None = None) -> ModelSpec:
    defaults = dict(getattr(cls, "default_params", {}))
    return ModelSpec(cls.model_id, cls.family, level, cls, defaults, grid or {})


_SPECS: list[ModelSpec] = [
    _spec(baseline.BaselineTrend, "baseline",
          {"lookbacks_days": [[10, 30, 60], [20, 60, 120], [40, 120, 240]]}),
    _spec(baseline.BaselineCarry, "baseline", {"entry_funding_annual": [0.05, 0.10, 0.20],
                                                "funding_lookback_hours": [24, 72, 168]}),
    _spec(baseline.BaselineBreakout, "baseline", {"lookbacks_days": [[10, 30, 50], [20, 55, 100]]}),
    _spec(baseline.BaselineXSMom, "baseline", {"formation_days": [14, 30, 60], "skip_days": [0, 1]}),
    _spec(rules.TSMomentum, "L1", {"lookbacks_days": [[3, 14, 60], [7, 30, 90], [14, 60, 120]],
                                   "horizon_hours": [24, 72]}),
    _spec(rules.TrendAcceleration, "L1", {"window_days": [3, 7, 14]}),
    _spec(rules.DonchianPosition, "L1", {"lookbacks_days": [[10, 20], [20, 55], [55, 100]]}),
    _spec(rules.XSMomentum, "L1", {"formation_days": [14, 30, 60], "skip_days": [0, 1]}),
    _spec(rules.ResidualMomentum, "L1", {"formation_days": [14, 30, 60], "beta_days": [30, 60]}),
    _spec(rules.ShortTermReversal, "L1", {"lookback_hours": [4, 24, 72], "horizon_hours": [4, 24]}),
    _spec(rules.ZScoreReversal, "L1", {"window_hours": [24, 72, 168]}),
    _spec(rules.VolAdjReversal, "L1", {"lookback_hours": [12, 24, 48], "short_vol_hours": [48, 72, 168]}),
    _spec(rules.FundingReversion, "L1", {"apr_hours": [24, 72, 168], "threshold": [1.0, 1.5, 2.0]}),
    _spec(rules.FundingAcceleration, "L1", {"short_hours": [8, 24], "long_hours": [72, 168, 336]}),
    _spec(rules.BasisReversion, "L1", {"z_hours": [72, 168, 336]}),
    _spec(rules.VolRegime, "L1", {"mom_days": [3, 7, 14]}),
    _spec(rules.VolManagedMomentum, "L1", {"target_daily_vol": [0.02, 0.03, 0.04], "max_scale": [1.5, 2.0]}),
    _spec(statistical.LinearFeatureModel, "L2", {"ridge": [1.0, 10.0, 100.0], "horizon_hours": [4, 24]}),
    _spec(statistical.OLSModel, "L2", {"horizon_hours": [4, 24]}),
    _spec(statistical.LogisticSign, "L2", {"ridge": [0.1, 1.0, 10.0], "horizon_hours": [4, 24]}),
    _spec(statistical.ARModel, "L2", {"order": [1, 3, 5], "horizon_hours": [4, 24]}),
    _spec(stubs.OpenInterestDivergence, "stub"),
    _spec(stubs.LiquidationCascade, "stub"),
    _spec(stubs.OrderBookImbalance, "stub"),
]

REGISTRY: dict[str, ModelSpec] = {s.model_id: s for s in _SPECS}


def build_model(model_id: str, **overrides: Any) -> SignalModel:
    spec = REGISTRY[model_id]
    m: SignalModel = spec.factory(**{**spec.defaults, **overrides})
    return m


def param_grid(model_id: str) -> list[dict[str, Any]]:
    """Cartesian product of the model's perturbation grid, each merged over its defaults."""
    spec = REGISTRY[model_id]
    if not spec.grid:
        return [dict(spec.defaults)]
    keys = list(spec.grid)
    return [{**spec.defaults, **dict(zip(keys, vals, strict=True))} for vals in product(*spec.grid.values())]
