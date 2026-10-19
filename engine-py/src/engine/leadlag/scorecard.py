"""§11 research scorecard + PRE-REGISTERED rejection rules for the lead-lag candidates.

The master prompt is explicit: do NOT pick a winner on raw return, set rejection criteria BEFORE
looking at the untouched holdout, and an honest "no edge" is a valid, respected outcome. So this module
(a) builds one consistent scorecard row per candidate on the DEVELOPMENT window only, covering the §11
metric set, and (b) applies a fixed gate whose thresholds are declared here in code and never tuned to
the data. The holdout is never read here.

Each criterion targets a distinct failure mode a profitable-looking backtest can still hide:
  R1 net Sharpe > 0        -- positive risk-adjusted return AFTER costs, not just positive return
  R2 net total return > 0  -- actually makes money net of fees/spread/impact/funding
  R3 gross Sharpe > 0      -- a signal exists even at zero trade cost; if not, it is a dead signal,
                              not merely an expensive one (distinguishes "no edge" from "too costly")
  R4 incr. Sharpe > 0      -- beats the best risk-matched baseline (incremental value over simple rules)
  R5 |HAC t| > 2.0         -- mean daily return is statistically distinguishable from zero (Newey-West)
  R6 stress Sharpe > 0     -- survives the 2x elevated-cost stress (not fragile to cost assumptions)
A candidate PASSES only if it clears ALL six. DSR (deflated Sharpe, accounting for the number of trials
in the registry) is reported for context but kept out of the hard gate because every candidate here
already fails earlier, cheaper criteria -- it is recorded so the honest-null verdict is auditable."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from engine.validation import metrics
from engine.validation.stats import deflated_sharpe, sharpe_hac_tstat

log = logging.getLogger(__name__)

# Numerical failures expected from short / degenerate series; anything else is a bug and propagates.
STAT_ERRORS = (ValueError, ZeroDivisionError, FloatingPointError, np.linalg.LinAlgError)

# PRE-REGISTERED gate (declared before inspecting final results; see module docstring for rationale).
REJECTION = {
    "min_net_sharpe": 0.0,
    "min_net_total_return": 0.0,
    "min_gross_sharpe": 0.0,
    "min_incremental_sharpe": 0.0,
    "min_abs_hac_t": 2.0,
    "min_stress_sharpe": 0.0,
}

SCORE_KEYS = ("total_return", "cagr", "ann_vol", "sharpe", "sortino", "calmar", "max_drawdown",
              "hit_rate", "profit_factor", "expectancy")


@dataclass
class Candidate:
    """One strategy variant, evaluated on the dev window. `gross`/`stress` are the same variant priced
    at 0x and 2x trade cost; omit for pure baselines (cost sensitivity then not assessed)."""

    name: str
    net: pd.Series                       # dev hourly returns at 1x cost
    gross: pd.Series | None = None       # dev hourly returns at 0x trade cost
    stress: pd.Series | None = None      # dev hourly returns at 2x cost
    n_trades: int = 0
    turnover_annual: float = 0.0
    is_baseline: bool = False
    meta: dict[str, Any] = field(default_factory=dict)


def _sharpe(r: pd.Series | None) -> float:
    if r is None or not len(pd.Series(r).dropna()):
        return float("nan")
    return float(metrics.performance_summary(r).get("sharpe", float("nan")))


def build(candidates: list[Candidate], trial_sharpes: list[float] | None = None) -> pd.DataFrame:
    """Score every candidate on the §11 metric set. `incremental_sharpe` is net Sharpe minus the best
    baseline net Sharpe among the candidates flagged is_baseline. trial_sharpes feed the DSR."""
    base_sharpe = max((_sharpe(c.net) for c in candidates if c.is_baseline), default=float("nan"))
    trials = trial_sharpes or []
    rows: list[dict[str, Any]] = []
    for c in candidates:
        s = metrics.performance_summary(c.net)
        gross_sh, net_sh, stress_sh = _sharpe(c.gross), s.get("sharpe", float("nan")), _sharpe(c.stress)
        daily = metrics.daily_returns(c.net)
        errors: list[str] = []
        try:
            hac_t = sharpe_hac_tstat(c.net) if len(daily) > 5 else float("nan")
        except STAT_ERRORS as e:
            log.warning("scorecard %s: HAC t-stat failed: %s: %s", c.name, type(e).__name__, e)
            errors.append(f"hac_t: {type(e).__name__}: {e}")
            hac_t = float("nan")
        try:
            dsr = deflated_sharpe(daily, trials) if len(daily) > 5 and len(trials) >= 2 else float("nan")
        except STAT_ERRORS as e:
            log.warning("scorecard %s: DSR failed: %s: %s", c.name, type(e).__name__, e)
            errors.append(f"dsr: {type(e).__name__}: {e}")
            dsr = float("nan")
        incr = (net_sh - base_sharpe) if (base_sharpe == base_sharpe and not c.is_baseline) else float("nan")
        row: dict[str, Any] = {"strategy": c.name, "is_baseline": c.is_baseline,
                               "n_trades": c.n_trades, "turnover_annual": round(c.turnover_annual, 2)}
        row.update({k: (round(float(s[k]), 4) if s.get(k) is not None and s.get(k) == s.get(k)
                        else None) for k in SCORE_KEYS})
        row.update({"gross_sharpe": round(gross_sh, 4) if gross_sh == gross_sh else None,
                    "stress_sharpe": round(stress_sh, 4) if stress_sh == stress_sh else None,
                    "cost_sensitivity": round(gross_sh - net_sh, 4)
                    if (gross_sh == gross_sh and net_sh == net_sh) else None,
                    "incremental_sharpe": round(incr, 4) if incr == incr else None,
                    "hac_t": round(hac_t, 3) if hac_t == hac_t else None,
                    "dsr": round(dsr, 4) if dsr == dsr else None,
                    "stat_errors": "; ".join(errors) or None})
        if not c.is_baseline:
            passed, reason = _gate(net_sh, s.get("total_return"), gross_sh, incr, hac_t, stress_sh)
            row["gate"] = "PASS" if passed else "REJECT"
            row["reject_reason"] = reason
        else:
            row["gate"], row["reject_reason"] = "baseline", ""
        rows.append(row)
    return pd.DataFrame(rows)


def _gate(net_sh: float, total: Any, gross_sh: float, incr: float, hac_t: float,
          stress_sh: float) -> tuple[bool, str]:
    """Apply REJECTION in order; return (passed, first failing reason). NaN on a tested field fails."""
    checks = [
        (net_sh > REJECTION["min_net_sharpe"], "net_sharpe<=0"),
        (total is not None and float(total) > REJECTION["min_net_total_return"], "net_return<=0"),
        (gross_sh > REJECTION["min_gross_sharpe"], "no_gross_edge"),
        (incr == incr and incr > REJECTION["min_incremental_sharpe"], "no_incremental_edge"),
        (abs(hac_t) > REJECTION["min_abs_hac_t"] if hac_t == hac_t else False, "hac_t_insignificant"),
        (stress_sh > REJECTION["min_stress_sharpe"] if stress_sh == stress_sh else True,
         "cost_fragile"),
    ]
    for ok, reason in checks:
        if not ok:
            return False, reason
    return True, ""


def verdict(scorecard: pd.DataFrame) -> str:
    """Overall research verdict from a built scorecard."""
    cand = scorecard[~scorecard["is_baseline"]]
    winners = cand[cand["gate"] == "PASS"]["strategy"].tolist()
    if winners:
        return "EDGE: " + ", ".join(winners)
    return "NO EDGE: no candidate cleared the pre-registered rejection gate on the dev window"
