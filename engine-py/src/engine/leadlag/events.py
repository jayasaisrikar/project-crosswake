"""Causal event detection + event-study statistics for BTC impulses.

Conventions: r = log return of bar t (close_{t-1} -> close_t), index = bar open ts (contracts.py).
Impulse at bar t: |r_btc[t]| > k * sigma[t], sigma = std of r_btc over the PREVIOUS `vol_lookback` bars
(shift(1): the impulse bar itself is not in its own threshold). Everything at row t uses data <= t.
Forward outcomes (h hours after the impulse bar close) are labels for research only, never signals.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm


def log_returns(close: pd.DataFrame, is_filled: pd.DataFrame | None = None) -> pd.DataFrame:
    """Hourly log returns; NaN where the bar (or the previous one) is synthesized."""
    r = pd.DataFrame(np.log(close), index=close.index, columns=close.columns).diff()
    if is_filled is not None:
        f = is_filled.reindex_like(close).fillna(True).astype(bool)
        r = r.mask(f | f.shift(1, fill_value=True))
    return r


def trailing_vol(r: pd.Series, lookback: int) -> pd.Series:
    """Std of the previous `lookback` returns (excludes bar t). Causal."""
    return r.rolling(lookback, min_periods=lookback // 2).std().shift(1)


def detect_impulses(r_btc: pd.Series, k: float, lookback: int) -> pd.Series:
    """Signed impulse indicator: +1 / -1 at impulse bars, 0 elsewhere. Causal."""
    sig = trailing_vol(r_btc, lookback)
    hit = r_btc.abs() > k * sig
    return (np.sign(r_btc).where(hit, 0.0)).fillna(0.0)


def rolling_beta(r_alt: pd.DataFrame, r_btc: pd.Series, lookback: int) -> pd.DataFrame:
    """Trailing OLS beta of each alt on BTC over the previous `lookback` bars (shift(1)). Causal."""
    var = r_btc.rolling(lookback, min_periods=lookback // 2).var()
    out = {}
    for c in r_alt.columns:
        cov = r_alt[c].rolling(lookback, min_periods=lookback // 2).cov(r_btc)
        out[c] = (cov / var).shift(1)
    return pd.DataFrame(out, index=r_alt.index, columns=r_alt.columns)


def forward_sum(r: pd.DataFrame, h: int) -> pd.DataFrame:
    """Sum of returns over bars t+1..t+h (label; NOT causal by design)."""
    return r[::-1].rolling(h, min_periods=h).sum()[::-1].shift(-1)


def event_panel(r_alt: pd.DataFrame, r_btc: pd.Series, impulses: pd.Series, beta: pd.DataFrame,
                horizons: list[int]) -> pd.DataFrame:
    """Long table, one row per (event ts, alt). All outcomes signed by the impulse direction, so >0 means
    the alt continues in the BTC direction (delayed response). Columns: gap, raw_h, abn_h."""
    ev = impulses[impulses != 0]
    rows: dict[str, pd.DataFrame] = {}
    s = impulses.reindex(r_alt.index)
    sgn = pd.DataFrame(np.repeat(s.to_numpy()[:, None], r_alt.shape[1], axis=1),
                       index=r_alt.index, columns=r_alt.columns)
    bb = beta.mul(r_btc, axis=0)
    rows["gap"] = sgn * (bb - r_alt)
    # abnormal return uses the beta known at the impulse bar (fixed over the horizon)
    for h in horizons:
        raw = forward_sum(r_alt, h)
        btc_f = forward_sum(r_btc.to_frame("b"), h)["b"]
        abn = raw - beta.mul(btc_f, axis=0)
        rows[f"raw_{h}"] = sgn * raw
        rows[f"abn_{h}"] = sgn * abn
    parts = []
    for name, df in rows.items():
        st = pd.Series(df.loc[ev.index].stack(future_stack=True))
        st.name = name
        parts.append(st)
    out = pd.concat(parts, axis=1)
    out.index.names = ["ts", "symbol"]
    return out.dropna(how="all")


def hac_mean(x: pd.Series, lags: int) -> dict[str, float]:
    """Mean, Newey-West t-stat, hit rate (share > 0), n of a (time-ordered) series."""
    x = x.dropna()
    n = len(x)
    if n < 5:
        return {"mean_bps": float("nan"), "t_hac": float("nan"), "hit": float("nan"), "n": float(n)}
    res = sm.OLS(x.to_numpy(float), np.ones(n)).fit(cov_type="HAC", cov_kwds={"maxlags": max(lags, 1)})
    return {"mean_bps": float(x.mean() * 1e4), "t_hac": float(res.tvalues[0]),
            "hit": float((x > 0).mean()), "n": float(n)}


def summarize(panel: pd.DataFrame, cols: list[str], lags_for: dict[str, int]) -> pd.DataFrame:
    """Clustered by event: average across alts within each event ts, then HAC t-stat over events."""
    per_event = panel.groupby(level="ts")[cols].mean()
    recs: list[dict[str, Any]] = []
    for c in cols:
        d: dict[str, Any] = dict(hac_mean(per_event[c], lags_for.get(c, 1)))
        d["metric"] = c
        recs.append(d)
    return pd.DataFrame(recs).set_index("metric")


def lagged_xcorr(r_alt: pd.DataFrame, r_btc: pd.Series, max_lag: int) -> pd.Series:
    """Mean over alts of corr(r_btc[t-L], r_alt[t]) for L=0..max_lag."""
    out = {}
    for L in range(max_lag + 1):
        b = r_btc.shift(L)
        out[L] = float(np.nanmean([r_alt[c].corr(b) for c in r_alt.columns]))
    return pd.Series(out, name="xcorr")
