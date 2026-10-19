"""Regime engine public API.

``labels(dataset)`` -> hourly DataFrame of causal labels (row t uses bars <= t only).
``label(dataset, t)`` -> dict of labels at t, computed on ``dataset.truncate(t)``.
Daily statistical labels (HMM, CUSUM) computed from day d are applied to the hours of day d+1.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import Dataset
from engine.regimes import labelers as lb
from engine.regimes.changepoint import daily_cusum
from engine.regimes.hmm import filtered_high_vol_prob

RULE_COLUMNS = ("trend", "vol", "funding", "correlation", "leadership", "panic")


def _daily_to_hourly(daily: pd.DataFrame | pd.Series, idx: pd.DatetimeIndex) -> pd.DataFrame:
    d = daily.to_frame() if isinstance(daily, pd.Series) else daily
    shifted = d.copy()
    shifted.index = shifted.index + pd.Timedelta(days=1)  # day d known from the start of day d+1
    key = idx.floor("D")
    return shifted.reindex(key).set_axis(idx)


def labels(ds: Dataset, leader: str = "BTC", statistical: bool = True) -> pd.DataFrame:
    idx = pd.DatetimeIndex(ds.perp.close.index)
    out = pd.DataFrame(index=idx)
    out["trend"] = lb.trend(ds, leader)
    out["vol"] = lb.vol(ds, leader)
    out["funding"] = lb.funding(ds, leader)
    out["correlation"] = lb.correlation(ds, leader)
    out["leadership"] = lb.leadership(ds, leader)
    out["panic"] = lb.panic(ds, leader)
    if statistical:
        close = ds.perp.close[leader].where(~ds.perp.is_filled[leader])
        p = filtered_high_vol_prob(close).rename("hmm_p_high")
        cp = daily_cusum(close)
        h = _daily_to_hourly(pd.concat([p, cp], axis=1), idx)
        out["hmm_p_high"] = h["hmm_p_high"]
        state = pd.Series(np.where(h["hmm_p_high"] > 0.5, "high_vol", "low_vol"), index=idx, dtype=object)
        state[h["hmm_p_high"].isna()] = None
        out["hmm_state"] = state
        out["cp_flag"] = h["cp_flag"]
        out["days_since_cp"] = h["days_since_cp"]
    return out


def label(ds: Dataset, t: pd.Timestamp, leader: str = "BTC", statistical: bool = True) -> dict[str, Any]:
    df = labels(ds.truncate(t), leader, statistical)
    return {str(k): v for k, v in df.iloc[-1].items()} if len(df) else {}


def transition_stats(s: pd.Series) -> pd.DataFrame:
    """Row-normalised transition matrix between consecutive non-null labels, plus each state's
    share of time and mean spell length in bars."""
    s = s.dropna()
    a, b = s.iloc[:-1].to_numpy(), s.iloc[1:].to_numpy()
    m = pd.crosstab(pd.Series(a, name="from"), pd.Series(b, name="to"))
    p = m.div(m.sum(axis=1), axis=0)
    spells = (s != s.shift()).cumsum()
    lengths = s.groupby(spells).agg(["first", "size"])
    p["share"] = s.value_counts(normalize=True).reindex(p.index)
    p["mean_spell_bars"] = lengths.groupby("first")["size"].mean().reindex(p.index)
    return p
