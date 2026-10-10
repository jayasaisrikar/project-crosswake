from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from engine.costs import CostModel
from engine.research.contract import H2_START, Prediction
from engine.research.holdout_guard import H2Violation, assert_research_window, h2_open_count, open_h2
from engine.research.hypothesis import Hypothesis, load_hypotheses
from engine.research.multiple_testing import benjamini_hochberg, holm
from engine.research.perturbation import stability_score
from engine.research.promotion import decide
from engine.research.registry import ExperimentRecord, ResearchRegistry
from engine.research.runner import ResearchDataset, RunConfig, run_experiment
from engine.research.splits import purged_kfold, walk_forward

IDX = pd.date_range("2023-01-01", periods=400, freq="h", tz="UTC")


# ---------- holdout guard ----------
def test_guard_raises_on_h2() -> None:
    assert_research_window(IDX)
    with pytest.raises(H2Violation):
        assert_research_window(pd.DatetimeIndex([H2_START - pd.Timedelta(hours=1), H2_START]))
    with pytest.raises(H2Violation):
        assert_research_window(pd.Series([1.0], index=[H2_START + pd.Timedelta(days=3)]))


def test_open_h2_appends(tmp_path: Path) -> None:
    log = tmp_path / "h.jsonl"
    log.write_text(json.dumps({"reason": "old H1", "holdout_start": "2024-07-01"}) + "\n")
    assert h2_open_count(log) == 0
    assert open_h2("final eval A", log) == 1
    assert open_h2("final eval B", log) == 2
    lines = log.read_text().splitlines()
    assert len(lines) == 3 and json.loads(lines[0])["reason"] == "old H1"
    with pytest.raises(ValueError):
        open_h2("  ", log)


# ---------- splits: purging correctness ----------
@pytest.mark.parametrize("h,emb", [(0, 0), (5, 0), (5, 10)])
def test_purged_kfold_no_label_overlap(h: int, emb: int) -> None:
    H, E = pd.Timedelta(hours=h), pd.Timedelta(hours=emb)
    for sp in purged_kfold(IDX, 5, H, E):
        tr, te = IDX[sp.train], IDX[sp.test]
        assert not set(sp.train) & set(sp.test)
        # no train label interval [t, t+h] intersects [test_start, test_end + h]
        assert not ((tr + H >= te[0]) & (tr <= te[-1] + H)).any()
        # embargo after test block
        assert not ((tr > te[-1]) & (tr <= te[-1] + H + E)).any()


def test_walk_forward_purged_and_expanding() -> None:
    H, E = pd.Timedelta(hours=24), pd.Timedelta(hours=12)
    splits = walk_forward(IDX, 4, H, E)
    assert len(splits) == 4
    prev = 0
    for sp in splits:
        tr = IDX[sp.train]
        assert (tr + H < sp.test_start - E).all()
        assert len(sp.train) >= prev
        prev = len(sp.train)
    assert all(a.test_end < b.test_start for a, b in zip(splits, splits[1:], strict=False))


def test_splits_refuse_h2() -> None:
    idx = pd.date_range(H2_START - pd.Timedelta(hours=10), periods=20, freq="h")
    with pytest.raises(H2Violation):
        walk_forward(idx, 2)
    with pytest.raises(H2Violation):
        purged_kfold(idx, 2)


# ---------- registry immutability ----------
def _rec(fam: str = "f", sr: float = 0.1) -> ExperimentRecord:
    return ExperimentRecord("H-1", fam, "m1", {"a": 1}, 0, "abc", {}, {}, {"sharpe_daily": sr}, {},
                            "REJECT", "test")


def test_registry_append_only_monotonic(tmp_path: Path) -> None:
    reg = ResearchRegistry(tmp_path / "r.jsonl")
    ids = [reg.register(_rec()) for _ in range(3)]
    assert ids == ["EXP-000001", "EXP-000002", "EXP-000003"]
    before = (tmp_path / "r.jsonl").read_text()
    reg.register(_rec("g", 0.2))
    after = (tmp_path / "r.jsonl").read_text()
    assert after.startswith(before)  # earlier lines untouched
    assert reg.trial_count("f") == 3 and reg.trial_count("g") == 1
    assert reg.trial_sharpes("f") == [0.1, 0.1, 0.1]
    reg.verify()
    r = reg.records()[0]
    for k in ("git_commit", "git_dirty", "versions", "dataset_hash", "params", "seed", "decision"):
        assert k in r
    assert "python" in r["versions"]
    # tampering (deleting a line) is detected
    lines = after.splitlines()
    (tmp_path / "r.jsonl").write_text("\n".join(lines[1:]) + "\n")
    with pytest.raises(RuntimeError):
        reg.verify()
    with pytest.raises(ValueError):
        reg.register(replace(_rec(), decision="MAYBE"))


# ---------- hypothesis loader ----------
def test_hypotheses_absent_and_present(tmp_path: Path) -> None:
    assert load_hypotheses(tmp_path / "missing.yaml") == []
    p = tmp_path / "h.yaml"
    p.write_text("hypotheses:\n  - id: H-001\n    research_ids: [R1]\n    statement: s\n"
                 "    features: [f1, f2]\n    target: fwd_ret_24h\n    family: mom\n    testable_now: true\n")
    hs = load_hypotheses(p)
    assert hs[0].id == "H-001" and hs[0].features == ("f1", "f2") and hs[0].testable_now


# ---------- multiple testing / perturbation ----------
def test_holm_bh() -> None:
    p = [0.01, 0.04, 0.03, 0.5]
    rej, adj = holm(p)
    assert list(rej) == [True, False, False, False]
    assert np.allclose(adj, [0.04, 0.09, 0.09, 0.5])
    rej2, q = benjamini_hochberg(p)
    assert list(rej2) == [True, False, False, False]
    assert np.allclose(q, [0.04, 0.16 / 3, 0.16 / 3, 0.5])
    assert list(benjamini_hochberg([0.01, 0.02, 0.03, 0.04])[0]) == [True] * 4


def test_stability() -> None:
    s = stability_score([1.0, 0.5, -0.2, float("nan")], 1.0)
    assert s["frac_positive"] == 0.5 and s["n_neighbors"] == 4


# ---------- decide determinism ----------
GOOD: dict[str, Any] = {
    "leakage_pass": True, "oos_sharpe": 1.5, "cost_stress_sharpe": 1.0, "dsr": 0.99, "pbo": 0.1,
    "hac_p": 0.01, "n_trades": 200, "oos_days": 700, "perturbation_frac_positive": 0.9,
    "regime_sharpes": {"bull": 1.0, "bear": 0.5, "chop": 0.2},
    "pbo_degenerate": False, "alpha_p": 0.01, "alpha_ann": 0.2,
}


def test_decide_deterministic_and_rules() -> None:
    d1, d2 = decide(dict(GOOD)), decide(dict(GOOD))
    assert d1 == d2 and d1.decision == "PROMOTE" and not d1.live_eligible
    assert decide({**GOOD, "leakage_pass": False}).decision == "REJECT"
    assert decide({**GOOD, "oos_sharpe": float("nan")}).decision == "REJECT"
    assert decide({**GOOD, "cost_stress_sharpe": -0.1}).decision == "REJECT"
    assert decide({**GOOD, "n_trades": 3}).decision == "INCONCLUSIVE"
    assert decide({**GOOD, "dsr": 0.7}).decision == "WATCH"
    assert decide({**GOOD, "dsr": 0.1, "oos_sharpe": 0.2}).decision == "INCONCLUSIVE"
    rs = decide({**GOOD, "regime_sharpes": {"a": 1.0, "b": -1.0, "c": -0.5}})
    assert rs.decision == "PROMOTE" and rs.regime_specific
    live = decide({**GOOD, "paper_trading_days": 90, "paper_sharpe": 0.5})
    assert live.live_eligible
    with pytest.raises(TypeError):
        decide(GOOD, override=True)  # type: ignore[call-arg]


def test_decide_v2_bug_fixes() -> None:
    from engine.research.promotion import decide_v1

    # degenerate PBO: v1 rejected (1.0 > 0.5); v2 -> INCONCLUSIVE
    deg = {**GOOD, "pbo": 1.0, "pbo_degenerate": True}
    assert decide_v1(deg).decision == "REJECT"
    assert decide(deg).decision == "INCONCLUSIVE"
    # NaN PBO cannot pass (v1 let it reach WATCH)
    nan_pbo = {**GOOD, "pbo": float("nan"), "dsr": 0.7}
    assert decide_v1(nan_pbo).decision == "WATCH"
    assert decide(nan_pbo).decision == "INCONCLUSIVE"
    # a real (non-degenerate) PBO above 0.5 still rejects
    assert decide({**GOOD, "pbo": 0.6}).decision == "REJECT"
    # benchmark gate: insignificant alpha cannot PROMOTE; negative alpha cannot WATCH
    assert decide({**GOOD, "alpha_p": 0.3}).decision == "WATCH"
    assert decide({**GOOD, "alpha_p": 0.9, "alpha_ann": -0.1}).decision == "INCONCLUSIVE"
    assert decide({**GOOD, "alpha_p": float("nan")}).decision == "INCONCLUSIVE"
    assert decide_v1({**GOOD, "alpha_p": 0.9, "alpha_ann": -0.1}).decision == "PROMOTE"


# ---------- runner ----------
class MomModel:
    def __init__(self, lookback: int = 24, peek: bool = False) -> None:
        self.model_id = f"mom{lookback}"
        self.horizon_hours = 6
        self.lookback = lookback
        self.peek = peek

    def fit(self, data: object, end: pd.Timestamp) -> None:
        assert isinstance(data, pd.DataFrame) and data.index.max() <= end

    def predict(self, data: object, t: pd.Timestamp) -> list[Prediction]:
        assert isinstance(data, pd.DataFrame)
        px = data["BTC"]
        if self.peek:  # uses the future when given the full frame -> must fail causality check
            ret = float(px.iloc[-1] / px.loc[t] - 1)
        else:
            hist = px.loc[:t]
            ret = float(hist.iloc[-1] / hist.iloc[max(0, len(hist) - 1 - self.lookback)] - 1)
        d = 1 if ret > 0 else -1 if ret < 0 else 0
        return [Prediction(t, "BTC", self.model_id, 6, ret, d, float("nan"), 0.01, 0.01)]  # type: ignore[arg-type]


def _ds() -> ResearchDataset:
    rng = np.random.default_rng(0)
    idx = pd.date_range("2024-01-01", periods=24 * 120, freq="h", tz="UTC")
    r = pd.Series(rng.normal(0.0001, 0.005, len(idx)), index=idx)
    px = (1 + r).cumprod() * 100
    return ResearchDataset(px.to_frame("BTC"), r.to_frame("BTC"), "synthetic")


COSTS = CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.7)


def test_runner_end_to_end(tmp_path: Path) -> None:
    reg = ResearchRegistry(tmp_path / "r.jsonl")
    hyp = Hypothesis(id="H-T", family="mom", params={"lookback": 24})
    res = run_experiment(hyp, lambda p: MomModel(**p), _ds(), COSTS,
                         config=RunConfig(n_splits=3, embargo=pd.Timedelta(hours=24),
                                          param_grid={"lookback": [12, 48]}, bootstrap_n=50),
                         regime_labeler=lambda ix: pd.Series(np.where(ix.month % 2, "a", "b"), index=ix),
                         registry=reg)
    assert res.exp_id == "EXP-000001"
    assert res.results["leakage_pass"] is True
    assert res.decision.decision in ("REJECT", "INCONCLUSIVE", "WATCH", "PROMOTE")
    assert res.results["cost_stress_sharpe"] < res.results["oos_sharpe"]
    assert set(res.results["regime_sharpes"]) == {"a", "b"}
    assert res.net_returns.index.max() < H2_START
    assert reg.trial_count("mom") == 1


def test_runner_detects_peeking_and_refuses_h2(tmp_path: Path) -> None:
    reg = ResearchRegistry(tmp_path / "r.jsonl")
    hyp = Hypothesis(id="H-P", family="mom")
    res = run_experiment(hyp, lambda p: MomModel(peek=True), _ds(), COSTS,
                         config=RunConfig(n_splits=2, bootstrap_n=20), registry=reg)
    assert res.results["leakage_pass"] is False and res.decision.decision == "REJECT"
    ds = _ds()
    idx = pd.date_range(H2_START - pd.Timedelta(days=1), periods=48, freq="h")
    bad = ResearchDataset(ds.data, pd.DataFrame({"BTC": 0.0}, index=idx))
    with pytest.raises(H2Violation):
        run_experiment(hyp, lambda p: MomModel(), bad, COSTS, registry=reg)
