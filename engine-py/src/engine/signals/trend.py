"""Time-series momentum (TSMOM) ensemble, risk-parity across assets, PORTFOLIO-level vol targeting.

Per-asset raw weight = score / asset_vol (inverse-vol risk parity). The whole row is then scaled so that the
ex-ante portfolio vol (proposed weights applied to the trailing vol_lookback window of returns, i.e. only
data <= t) equals vol_target_annual. Caps are applied last. Causal by construction."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import Dataset, Market, MarketData, TargetWeights

MAX_STALE_BARS = 24
HOURS_PER_YEAR = 24 * 365


def stale_run_length(is_filled: pd.DataFrame) -> pd.DataFrame:
    """Consecutive is_filled=True bars ending at each t (causal)."""
    f = is_filled.fillna(False).astype(bool)
    out = {}
    for c in f.columns:
        s = f[c]
        groups = (~s).cumsum()
        out[c] = s.astype(int).groupby(groups).cumsum()
    return pd.DataFrame(out, index=f.index, columns=f.columns)


def tradable_mask(md: MarketData) -> pd.DataFrame:
    """Valid close and not stale for more than MAX_STALE_BARS consecutive bars."""
    return md.close.notna() & (stale_run_length(md.is_filled) <= MAX_STALE_BARS)


def decision_times(index: pd.DatetimeIndex, every_hours: int) -> pd.DatetimeIndex:
    """Bars whose hour-of-day is a multiple of every_hours (aligned to 00:00 UTC)."""
    if every_hours >= 24:
        days = (index.normalize() - pd.Timestamp("1970-01-01", tz=index.tz)).days
        mask = (index.hour == 0) & (np.asarray(days) % (every_hours // 24) == 0)
    else:
        mask = index.hour % every_hours == 0
    return index[mask]


class TrendStrategy:
    name = "trend"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.market: Market = params.get("market", "perp")
        self.lookbacks: list[int] = [int(x) for x in params["lookbacks_days"]]
        self.vol_target = float(params["vol_target_annual"])
        self.vol_lookback = int(params["vol_lookback_days"])
        self.rebalance_hours = int(params["rebalance_hours"])
        self.max_gross = float(params["max_gross_leverage"])
        self.max_w = float(params["max_weight_per_asset"])
        self.allow_short = bool(params.get("allow_short", True))

    def target_weights(self, data: Dataset) -> TargetWeights:
        md = data.market(self.market)
        close = md.close
        idx = close.index
        times = decision_times(pd.DatetimeIndex(idx), self.rebalance_hours)

        score = pd.DataFrame(0.0, index=idx, columns=close.columns)
        for L in self.lookbacks:
            score = score + np.sign(close / close.shift(L * 24) - 1.0)
        score = score / len(self.lookbacks)

        # filled (stale) bars carry a synthetic 0 return: exclude them from vol, else vol is biased low
        real = ~md.is_filled.reindex_like(close).fillna(True).astype(bool)
        rets = close.pct_change(fill_method=None).where(real)
        win = self.vol_lookback * 24
        vol = rets.rolling(win, min_periods=win // 2).std() * math.sqrt(HOURS_PER_YEAR)

        eligible = tradable_mask(md) & close.shift(max(self.lookbacks) * 24).notna() & (vol > 0)
        raw = (score / vol).where(eligible, 0.0).fillna(0.0).loc[times]
        r = rets.to_numpy()
        pos = idx.get_indexer(times)
        rows = []
        for i, t_pos in enumerate(pos):
            wv = raw.iloc[i].to_numpy()
            if not np.any(wv):
                rows.append(wv)
                continue
            seg = r[max(0, t_pos - win + 1): t_pos + 1]
            held = wv != 0
            # Only HELD columns matter; NaNs in unheld (stale/unlisted) columns must not poison the history.
            sub = seg[:, held]
            hist = sub[~np.isnan(sub).any(axis=1)] @ wv[held]
            hist = np.nan_to_num(hist)
            pvol = float(hist.std()) * math.sqrt(HOURS_PER_YEAR)
            rows.append(wv * (self.vol_target / pvol) if pvol > 0 else wv * 0.0)
        w = pd.DataFrame(rows, index=raw.index, columns=raw.columns)
        if not self.allow_short:
            w = w.clip(lower=0.0)
        w = w.clip(-self.max_w, self.max_w)
        gross = w.abs().sum(axis=1)
        scale = (self.max_gross / gross).where(gross > self.max_gross, 1.0)
        w = w.mul(scale, axis=0)
        spot = pd.DataFrame(index=w.index, dtype=float)
        return TargetWeights(spot=spot, perp=w) if self.market == "perp" else TargetWeights(spot=w, perp=spot)
