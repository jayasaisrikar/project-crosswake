"""Deterministic promotion decision from pre-registered rules.

`decide(results)` applies config/promotion_rules_v2.yaml (pre-registered 2026-10-10 after the
batch_001 invalidation; bug fixes from review 01). `decide_v1(results)` reproduces the frozen v1
rules (config/promotion_rules.yaml) that batch_001 was decided under. Neither has an override
parameter: the only inputs are the results and the frozen rules file. Missing / NaN metrics fail
their criterion (absence of evidence is not evidence).

v2 additional keys: pbo_degenerate (bool), alpha_p, alpha_ann (vs buy-and-hold benchmark).

Expected `results` keys: leakage_pass (bool), oos_sharpe, cost_stress_sharpe, dsr, pbo, hac_p,
n_trades, oos_days, perturbation_frac_positive, regime_sharpes ({regime: sharpe}, optional),
paper_trading_days, paper_sharpe (optional; only for live eligibility).
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

RULES_PATH = Path(__file__).resolve().parents[3] / "config" / "promotion_rules.yaml"
RULES_V2_PATH = Path(__file__).resolve().parents[3] / "config" / "promotion_rules_v2.yaml"
PRE_REGISTERED = "2026-10-10"


@dataclass(frozen=True)
class PromotionDecision:
    decision: str                       # REJECT / INCONCLUSIVE / WATCH / PROMOTE
    reasons: tuple[str, ...]
    regime_specific: bool = False
    live_eligible: bool = False
    rules_sha: str = ""
    checks: dict[str, bool] = field(default_factory=dict)

    @property
    def rejection_reason(self) -> str:
        return "; ".join(self.reasons) if self.decision != "PROMOTE" else ""


def _rules(path: Path = RULES_PATH, version: int = 1) -> tuple[dict[str, Any], str]:
    raw = path.read_bytes()
    rules = yaml.safe_load(raw)
    if str(rules.get("pre_registered")) != PRE_REGISTERED:
        raise RuntimeError(f"{path.name} is not the pre-registered 2026-10-10 version")
    if int(rules.get("version", 1)) != version:
        raise RuntimeError(f"{path.name} is not rules version {version}")
    return rules, hashlib.sha256(raw).hexdigest()[:16]


def _num(results: dict[str, Any], key: str) -> float:
    v = results.get(key)
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return float("nan")
    return f


def _ge(x: float, thr: float) -> bool:
    return math.isfinite(x) and x >= thr


def _le(x: float, thr: float) -> bool:
    return math.isfinite(x) and x <= thr


def decide_v1(results: dict[str, Any]) -> PromotionDecision:
    """Frozen v1 decision (batch_001). Kept to reproduce historical decisions; do not use for new trials."""
    rules, sha = _rules()
    rj, pr, wa, lv = rules["reject_if"], rules["promote"], rules["watch"], rules["live"]
    sharpe = _num(results, "oos_sharpe")
    stress = _num(results, "cost_stress_sharpe")
    dsr = _num(results, "dsr")
    pbo = _num(results, "pbo")
    hac_p = _num(results, "hac_p")
    trades = _num(results, "n_trades")
    days = _num(results, "oos_days")
    pert = _num(results, "perturbation_frac_positive")
    regimes = {k: float(v) for k, v in (results.get("regime_sharpes") or {}).items()}

    reasons: list[str] = []
    # 1. hard rejects
    if rj["leakage_test_fail"] and results.get("leakage_pass") is not True:
        reasons.append("leakage test failed or missing")
    if rj["nonpositive_oos_sharpe"] and not (math.isfinite(sharpe) and sharpe > 0):
        reasons.append(f"OOS net Sharpe {sharpe:.3f} <= 0")
    if rj["nonpositive_cost_stress"] and not (math.isfinite(stress) and stress > 0):
        reasons.append(f"Sharpe at {pr['cost_stress_multiplier']}x costs {stress:.3f} <= 0")
    if math.isfinite(pbo) and pbo > float(rj["max_pbo"]):
        reasons.append(f"PBO {pbo:.2f} > {rj['max_pbo']}")
    if reasons:
        return PromotionDecision("REJECT", tuple(reasons), rules_sha=sha)

    # 2. sample adequacy
    if not _ge(trades, float(rules["min_trades"])):
        reasons.append(f"n_trades {trades} < {rules['min_trades']}")
    if not _ge(days, float(rules["min_oos_days"])):
        reasons.append(f"OOS days {days} < {rules['min_oos_days']}")
    if reasons:
        return PromotionDecision("INCONCLUSIVE", tuple(reasons), rules_sha=sha)

    # 3. promotion criteria
    reg_frac = (sum(v > 0 for v in regimes.values()) / len(regimes)) if regimes else float("nan")
    regime_specific = bool(regimes) and not _ge(reg_frac, float(pr["min_regimes_positive_frac"]))
    checks = {
        "oos_sharpe": _ge(sharpe, float(pr["min_oos_net_sharpe"])),
        "dsr": _ge(dsr, float(pr["min_dsr"])),
        "pbo": _le(pbo, float(pr["max_pbo"])),
        "cost_stress": _ge(stress, float(pr["min_cost_stress_sharpe"])),
        "perturbation": _ge(pert, float(pr["min_perturbation_frac_positive"])),
        "hac_p": _le(hac_p, float(pr["max_hac_p"])),
    }
    # regime consistency does not block; a failing strategy is flagged regime-specific
    checks["regimes"] = not regime_specific
    failed = [k for k, ok in sorted(checks.items()) if not ok and k != "regimes"]
    if not failed:
        paper_days = _num(results, "paper_trading_days")
        paper_sr = _num(results, "paper_sharpe")
        live = _ge(paper_days, float(lv["min_paper_trading_days"])) and (
            not lv["paper_sharpe_must_be_positive"] or (math.isfinite(paper_sr) and paper_sr > 0))
        msg = ["all pre-registered criteria passed"]
        if regime_specific:
            msg.append(f"flag: regime-specific (positive in {reg_frac:.0%} of regimes)")
        return PromotionDecision("PROMOTE", tuple(msg),
                                 regime_specific, live, sha, checks)
    reasons = [f"failed: {k}" for k in failed]
    if regime_specific:
        reasons.append(f"regime-specific: positive in {reg_frac:.0%} of regimes")
    if _ge(sharpe, float(wa["min_oos_net_sharpe"])) and _ge(dsr, float(wa["min_dsr"])):
        return PromotionDecision("WATCH", tuple(reasons), regime_specific, False, sha, checks)
    return PromotionDecision("INCONCLUSIVE", tuple(reasons), regime_specific, False, sha, checks)


def decide(results: dict[str, Any]) -> PromotionDecision:
    """v2 decision (config/promotion_rules_v2.yaml). Order: hard REJECT -> sample adequacy ->
    PBO validity -> benchmark availability -> PROMOTE / WATCH / INCONCLUSIVE."""
    rules, sha = _rules(RULES_V2_PATH, 2)
    rj, pr, wa, lv = rules["reject_if"], rules["promote"], rules["watch"], rules["live"]
    bm, pv = rules["benchmark"], rules["pbo_validity"]
    sharpe = _num(results, "oos_sharpe")
    stress = _num(results, "cost_stress_sharpe")
    dsr = _num(results, "dsr")
    pbo = _num(results, "pbo")
    degenerate = results.get("pbo_degenerate") is True
    hac_p = _num(results, "hac_p")
    trades = _num(results, "n_trades")
    days = _num(results, "oos_days")
    pert = _num(results, "perturbation_frac_positive")
    alpha_p = _num(results, "alpha_p")
    alpha_ann = _num(results, "alpha_ann")
    regimes = {k: float(v) for k, v in (results.get("regime_sharpes") or {}).items()}

    reasons: list[str] = []
    # 1. hard rejects
    if rj["leakage_test_fail"] and results.get("leakage_pass") is not True:
        reasons.append("leakage test failed or missing")
    if rj["nonpositive_oos_sharpe"] and not (math.isfinite(sharpe) and sharpe > 0):
        reasons.append(f"OOS net Sharpe {sharpe:.3f} <= 0")
    if rj["nonpositive_cost_stress"] and not (math.isfinite(stress) and stress > 0):
        reasons.append(f"Sharpe at {pr['cost_stress_multiplier']}x costs {stress:.3f} <= 0")
    if not degenerate and math.isfinite(pbo) and pbo > float(rj["max_pbo"]):
        reasons.append(f"PBO {pbo:.2f} > {rj['max_pbo']}")
    if reasons:
        return PromotionDecision("REJECT", tuple(reasons), rules_sha=sha)

    # 2. sample adequacy
    if not _ge(trades, float(rules["min_trades"])):
        reasons.append(f"n_trades {trades} < {rules['min_trades']}")
    if not _ge(days, float(rules["min_oos_days"])):
        reasons.append(f"OOS days {days} < {rules['min_oos_days']}")
    if reasons:
        return PromotionDecision("INCONCLUSIVE", tuple(reasons), rules_sha=sha)

    # 3. PBO validity: degenerate / NaN PBO cannot pass anything
    if degenerate:
        return PromotionDecision(str(pv["degenerate_decision"]), (
            f"PBO degenerate (< {pv['min_distinct_variants']} distinct variants): "
            "overfitting not assessable",),
            rules_sha=sha)
    if not math.isfinite(pbo):
        return PromotionDecision(str(pv["nan_decision"]), ("PBO missing/NaN: cannot pass",), rules_sha=sha)

    # 4. benchmark availability
    if not (math.isfinite(alpha_p) and math.isfinite(alpha_ann)):
        return PromotionDecision(str(bm["missing_decision"]), ("alpha vs buy-and-hold missing/NaN",),
                                 rules_sha=sha)

    # 5. promotion criteria
    reg_frac = (sum(v > 0 for v in regimes.values()) / len(regimes)) if regimes else float("nan")
    regime_specific = bool(regimes) and not _ge(reg_frac, float(pr["min_regimes_positive_frac"]))
    checks = {
        "oos_sharpe": _ge(sharpe, float(pr["min_oos_net_sharpe"])),
        "dsr": _ge(dsr, float(pr["min_dsr"])),
        "pbo": _le(pbo, float(pr["max_pbo"])),
        "cost_stress": _ge(stress, float(pr["min_cost_stress_sharpe"])),
        "perturbation": _ge(pert, float(pr["min_perturbation_frac_positive"])),
        "hac_p": _le(hac_p, float(pr["max_hac_p"])),
        "alpha_vs_benchmark": _le(alpha_p, float(bm["promote_max_alpha_p"])) and alpha_ann > 0,
    }
    checks["regimes"] = not regime_specific
    failed = [k for k, ok in sorted(checks.items()) if not ok and k != "regimes"]
    if not failed:
        paper_days = _num(results, "paper_trading_days")
        paper_sr = _num(results, "paper_sharpe")
        live = _ge(paper_days, float(lv["min_paper_trading_days"])) and (
            not lv["paper_sharpe_must_be_positive"] or (math.isfinite(paper_sr) and paper_sr > 0))
        msg = ["all pre-registered v2 criteria passed"]
        if regime_specific:
            msg.append(f"flag: regime-specific (positive in {reg_frac:.0%} of regimes)")
        return PromotionDecision("PROMOTE", tuple(msg), regime_specific, live, sha, checks)
    reasons = [f"failed: {k}" for k in failed]
    if regime_specific:
        reasons.append(f"regime-specific: positive in {reg_frac:.0%} of regimes")
    if (_ge(sharpe, float(wa["min_oos_net_sharpe"])) and _ge(dsr, float(wa["min_dsr"]))
            and alpha_ann > float(bm["watch_min_alpha_ann"])):
        return PromotionDecision("WATCH", tuple(reasons), regime_specific, False, sha, checks)
    return PromotionDecision("INCONCLUSIVE", tuple(reasons), regime_specific, False, sha, checks)
