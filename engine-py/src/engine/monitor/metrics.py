"""Live prediction metrics per model / regime / confidence bucket."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

CONF_EDGES = [0.0, 0.5, 0.55, 0.6, 0.7, 1.0001]


def confidence_bucket(c: Any) -> str:
    try:
        x = float(c)
    except (TypeError, ValueError):
        return "uncalibrated"
    if math.isnan(x):
        return "uncalibrated"
    for lo, hi in zip(CONF_EDGES[:-1], CONF_EDGES[1:], strict=True):
        if lo <= x < hi:
            return f"{lo:.2f}-{min(hi, 1.0):.2f}"
    return "uncalibrated"


def resolved(df: pd.DataFrame) -> pd.DataFrame:
    """Resolved, directional (non NO-TRADE) rows with a float hit column ``hit_f``."""
    if df.empty or "realized_return" not in df.columns:
        return pd.DataFrame()
    r = df[df["realized_return"].notna() & (df["direction"] != 0)].copy()
    r["hit_f"] = r["hit"].astype(float)
    return r


def sharpe(x: pd.Series, horizon_hours: float) -> float:
    x = x.dropna()
    if len(x) < 2 or float(x.std(ddof=1)) == 0:
        return math.nan
    return float(x.mean() / x.std(ddof=1) * math.sqrt(8760.0 / max(horizon_hours, 1.0)))


def max_drawdown(x: pd.Series) -> float:
    if x.empty:
        return math.nan
    eq = (1 + x.fillna(0)).cumprod()
    return float((eq / eq.cummax() - 1).min())


def calibration(df: pd.DataFrame, n_bins: int = 5) -> tuple[pd.DataFrame, float]:
    """Reliability table (mean confidence vs observed hit rate) and expected calibration error."""
    r = resolved(df)
    if not r.empty:
        r = r[pd.to_numeric(r["confidence"], errors="coerce").notna()]
    if r.empty:
        return pd.DataFrame(columns=["bin", "n", "mean_conf", "hit_rate"]), math.nan
    r["confidence"] = r["confidence"].astype(float).clip(0, 1)
    bins = pd.cut(r["confidence"], list(np.linspace(0, 1, n_bins + 1)), include_lowest=True)
    tab = r.groupby(bins, observed=True).agg(n=("hit_f", "size"), mean_conf=("confidence", "mean"),
                                             hit_rate=("hit_f", "mean")).reset_index(names="bin")
    tab["bin"] = tab["bin"].astype(str)
    ece = float((tab["n"] * (tab["mean_conf"] - tab["hit_rate"]).abs()).sum() / tab["n"].sum())
    return tab, ece


def summarize(df: pd.DataFrame) -> dict[str, float]:
    r = resolved(df)
    if r.empty:
        return {"n": 0, "hit_rate": math.nan, "expectancy": math.nan, "mean_error": math.nan,
                "mean_abs_error": math.nan, "sharpe": math.nan, "ece": math.nan,
                "total_return": math.nan, "max_dd": math.nan}
    r = r.sort_values("expiry")
    h = float(r["horizon_hours"].median())
    net = r["net_return"].astype(float)
    _, ece = calibration(r)
    return {"n": float(len(r)), "hit_rate": float(r["hit_f"].mean()), "expectancy": float(net.mean()),
            "mean_error": float(r["error"].mean()), "mean_abs_error": float(r["error"].abs().mean()),
            "sharpe": sharpe(net, h), "ece": ece, "total_return": float(net.sum()),
            "max_dd": max_drawdown(net)}


def by_group(df: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    """Metrics grouped by any of 'model_id', 'regime', 'conf_bucket'."""
    if df.empty:
        return pd.DataFrame()
    d = df.copy()
    d["conf_bucket"] = d["confidence"].map(confidence_bucket) if "confidence" in d else "uncalibrated"
    if "regime" not in d:
        d["regime"] = ""
    rows = []
    for k, g in d.groupby(keys):
        kt = k if isinstance(k, tuple) else (k,)
        rows.append({**dict(zip(keys, kt, strict=True)), **summarize(g)})
    return pd.DataFrame(rows)


def rolling_sharpe(df: pd.DataFrame, model_id: str, window: int = 50) -> pd.Series:
    r = resolved(df)
    if r.empty:
        return pd.Series(dtype=float)
    r = r[r["model_id"] == model_id].sort_values("expiry")
    if r.empty:
        return pd.Series(dtype=float)
    k = math.sqrt(8760.0 / max(float(r["horizon_hours"].median()), 1.0))
    x = r.set_index("expiry")["net_return"].astype(float)
    mp = max(5, window // 2)
    return x.rolling(window, min_periods=mp).mean() / x.rolling(window, min_periods=mp).std() * k
