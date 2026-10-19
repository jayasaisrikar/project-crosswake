"""Cross-sectional momentum (Liu, Tsyvinski & Wu, "Common Risk Factors in Cryptocurrency").

Weekly: rank tradable coins by the 30-day return skipping the most recent day; long the top tercile and short
the bottom tercile, equal weight, equal leg sizes (dollar-neutral). The book is scaled to the portfolio
ex-ante vol target as in trend.py, then capped (symmetric legs keep the caps neutral).
Causal: closes <= t only.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import Dataset, Market, TargetWeights
from engine.signals.breakout import apply_caps, pack, portfolio_vol_target, realized_vol
from engine.signals.trend import decision_times, tradable_mask


class XSMomStrategy:
    name = "xsmom"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.market: Market = params.get("market", "perp")
        self.formation = int(params.get("formation_days", 30))
        self.skip = int(params.get("skip_days", 1))
        self.vol_target = float(params["vol_target_annual"])
        self.vol_lookback = int(params["vol_lookback_days"])
        self.rebalance_hours = int(params.get("rebalance_hours", 168))
        self.max_gross = float(params["max_gross_leverage"])
        self.max_w = float(params["max_weight_per_asset"])

    def target_weights(self, data: Dataset) -> TargetWeights:
        md = data.market(self.market)
        close = md.close
        times = decision_times(pd.DatetimeIndex(close.index), self.rebalance_hours)
        mom = close.shift(self.skip * 24) / close.shift((self.formation + self.skip) * 24) - 1.0
        rets, vol = realized_vol(close, md.is_filled, self.vol_lookback)
        eligible = (tradable_mask(md) & mom.notna() & (vol > 0)).loc[times]
        m = mom.loc[times].where(eligible).to_numpy(dtype=float)
        raw = np.zeros(m.shape)
        for i, row in enumerate(m):
            ok = np.flatnonzero(~np.isnan(row))
            n = len(ok) // 3
            if n == 0:
                continue
            order = ok[np.argsort(row[ok], kind="stable")]
            raw[i, order[-n:]] = 1.0 / n
            raw[i, order[:n]] = -1.0 / n
        raw_df = pd.DataFrame(raw, index=times, columns=close.columns)
        w = portfolio_vol_target(raw_df, rets, self.vol_target, self.vol_lookback * 24)
        return pack(apply_caps(w, self.max_w, self.max_gross), self.market)
