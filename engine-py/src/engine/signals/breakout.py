"""Donchian channel breakout ensemble (turtle-style; Zarattini et al., "Catching Crypto Trends").

Per asset and per lookback L in {20, 55, 100} days: go long when the close reaches the trailing L-day high,
short when it reaches the trailing L-day low; exit a long when the close falls below the channel midline
((high+low)/2), exit a short when it rises above it. Score = mean position across lookbacks. Sizing is the
same as trend.py: inverse-vol per asset, portfolio-level ex-ante vol target, per-asset and gross caps.
Channels use only closes <= t and the state machine runs forward in time, so the signal is causal.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import Dataset, Market, TargetWeights
from engine.signals.trend import HOURS_PER_YEAR, decision_times, tradable_mask


def realized_vol(
    close: pd.DataFrame, is_filled: pd.DataFrame, lookback_days: int
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(hourly returns excluding stale bars, annualized trailing vol), as in trend.py."""
    real = ~is_filled.reindex_like(close).fillna(True).astype(bool)
    rets = close.pct_change(fill_method=None).where(real)
    win = lookback_days * 24
    vol = rets.rolling(win, min_periods=win // 2).std() * math.sqrt(HOURS_PER_YEAR)
    return rets, vol


def portfolio_vol_target(raw: pd.DataFrame, rets: pd.DataFrame, vol_target: float, win: int) -> pd.DataFrame:
    """Scale each row so ex-ante portfolio vol over the trailing win bars (data <= t) equals vol_target.

    Same procedure as TrendStrategy."""
    r = rets.to_numpy(dtype=float)
    pos = rets.index.get_indexer(raw.index)
    rows = []
    for i, t_pos in enumerate(pos):
        wv = raw.iloc[i].to_numpy(dtype=float)
        if not np.any(wv):
            rows.append(wv)
            continue
        seg = r[max(0, t_pos - win + 1): t_pos + 1]
        held = wv != 0
        sub = seg[:, held]
        hist = sub[~np.isnan(sub).any(axis=1)] @ wv[held]
        pvol = float(hist.std()) * math.sqrt(HOURS_PER_YEAR) if len(hist) else 0.0
        rows.append(wv * (vol_target / pvol) if pvol > 0 else wv * 0.0)
    return pd.DataFrame(rows, index=raw.index, columns=raw.columns)


def apply_caps(w: pd.DataFrame, max_w: float, max_gross: float) -> pd.DataFrame:
    w = w.clip(-max_w, max_w)
    gross = w.abs().sum(axis=1)
    scale = (max_gross / gross).where(gross > max_gross, 1.0)
    return w.mul(scale, axis=0)


def pack(w: pd.DataFrame, market: Market) -> TargetWeights:
    empty = pd.DataFrame(index=w.index, dtype=float)
    return TargetWeights(spot=empty, perp=w) if market == "perp" else TargetWeights(spot=w, perp=empty)


def donchian_position(close: np.ndarray, hi: np.ndarray, lo: np.ndarray) -> np.ndarray:
    """Forward state machine over decision rows; arrays shaped (T, N). Missing data -> flat."""
    out = np.zeros(close.shape)
    state = np.zeros(close.shape[1])
    for i in range(close.shape[0]):
        c, h, lw = close[i], hi[i], lo[i]
        valid = ~(np.isnan(c) | np.isnan(h) | np.isnan(lw))
        mid = (h + lw) / 2.0
        state = np.where(valid, state, 0.0)
        state = np.where(valid & (state > 0) & (c < mid), 0.0, state)
        state = np.where(valid & (state < 0) & (c > mid), 0.0, state)
        state = np.where(valid & (c >= h), 1.0, state)
        state = np.where(valid & (c <= lw), -1.0, state)
        out[i] = state
    return out


class BreakoutStrategy:
    name = "breakout"

    def __init__(self, params: dict[str, Any]):
        self.params = params
        self.market: Market = params.get("market", "perp")
        self.lookbacks: list[int] = [int(x) for x in params.get("lookbacks_days", [20, 55, 100])]
        self.vol_target = float(params["vol_target_annual"])
        self.vol_lookback = int(params["vol_lookback_days"])
        self.rebalance_hours = int(params.get("rebalance_hours", 24))
        self.max_gross = float(params["max_gross_leverage"])
        self.max_w = float(params["max_weight_per_asset"])
        self.allow_short = bool(params.get("allow_short", True))

    def target_weights(self, data: Dataset) -> TargetWeights:
        md = data.market(self.market)
        close = md.close
        times = decision_times(pd.DatetimeIndex(close.index), self.rebalance_hours)
        c_t = close.loc[times].to_numpy(dtype=float)
        score = np.zeros(c_t.shape)
        for L in self.lookbacks:
            win = L * 24
            hi = close.rolling(win, min_periods=win).max().loc[times].to_numpy(dtype=float)
            lo = close.rolling(win, min_periods=win).min().loc[times].to_numpy(dtype=float)
            score += donchian_position(c_t, hi, lo)
        score_df = pd.DataFrame(score / len(self.lookbacks), index=times, columns=close.columns)

        rets, vol = realized_vol(close, md.is_filled, self.vol_lookback)
        eligible = (tradable_mask(md) & (vol > 0)).loc[times]
        raw = (score_df / vol.loc[times]).where(eligible, 0.0).fillna(0.0)
        if not self.allow_short:
            raw = raw.clip(lower=0.0)
        w = portfolio_vol_target(raw, rets, self.vol_target, self.vol_lookback * 24)
        return pack(apply_caps(w, self.max_w, self.max_gross), self.market)
