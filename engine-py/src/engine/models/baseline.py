"""BASELINE_V0 adapters: the existing engine.signals strategies wrapped as SignalModels (logic unchanged).

score = the strategy's target weight, held (forward-filled) between its decision rows. The ScoreModel base
calibrates weight -> forward return on the training window. Carry is a delta-neutral trade, so its target is
the hedged return of long spot / short perp plus funding received over (t, t+h].

Note: predict() runs the strategy on a [t - warmup, t] window; path-dependent state (carry hysteresis,
breakout channels) restarts at the window start, so values can differ slightly from a full-history run.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from engine.contracts import Dataset, Strategy
from engine.models.base import ScoreModel, forward_return, funding_hourly
from engine.signals.breakout import BreakoutStrategy
from engine.signals.carry import CarryStrategy
from engine.signals.trend import TrendStrategy
from engine.signals.xsmom import XSMomStrategy

COMMON = {"vol_target_annual": 0.20, "vol_lookback_days": 30, "max_gross_leverage": 2.0,
          "max_weight_per_asset": 0.25}


class BaselineAdapter(ScoreModel):
    family = "BASELINE_V0"
    strategy_cls: type = TrendStrategy
    leg = "perp"
    warmup_days = 150

    @property
    def warmup_hours(self) -> int:
        return int(self.params.get("warmup_days", self.warmup_days)) * 24

    def strategy(self) -> Strategy:
        sp: dict[str, Any] = {k: v for k, v in self.params.items() if k not in ("horizon_hours",)}
        s: Strategy = self.strategy_cls(sp)
        return s

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        tw = self.strategy().target_weights(data)
        w = tw.perp if self.leg == "perp" else tw.spot
        close = self._md(data).close
        return w.reindex(columns=close.columns).reindex(close.index).ffill().fillna(0.0)


class BaselineTrend(BaselineAdapter):
    model_id = "baseline_trend"
    strategy_cls = TrendStrategy
    default_params = {**COMMON, "lookbacks_days": [20, 60, 120], "rebalance_hours": 24, "allow_short": True}


class BaselineBreakout(BaselineAdapter):
    model_id = "baseline_breakout"
    strategy_cls = BreakoutStrategy
    default_params = {**COMMON, "lookbacks_days": [20, 55, 100], "rebalance_hours": 24, "allow_short": True}


class BaselineXSMom(BaselineAdapter):
    model_id = "baseline_xsmom"
    xs = True
    strategy_cls = XSMomStrategy
    warmup_days = 75
    default_params = {**COMMON, "formation_days": 30, "skip_days": 1, "rebalance_hours": 168}


class BaselineCarry(BaselineAdapter):
    """Prediction.asset = the coin; expected_return is for the hedged long-spot/short-perp carry trade."""

    model_id = "baseline_carry"
    strategy_cls = CarryStrategy
    leg = "spot"
    warmup_days = 30
    default_params = {"entry_funding_annual": 0.10, "exit_funding_annual": 0.02, "funding_lookback_hours": 72,
                      "max_weight_per_asset": 0.20, "max_gross": 1.0, "max_basis": 0.02,
                      "rebalance_hours": 24, "max_positions": 5, "no_trade_band": 0.25,
                      "min_hold_days": 14, "entry_cost_margin": 2.0}

    def target_panel(self, data: Dataset) -> pd.DataFrame:
        h = self.horizon_hours
        perp = data.perp.close
        spot = data.spot.close.reindex_like(perp)
        fh = funding_hourly(data, perp.index, perp.columns).fillna(0.0)
        fwd_funding = fh.rolling(h, min_periods=h).sum().shift(-h)
        return forward_return(spot, h) - forward_return(perp, h) + fwd_funding
