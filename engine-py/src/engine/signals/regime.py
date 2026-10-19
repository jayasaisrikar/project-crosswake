"""Volatility-managed trend (Moreira & Muir 2017, "Volatility-Managed Portfolios").

Takes TrendStrategy weights and multiplies each decision row by target_var / realized_var, clipped to
[0, 1.5]. realized_var is the trailing (vol_lookback_days) variance of the trend book's own hourly returns
(weights decided before bar s applied to bar s returns, s <= t); target = trend vol_target_annual squared.
Trend caps are re-applied afterwards. No other parameters. Causal.
"""

from __future__ import annotations

from typing import Any

from engine.contracts import Dataset, TargetWeights
from engine.signals.breakout import apply_caps, pack, realized_vol
from engine.signals.trend import HOURS_PER_YEAR, TrendStrategy

MAX_SCALE = 1.5


class TrendRegimeStrategy:
    name = "trend_regime"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.trend = TrendStrategy(params)

    def target_weights(self, data: Dataset) -> TargetWeights:
        t = self.trend
        tw = t.target_weights(data)
        base = tw.perp if t.market == "perp" else tw.spot
        md = data.market(t.market)
        close = md.close
        rets, _ = realized_vol(close, md.is_filled, t.vol_lookback)
        held = base.reindex(close.index).ffill().fillna(0.0).shift(1).fillna(0.0)
        strat_ret = (held * rets.reindex(columns=base.columns).fillna(0.0)).sum(axis=1)
        win = t.vol_lookback * 24
        rvar = strat_ret.rolling(win, min_periods=win // 2).var() * HOURS_PER_YEAR
        scale = (t.vol_target**2 / rvar).where(rvar > 0).clip(0.0, MAX_SCALE).fillna(1.0)
        w = apply_caps(base.mul(scale.reindex(base.index), axis=0), t.max_w, t.max_gross)
        return pack(w, t.market)
