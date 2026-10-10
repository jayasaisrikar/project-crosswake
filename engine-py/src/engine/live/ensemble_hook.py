"""Optional monitor / ensemble layer for the PAPER loop (no notifications, no real execution).

Two independent pieces, both called from `engine.cli.live_step`:

1. `log_step_predictions` (always on unless `monitor.log_predictions: false` in config/live.yaml):
   every sleeve's latest weight per asset becomes one `Prediction` in the append-only
   `engine.monitor.ledger.Ledger` (`<paper dir>/predictions.jsonl`), and expired predictions are
   resolved against the step's close prices. This only writes new files; trading is unchanged.
   Naming: model_id = "<version>/sleeve.<name>" ("sleeve.<name>" when unversioned), asset = "<SYM>"
   for perp and "<SYM>.spot" for spot. Sleeves output weights, not return forecasts, so
   expected_return = 0 and confidence = NaN in the LOG; calibration happens below, from the log.

2. `apply_ensemble` (OFF by default, `ensemble.enabled: false`; and only ever applied to a version
   whose pinned live_hash includes it, see engine.track.versions). Design (AUDIT O8):
   * Calibration from the ledger: per sleeve, E[r_1h] = beta * w is fitted (no intercept) on resolved
     predictions whose expiry <= t (causal), shrunk toward 0: beta_post = n*beta_hat/(n + prior_n).
     confidence = P(sign correct), shrunk toward 0.5 the same way. Fewer than `min_samples` resolved
     rows => the sleeve is uncalibrated (NaN) and the layer runs in SHADOW mode for it.
   * Horizon: each sleeve's holding horizon (`ensemble.horizon_hours: {sleeve: h}`, default 24);
     E[r_h] = beta * w * h.
   * Sizing stays the sleeves' own: proposal = sum(allocation * health multiplier * sleeve weight).
     The layer only VETOES changes; it never re-sizes (no re-vol-targeting).
   * Edge is tested on the weight CHANGE: one-way marginal cost of |target - current| * equity versus
     the expected return over the horizon (`engine.ensemble.edge.marginal_edge`). An unchanged
     position is never vetoed.
   * Failure mode is HOLD: a vetoed or uncalibrated asset keeps its CURRENT weight; a halt keeps the
     whole current book. The layer never produces an empty target by itself.
"""

from __future__ import annotations

import math
from dataclasses import fields
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from engine.contracts import Dataset
from engine.live.signals_live import LiveSignal, Weights

VOL_BARS = 720          # trailing hourly bars for the per-asset vol forecast
HORIZON_HOURS = 1       # prediction-ledger horizon: decisions are re-made every hourly step
DEFAULT_SLEEVE_HORIZON = 24
TAIL_BYTES = 8_000_000  # bounded per-step read of the prediction ledger (O19)


def asset_key(market: str, sym: str) -> str:
    return sym if market == "perp" else f"{sym}.{market}"


def split_key(key: str) -> tuple[str, str]:
    return (key.rsplit(".", 1)[0], key.rsplit(".", 1)[1]) if "." in key else (key, "perp")


def model_id(sleeve: str, version_id: str | None = None) -> str:
    from engine.monitor.leaderboard import live_model_id

    return live_model_id(version_id, sleeve)


def _hourly_vol(data: Dataset, market: str, sym: str) -> float:
    c = data.market(market).close  # type: ignore[arg-type]
    if sym not in c.columns:
        return math.nan
    r = c[sym].pct_change(fill_method=None).iloc[-VOL_BARS:]
    return float(r.std()) if r.notna().sum() > 24 else math.nan


def price_map(prices: dict[str, dict[str, float]]) -> dict[str, float]:
    return {asset_key(m, s): v for m, ws in prices.items() for s, v in ws.items()}


def sleeve_predictions(sig: LiveSignal, data: Dataset, t: pd.Timestamp,
                       version_id: str | None = None) -> list[Any]:
    from engine.research.contract import Prediction

    out = []
    for sleeve, w in sig.sleeves.items():
        for m, ws in w.items():
            for sym, wt in ws.items():
                if wt == 0.0:
                    continue
                vol = _hourly_vol(data, m, sym)
                out.append(Prediction(
                    timestamp=pd.Timestamp(t), asset=asset_key(m, sym), model_id=model_id(sleeve, version_id),
                    horizon_hours=HORIZON_HOURS, expected_return=0.0, direction=1 if wt > 0 else -1,
                    confidence=math.nan, uncertainty=vol, risk=vol, model_sources=(sleeve,),
                    features={"weight": float(wt)}, reason="sleeve target weight (no return forecast)"))
    return out


def price_series(data: Dataset) -> dict[str, pd.Series]:
    out: dict[str, pd.Series] = {}
    for m in ("spot", "perp"):
        c = data.market(m).close  # type: ignore[arg-type]
        for s in c.columns:
            out[asset_key(m, str(s))] = c[s].dropna()
    return out


def log_step_predictions(paper_root: Path, sig: LiveSignal | None, data: Dataset, t: pd.Timestamp | None,
                         prices: dict[str, dict[str, float]], version_id: str | None = None,
                         ) -> dict[str, int]:
    """Append this step's sleeve predictions and resolve expired ones. Returns counts."""
    from engine.monitor.ledger import Ledger, resolve

    led = Ledger(paper_root)
    n_new = 0
    if sig is not None and t is not None:
        n_new = len(led.append(sleeve_predictions(sig, data, t, version_id), price_map(prices),
                               now=pd.Timestamp(t), tail_bytes=TAIL_BYTES))
    n_res = len(resolve(led, price_series(data), pd.Timestamp(t), tail_bytes=TAIL_BYTES)) \
        if t is not None else 0
    return {"predictions_logged": n_new, "predictions_resolved": n_res}


class HealthUnreadable(RuntimeError):
    """model_health.json exists but cannot be parsed: fail CLOSED (hold), never default to 1.0."""


def health_multipliers(paper_root: Path, sleeves: list[str], version_id: str | None = None,
                       ) -> dict[str, float]:
    """size_multiplier per sleeve from model_health.json (1.0 when the model has no state yet).
    Raises HealthUnreadable for a corrupt file (O14: never fail open)."""
    from engine.monitor.health import HealthBook

    try:
        st = HealthBook(paper_root, rules={}).states()
    except (OSError, ValueError) as e:
        raise HealthUnreadable(f"model_health.json unreadable: {e}") from e
    return {s: float(st.get(model_id(s, version_id), {}).get("size_multiplier", 1.0)) for s in sleeves}


def calibrate_sleeves(df: pd.DataFrame, t: pd.Timestamp, sleeves: list[str], version_id: str | None = None,
                      min_samples: int = 30, prior_n: float = 30.0) -> dict[str, dict[str, float]]:
    """Causal per-sleeve calibration from the prediction ledger (see module docstring).

    Returns {sleeve: {"beta", "confidence", "n"}}; beta/confidence are NaN below min_samples."""
    out: dict[str, dict[str, float]] = {}
    for s in sleeves:
        mid = model_id(s, version_id)
        sub = df if df.empty else df[df["model_id"] == mid]
        if sub.empty or "realized_return" not in sub.columns:
            n = 0
        else:
            sub = sub[sub["realized_return"].notna() & (pd.to_datetime(sub["expiry"], utc=True) <= t)]
            n = len(sub)
        if n < min_samples:
            out[s] = {"beta": math.nan, "confidence": math.nan, "n": float(n)}
            continue
        w = np.array([float(f.get("weight", 0.0)) if isinstance(f, dict) else 0.0
                      for f in sub["features"]], dtype=float)
        r = sub["realized_return"].astype(float).to_numpy()
        sxx = float(np.dot(w, w))
        beta_hat = float(np.dot(w, r) / sxx) if sxx > 0 else 0.0
        hits = float(np.mean(np.sign(w) * r > 0))
        out[s] = {"beta": n * beta_hat / (n + prior_n),
                  "confidence": (n * hits + prior_n * 0.5) / (n + prior_n), "n": float(n)}
    return out


def _dc_from(cls: Any, base: dict[str, Any], overrides: dict[str, Any] | None) -> Any:
    names = {f.name for f in fields(cls)}
    return cls(**{**base, **{k: v for k, v in (overrides or {}).items() if k in names}})


def _flat(w: Weights) -> dict[str, float]:
    return {asset_key(m, s): float(v) for m, ws in w.items() for s, v in ws.items()}


def apply_ensemble(cfg: dict[str, Any], sig: LiveSignal, data: Dataset, t: pd.Timestamp, now: pd.Timestamp,
                   equity: float, peak: float, halt: bool, reasons: list[str], limits: Any,
                   cost_model: Any, paper_root: Path, current: Weights | None = None,
                   version_id: str | None = None) -> tuple[Weights, dict[str, Any]]:
    """Optional ensemble layer (veto/multiplier on the sleeves). Returns (target weights, log record).

    Never flattens by itself: halt => current book; vetoed / uncalibrated asset => current weight."""
    from engine.costs import rolling_adv_and_vol
    from engine.ensemble.edge import MarketState, marginal_edge
    from engine.ensemble.no_trade import NoTradeConfig, TradeContext, gate
    from engine.monitor.ledger import Ledger, joined
    from engine.research.contract import Prediction

    cur_w: Weights = current if current is not None else {"spot": {}, "perp": {}}
    cur = _flat(cur_w)
    sleeves = list(sig.sleeves)
    try:
        mult = health_multipliers(paper_root, sleeves, version_id)
    except HealthUnreadable as e:
        return cur_w, {"mode": "hold", "reason": str(e), "no_trade": {"*": str(e)}}
    if halt:
        return cur_w, {"mode": "hold", "reason": "risk halt: holding current book",
                       "health_multipliers": mult, "no_trade": {"*": "; ".join(reasons) or "risk halt"}}
    calib = calibrate_sleeves(joined(Ledger(paper_root)), t, sleeves, version_id,
                              int(cfg.get("min_samples", 30)), float(cfg.get("prior_n", 30.0)))
    horizons = {s: int((cfg.get("horizon_hours") or {}).get(s, DEFAULT_SLEEVE_HORIZON)) for s in sleeves}
    proposal: dict[str, float] = {}
    er_num: dict[str, float] = {}
    den: dict[str, float] = {}
    cf_num: dict[str, float] = {}
    hz: dict[str, float] = {}
    for sleeve, w in sig.sleeves.items():
        alloc = sig.allocation.get(sleeve, 0.0)
        c = calib[sleeve]
        for m, ws in w.items():
            for sym, wt in ws.items():
                k = asset_key(m, sym)
                proposal[k] = proposal.get(k, 0.0) + alloc * mult[sleeve] * wt
                contrib = abs(alloc * wt)
                if math.isfinite(c["beta"]) and contrib > 0:
                    er_num[k] = er_num.get(k, 0.0) + contrib * c["beta"] * wt * horizons[sleeve]
                    cf_num[k] = cf_num.get(k, 0.0) + contrib * c["confidence"]
                    hz[k] = hz.get(k, 0.0) + contrib * horizons[sleeve]
                    den[k] = den.get(k, 0.0) + contrib
    nt_over = cfg.get("no_trade") or {}
    nt_cfg = _dc_from(NoTradeConfig, {}, nt_over)
    final: dict[str, float] = {}
    vetoes: dict[str, str] = {}
    adv_cache: dict[str, pd.DataFrame] = {}
    for k in sorted(set(proposal) | set(cur)):
        tgt, now_w = proposal.get(k, 0.0), cur.get(k, 0.0)
        if abs(tgt - now_w) < 1e-9:
            final[k] = tgt                       # continuation: zero marginal cost, never vetoed
            continue
        sym, m = split_key(k)
        if den.get(k, 0.0) <= 0:
            vetoes[k] = "uncalibrated sleeve(s): shadow mode, holding current weight"
            final[k] = now_w
            continue
        er, conf = er_num[k] / den[k], cf_num[k] / den[k]
        h = max(1, int(round(hz[k] / den[k])))
        if m not in adv_cache:
            adv_cache[m] = rolling_adv_and_vol(data.market(m))[0]  # type: ignore[arg-type]
        adv_df = adv_cache[m]
        adv = float(adv_df[sym].iloc[-1]) if sym in adv_df.columns and len(adv_df) else math.nan
        closes = data.market(m).close  # type: ignore[arg-type]
        col = closes[sym].dropna() if sym in closes.columns else pd.Series(dtype="float64")
        px = float(col.iloc[-1]) if len(col) else 1.0
        ms = MarketState(cost_model=cost_model, market=m, price=px,
                         adv_quote=adv if math.isfinite(adv) else None,
                         min_net_edge=float(nt_over.get("min_net_edge", 0.0)))
        net, cost = marginal_edge(er, now_w, tgt, equity, ms, sym, h)
        vol = _hourly_vol(data, m, sym)
        p = Prediction(timestamp=t, asset=k, model_id="ensemble.sleeves", horizon_hours=h,
                       expected_return=er, direction=1 if tgt > now_w else -1, confidence=conf,
                       uncertainty=vol, risk=vol, expected_cost=cost, expected_net_edge=net)
        ctx = TradeContext(now=now, last_data_time=t + pd.Timedelta(hours=1),   # bar CLOSE (O20)
                           half_spread_bps=float(cost_model.half_spread(sym, m)),
                           adv_quote=adv, risk_halt=halt, risk_reasons=tuple(reasons))
        g, dec = gate(p, ctx, nt_cfg)
        if dec.trade:
            final[k] = tgt
        else:
            vetoes[k] = g.reason
            final[k] = now_w                     # HOLD, never flatten
    target: Weights = {"spot": {}, "perp": {}}
    for key, v in final.items():
        if np.isfinite(v) and abs(v) > 1e-12:
            sym, m = split_key(key)
            target.setdefault(m, {})[sym] = float(v)
    calibrated = any(math.isfinite(c["beta"]) for c in calib.values())
    return target, {"mode": "active" if calibrated else "shadow", "health_multipliers": mult,
                    "calibration": calib, "proposal": proposal, "no_trade": vetoes}
