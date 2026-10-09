"""Point-in-time (PIT) tradable universe.

pit_universe_mask(md) -> bool DataFrame (same index/columns as md.close). At each rebalance
boundary b (first bar of each month, or of each day), symbols are ranked by trailing ADV
(mean daily quote volume over `adv_days`) computed from bars STRICTLY BEFORE b. A symbol is
eligible if it
  * has >= min_history_days of real (non-filled) bars before b (counted since its first real bar),
  * had a real (non-stale) bar within the last `stale_hours` hours before b,
  * ranks in the top_n by trailing ADV.
The membership is then held constant until the next boundary. Bars where the symbol has no
valid close are always False (delisted / not yet listed).

Causal: mask.loc[t] depends only on data at timestamps < boundary(t) <= t, plus the close at t
for the final validity check, so pit_universe_mask(md.truncate(t)).loc[t] == pit_universe_mask(md).loc[t].
"""

from __future__ import annotations

from typing import Literal

import pandas as pd

from engine.contracts import MarketData

Rebalance = Literal["monthly", "daily"]


def _boundaries(index: pd.DatetimeIndex, rebalance: Rebalance) -> pd.DatetimeIndex:
    """Period start for each bar: the timestamp at which that bar's membership was decided."""
    if rebalance == "monthly":
        naive = index.tz_convert("UTC").tz_localize(None) if index.tz is not None else index
        out = naive.to_period("M").to_timestamp()
        return out.tz_localize("UTC") if index.tz is not None else out
    if rebalance == "daily":
        return index.floor("D")
    raise ValueError(f"unknown rebalance {rebalance!r}")


def pit_universe_mask(
    md: MarketData,
    top_n: int = 20,
    min_history_days: int = 60,
    adv_days: int = 30,
    rebalance: Rebalance = "monthly",
    stale_hours: int = 72,
) -> pd.DataFrame:
    close = md.close
    idx = close.index
    if not isinstance(idx, pd.DatetimeIndex) or idx.empty:
        return pd.DataFrame(False, index=idx, columns=close.columns)

    real = close.notna() & ~md.is_filled.reindex_like(close).fillna(True).astype(bool)
    qv = md.quote_volume.where(real, 0.0).fillna(0.0)

    # Trailing state as of the END of each bar (inclusive), then evaluated at the bar strictly
    # before each boundary -> uses data < boundary only.
    hours_adv = adv_days * 24
    adv = qv.rolling(hours_adv, min_periods=1).sum() / adv_days
    n_real = real.cumsum()
    last_real_pos = pd.DataFrame(
        {c: pd.Series(range(len(idx)), index=idx).where(real[c]).ffill() for c in close.columns},
        index=idx,
    )

    bnd = _boundaries(idx, rebalance)
    unique_b = pd.DatetimeIndex(pd.unique(bnd))
    rows: dict[pd.Timestamp, pd.Series] = {}
    for b in unique_b:
        before = idx[idx < b]
        if before.empty:
            rows[b] = pd.Series(False, index=close.columns)
            continue
        i = len(before) - 1
        hist_ok = n_real.iloc[i] >= min_history_days * 24
        fresh = ((i - last_real_pos.iloc[i]) < stale_hours).fillna(False).astype(bool)
        adv_t = adv.iloc[i]
        a = adv_t.where(hist_ok & fresh & (adv_t > 0))
        chosen = a.dropna().nlargest(top_n).index
        rows[b] = pd.Series(close.columns.isin(chosen), index=close.columns)
    decided = pd.DataFrame(rows).T.reindex(bnd)
    decided.index = idx
    mask = decided.astype(bool) & close.notna()
    return mask
