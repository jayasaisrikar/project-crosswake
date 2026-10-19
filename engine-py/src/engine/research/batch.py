"""Research batch 002: pre-registered hypothesis x model runs through engine.research.runner, under
config/promotion_rules_v2.yaml, after batch_001 was invalidated (reports/research/batch_001/INVALIDATED.md;
review 01 #1, #2: batch_001 measured buy-and-hold beta, and PBO was degenerate).

Two phases, run separately so the plan is on disk BEFORE any result exists:
  uv run python -m engine.research.batch plan   -> reports/research/batch_002/plan.yaml (timestamped)
  uv run python -m engine.research.batch run    -> registers every experiment, writes results.md

`run` refuses to start unless plan.yaml exists and its experiment spec equals the in-code PLAN
(no silent re-tuning). Every experiment is registered in experiments/exp_registry.jsonl (append-only),
crashes included (decision INCONCLUSIVE, reason "crash: ..."). Data strictly < H2_START.
batch_001's plan/results stay on disk as recorded; this module no longer reproduces its spec.

What changed vs batch_001 (review 01): direction from the signal term only and xs books demeaned (#1);
PBO dedupe / mid-ranks / strict logit / >= 5 distinct variants (#2, #3); DSR N = all registry trials +
neighbours (#4); xs models need >= 3 assets, enforced at plan time (#5); panel-once prediction (#6);
funding in perp PnL (#7); buy-and-hold alpha gate (#8); xs ranks over the PIT universe at t only (#9);
leakage checks that can fail (#10); lead-lag earns from one bar later (#11); fills at open t+1 and
equal weight across predicted assets (#12).
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import time
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

from engine.contracts import Dataset, MarketData
from engine.costs import CostModel
from engine.research.contract import H2_START, Prediction, SignalModel
from engine.research.holdout_guard import assert_research_window
from engine.research.hypothesis import Hypothesis, load_hypotheses
from engine.research.multiple_testing import benjamini_hochberg, holm, pbo_cscv, strategy_stats
from engine.research.promotion import decide
from engine.research.registry import ExperimentRecord, ResearchRegistry, dataset_hash

BATCH = "batch_002"
OUT = Path("reports/research") / BATCH
PLAN_PATH = OUT / "plan.yaml"
DATA_START = "2020-01-01"
TOP_N = 15                       # PIT universe: top-N perps by trailing 30d ADV, monthly rebalance
MAJORS = ["BTC", "ETH"]
ALPHA = 0.05
REGIME_COLUMN = "trend"          # engine.regimes.api.labels(...)[trend]: bull / bear / sideways (BTC)
MIN_DISTINCT_VARIANTS = 5        # promotion_rules_v2 pbo_validity.min_distinct_variants
UNIVERSE_SIZE = {"majors": len(MAJORS), "pit_top_n": TOP_N}

# Pre-declared mapping. universe: "majors" = BTC+ETH (hypothesis is about BTC/ETH),
# "pit_top_n" = point-in-time top-N liquid perps. param_grid: one-at-a-time neighbours around `params`;
# every grid yields >= 4 neighbours whose positions genuinely differ in sign mode (so >= 5 variants).
PLAN: list[dict[str, Any]] = [
    {"hypothesis": "H-0001", "model_id": "tsmom", "universe": "majors", "params": {"horizon_hours": 24},
     "param_grid": {"lookbacks_days": [[3, 14, 60], [7, 30, 90], [14, 60, 120]],
                    "horizon_hours": [24, 72, 168]}},
    {"hypothesis": "H-0001", "model_id": "donchian", "universe": "majors", "params": {"horizon_hours": 24},
     "param_grid": {"lookbacks_days": [[10, 20], [20, 55], [55, 100]], "horizon_hours": [24, 72, 168]}},
    {"hypothesis": "H-0002", "model_id": "xs_mom", "universe": "pit_top_n",
     "params": {"formation_days": 30, "skip_days": 1, "horizon_hours": 168},
     "param_grid": {"formation_days": [7, 14, 30, 60], "skip_days": [0, 1]}},
    {"hypothesis": "H-0002", "model_id": "residual_mom", "universe": "pit_top_n",
     "params": {"formation_days": 30, "beta_days": 60, "horizon_hours": 168},
     "param_grid": {"formation_days": [14, 30, 60], "beta_days": [30, 60, 90]}},
    {"hypothesis": "H-0008", "model_id": "funding_reversion", "universe": "pit_top_n", "params": {},
     "param_grid": {"apr_hours": [24, 72, 168], "threshold": [1.0, 1.5, 2.0]}},
    {"hypothesis": "H-0010", "model_id": "basis_reversion", "universe": "pit_top_n", "params": {},
     "param_grid": {"z_hours": [24, 72, 168, 336, 720]}},
    {"hypothesis": "H-0011", "model_id": "st_reversal", "universe": "pit_top_n",
     "params": {"lookback_hours": 4, "horizon_hours": 4},
     "param_grid": {"lookback_hours": [1, 4, 12, 24], "horizon_hours": [4, 8]}},
    {"hypothesis": "H-0011", "model_id": "zscore_reversal", "universe": "majors",
     "params": {"horizon_hours": 4}, "param_grid": {"window_hours": [24, 48, 72, 168, 336]}},
    {"hypothesis": "H-0011", "model_id": "ar", "universe": "majors",
     "params": {"horizon_hours": 4, "order": 3}, "param_grid": {"order": [1, 2, 3, 5, 8]}},
    {"hypothesis": "H-0013", "model_id": "voladj_reversal", "universe": "pit_top_n", "params": {},
     "param_grid": {"lookback_hours": [12, 24, 48], "short_vol_hours": [48, 72, 168]}},
    {"hypothesis": "H-0020", "model_id": "ridge", "universe": "pit_top_n",
     "params": {"cross_sectional": True, "horizon_hours": 24, "ridge": 10.0},
     "param_grid": {"ridge": [1.0, 10.0, 100.0, 1000.0], "horizon_hours": [24, 72]}},
    {"hypothesis": "H-0020", "model_id": "logit_sign", "universe": "pit_top_n",
     "params": {"cross_sectional": True, "horizon_hours": 24, "ridge": 1.0},
     "param_grid": {"ridge": [0.1, 1.0, 10.0, 100.0], "horizon_hours": [24, 72]}},
]

UNMAPPED: dict[str, str] = {
    "H-0003": "no conditional panic-state scaling model in engine.models",
    "H-0004": "vol_managed_tsmom only rescales |score|; in the pre-registered sign mode the scale is "
              "discarded, "
              "so the runner cannot test exposure scaling (batch_001 EXP-000005 measured trend sign only)",
    "H-0005": "volatility-forecast QLIKE comparison, not a trading signal (runner measures PnL)",
    "H-0006": "same model as H-0004 (HAR sizing); not testable in sign mode for the same reason",
    "H-0007": "delta-neutral carry needs spot+perp legs; runner is single-leg",
    "H-0009": "no cross-sectional funding-carry SignalModel in engine.models (funding PnL now exists)",
    "H-0012": "conditional abnormal-move model not implemented",
    "H-0015": "regime-conditional lead-lag model not implemented",
    "H-0016": "perp->spot lead-lag model not implemented (lead-lag engine verdict: no edge)",
    "H-0017": "transfer-entropy model not implemented",
    "H-0018": "HMM-conditioned trend model not implemented",
    "H-0019": "BOCPD exposure overlay not implemented",
    "H-0021": "intraday time-of-day model not implemented",
    "H-0022": "long-horizon reversal model not implemented; history too short for 1y lookbacks",
    "H-0023": "meta-hypothesis: answered by this batch's DSR/PBO/BH outputs, not a separate model",
    "H-0030": "funding sign-flip event model not implemented",
}

RUN_CONFIG: dict[str, Any] = {"n_splits": 5, "embargo_hours": 168, "position_mode": "sign", "seed": 0,
                              "bootstrap_n": 500, "pbo_min_distinct": MIN_DISTINCT_VARIANTS,
                              "causality_checks": 3}

LEADLAG_TRIAL = {
    "hypothesis": "H-0014", "pair": "BTC->ADA", "family": "leadlag",
    "method": "re-run engine.leadlag.engine.walk_forward (unchanged code/params) for all pairs, then "
              "re-price every pair with ONE EXTRA BAR of execution delay (position decided at t earns "
              "y[t+2], review 01 #11); BH + Holm over the pairs' delayed OOS net HAC p-values; DSR of "
              "BTC->ADA vs all registry trials + pairs; PBO over the fixed-lag variants (>= 5 distinct); "
              "leakage = truncation re-run must reproduce the overlapping folds",
}


def plan_spec() -> dict[str, Any]:
    from engine.models.registry import REGISTRY, build_model

    exps = []
    for e in PLAN:
        spec = REGISTRY[e["model_id"]]
        params = {**spec.defaults, **e["params"]}
        m = build_model(e["model_id"], **params)
        is_xs = bool(getattr(m, "xs", False))
        if is_xs and UNIVERSE_SIZE[e["universe"]] < 3:
            raise ValueError(f"plan: cross-sectional model {e['model_id']} needs >= 3 assets, universe "
                             f"{e['universe']} has {UNIVERSE_SIZE[e['universe']]} (review 01 #5)")
        n_nbr = sum(sum(1 for v in vals if params.get(k) != v) for k, vals in e["param_grid"].items())
        if n_nbr + 1 < MIN_DISTINCT_VARIANTS:
            raise ValueError(f"plan: {e['model_id']} has {n_nbr + 1} variants < {MIN_DISTINCT_VARIANTS}")
        exps.append({**e, "params": params, "model_family": spec.family, "cross_sectional": is_xs,
                     "n_variants": n_nbr + 1})
    return {
        "batch": BATCH, "h2_start": H2_START.isoformat(), "data_start": DATA_START,
        "data_end": (H2_START - pd.Timedelta(hours=1)).isoformat(),
        "universe": {"pit_top_n": f"engine.universe.pit_universe_mask(perp, top_n={TOP_N}, monthly, "
                                  "min_history 60d, ADV 30d); cross-sectional ranks use ONLY members at t "
                                  "(model.pit_mask), predictions dropped for non-members; benchmark = "
                                  "equal-weight members",
                     "majors": MAJORS, "top_n": TOP_N},
        "regime_labeler": f"engine.regimes.api.labels(ds, statistical=False)['{REGIME_COLUMN}']",
        "costs": "config/experiment.yaml costs -> CostModel.from_config (unchanged); 2x stress by runner",
        "execution": "decision at close t, fill at open t+1; perp funding charged on positions held; "
                     "equal weight across assets predicted at t",
        "run_config": RUN_CONFIG, "alpha_bh": ALPHA,
        "promotion_rules": "config/promotion_rules_v2.yaml (pre-registered 2026-10-10 after batch_001 "
                           "invalidation)",
        "dsr_trials": "all registry trials (batch_001 included, crashes included) + neighbours + 1",
        "experiments": exps, "unmapped": UNMAPPED, "leadlag_trial": LEADLAG_TRIAL,
        "caveats": ["square-root impact not applied (runner)",
                    "position_mode=sign for every model (model-side scaling not used)",
                    "dataset columns = union of PIT members ever; ranks and predictions are PIT at t"],
    }


def _spec_sha(spec: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(spec, sort_keys=True, default=str).encode()).hexdigest()[:16]


def write_plan(path: Path = PLAN_PATH) -> Path:
    spec = plan_spec()
    if path.exists():
        raise FileExistsError(f"{path} already exists; a plan is written once")
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"created_at": datetime.now(UTC).isoformat(), "spec_sha": _spec_sha(spec), **spec}
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
    return path


def check_plan(path: Path = PLAN_PATH) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"{path} missing: write the plan before running")
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if doc.get("spec_sha") != _spec_sha(plan_spec()):
        raise RuntimeError("in-code PLAN differs from the committed plan.yaml; refusing to run")
    return dict(doc)


# ----------------------------------------------------------------------------------- data + universe
def subset(ds: Dataset, cols: list[str]) -> Dataset:
    def md(m: MarketData) -> MarketData:
        return MarketData(**{k: getattr(m, k).reindex(columns=cols) for k in m.__dataclass_fields__})

    return Dataset(md(ds.spot), md(ds.perp), ds.funding.reindex(columns=cols))


@dataclass
class PITFiltered:
    """Wraps a SignalModel; drops predictions for assets outside the causal PIT mask at t."""

    inner: Any
    mask: pd.DataFrame
    model_id: str = ""
    horizon_hours: int = 0

    def __post_init__(self) -> None:
        self.model_id = str(self.inner.model_id)
        self.horizon_hours = int(self.inner.horizon_hours)
        if hasattr(self.inner, "pit_mask"):
            self.inner.pit_mask = self.mask      # xs ranks over PIT members at t only (review 01 #9)

    def fit(self, data: object, end: pd.Timestamp) -> None:
        self.inner.fit(data, end=end)

    def _keep(self, ps: list[Prediction]) -> list[Prediction]:
        out = []
        for p in ps:
            if p.timestamp in self.mask.index and bool(self.mask.loc[p.timestamp].get(p.asset, False)):
                out.append(p)
        return out

    def predict(self, data: object, t: pd.Timestamp) -> list[Prediction]:
        if t not in self.mask.index:
            return []
        return self._keep(self.inner.predict(data, t))

    def predict_many(self, data: object, times: list[pd.Timestamp]) -> list[Prediction]:
        many = getattr(self.inner, "predict_many", None)
        if callable(many):
            return self._keep(list(many(data, times)))
        out: list[Prediction] = []
        for t in times:
            out.extend(self.predict(data, t))
        return out


def perp_returns(ds: Dataset) -> pd.DataFrame:
    real = ~ds.perp.is_filled.reindex_like(ds.perp.close).fillna(True).astype(bool)
    return ds.perp.close.pct_change(fill_method=None).where(real)


def perp_open_returns(ds: Dataset) -> pd.DataFrame:
    """open[t] -> close[t] return of real bars (for fills at the open of t+1)."""
    real = ~ds.perp.is_filled.reindex_like(ds.perp.close).fillna(True).astype(bool)
    o = ds.perp.open.reindex_like(ds.perp.close)
    return (ds.perp.close / o.where(o > 0) - 1.0).where(real)


def perp_funding(ds: Dataset, index: pd.Index, columns: pd.Index) -> pd.DataFrame:
    """Funding rate charged in each hourly bar (events ceil-binned, causal); 0 where no event."""
    from engine.models.base import funding_hourly

    return funding_hourly(ds, index, columns).fillna(0.0)


def bh_table(pvals: list[float], alpha: float = ALPHA) -> tuple[list[bool], list[float], list[float]]:
    p = [1.0 if not (isinstance(x, int | float) and math.isfinite(x)) else float(x) for x in pvals]
    if not p:
        return [], [], []
    rej, q = benjamini_hochberg(p, alpha)
    _, h = holm(p, alpha)
    return [bool(x) for x in rej], [float(x) for x in q], [float(x) for x in h]


def _hyps() -> dict[str, Hypothesis]:
    return {h.id: h for h in load_hypotheses()}


def _crash_record(h: Hypothesis, model_id: str, params: dict[str, Any], err: str) -> ExperimentRecord:
    return ExperimentRecord(hypothesis_id=h.id, family=h.family, model_version=model_id, params=params,
                            seed=0, dataset_hash="", periods={"h2_start": H2_START.isoformat()},
                            cost_model={}, results={}, stats={}, decision="INCONCLUSIVE",
                            rejection_reason=f"crash: {err}", reasons=[f"crash: {err}"],
                            notes=f"{BATCH} crash; registered so the trial counts")


# ----------------------------------------------------------------------------------- main batch
def run_models(reg: ResearchRegistry, log: list[str]) -> list[dict[str, Any]]:
    from engine.data.load import load_dataset
    from engine.models.registry import build_model
    from engine.regimes.api import labels
    from engine.research.runner import ResearchDataset, RunConfig, run_experiment
    from engine.universe import pit_universe_mask

    t0 = time.time()
    full = load_dataset(start=DATA_START, end=H2_START - pd.Timedelta(hours=1))
    assert_research_window(full.perp.close.index)
    assert_research_window(full.spot.close.index)
    mask = pit_universe_mask(full.perp, top_n=TOP_N)
    members = sorted(c for c in mask.columns if mask[c].any())
    cols_top = sorted(set(members) | {"BTC"})
    ds_top = subset(full, cols_top)
    ds_maj = subset(full, MAJORS)
    del full
    reg_lab = labels(ds_maj, statistical=False)[REGIME_COLUMN]
    log.append(f"data loaded in {time.time() - t0:.0f}s; PIT union members={len(members)}: {members}")
    with open("config/experiment.yaml") as f:
        cm = CostModel.from_config(dict(yaml.safe_load(f))["costs"])
    hyps = _hyps()

    def regime_labeler(idx: pd.DatetimeIndex) -> pd.Series:
        return reg_lab.reindex(idx)

    out: list[dict[str, Any]] = []
    for e in plan_spec()["experiments"]:
        h = hyps[e["hypothesis"]]
        mid, params = e["model_id"], dict(e["params"])
        ds = ds_maj if e["universe"] == "majors" else ds_top
        if e["universe"] == "majors":   # listed (real close) at t
            m = ds.perp.close.notna()
        else:
            c = ds.perp.close
            m = mask.reindex(index=c.index, columns=c.columns).fillna(False).astype(bool)
        rets = perp_returns(ds)
        bw = m.reindex_like(rets).fillna(False) & rets.notna()
        bw = bw.astype(float).div(bw.sum(axis=1).replace(0, np.nan), axis=0).fillna(0.0)
        rds = ResearchDataset(ds, rets, name=f"{BATCH}:{e['universe']}", market="perp",
                              funding=perp_funding(ds, rets.index, rets.columns),
                              open_returns=perp_open_returns(ds), benchmark_weights=bw)
        cfg = RunConfig(n_splits=RUN_CONFIG["n_splits"],
                        embargo=pd.Timedelta(hours=RUN_CONFIG["embargo_hours"]),
                        position_mode=RUN_CONFIG["position_mode"], seed=RUN_CONFIG["seed"],
                        param_grid=dict(e["param_grid"]), bootstrap_n=RUN_CONFIG["bootstrap_n"],
                        pbo_min_distinct=RUN_CONFIG["pbo_min_distinct"],
                        causality_checks=RUN_CONFIG["causality_checks"])

        def factory(p: dict[str, Any], _mid: str = mid, _m: pd.DataFrame = m) -> SignalModel:
            return PITFiltered(build_model(_mid, **p), _m)

        t1 = time.time()
        row: dict[str, Any] = {"hypothesis": h.id, "model_id": mid, "universe": e["universe"]}
        try:
            res = run_experiment(h, factory, rds, cm, params=params, config=cfg,
                                 regime_labeler=regime_labeler, registry=reg)
            row.update(exp_id=res.exp_id, decision=res.decision.decision,
                       reason=res.decision.rejection_reason or "; ".join(res.decision.reasons),
                       regime_specific=res.decision.regime_specific, **res.results)
        except Exception as ex:  # noqa: BLE001 - a crash is a result; register it
            err = f"{type(ex).__name__}: {ex}"
            log.append(f"CRASH {h.id}/{mid}: {err}\n{traceback.format_exc(limit=3)}")
            exp_id = reg.register(_crash_record(h, mid, params, err))
            row.update(exp_id=exp_id, decision="INCONCLUSIVE", reason=f"crash: {err}", regime_specific=False)
        row["runtime_s"] = round(time.time() - t1, 1)
        log.append(f"{row['exp_id']} {h.id}/{mid}: {row['decision']} ({row['runtime_s']}s)")
        print(log[-1], flush=True)
        out.append(row)
    return out


def delay_one_bar(sel: pd.DataFrame, folds: pd.DataFrame) -> pd.DataFrame:
    """Re-price lead-lag OOS pnl with one extra bar of execution latency (review 01 #11).

    engine.leadlag.engine.strategy_pnl: position decided at the close of bar t earns y[t+1], where the
    leader's move is revealed at that same close (zero latency). Here the same position earns y[t+2]
    instead; costs are charged on the delayed position changes at the fold's per-side cost.
    y is a log return; `net_simple` converts the result to a simple return for daily compounding."""
    out = sel.copy().sort_index()
    pos_d = out["pos"].shift(1).fillna(0.0)
    cost = pd.Series(0.0, index=out.index)
    for r in folds.itertuples():
        inb = (out.index >= r.test_start) & (out.index < r.test_end)
        cost.loc[inb] = float(r.cost_side_bps) * 1e-4  # type: ignore[arg-type]
    gross = (pos_d * out["fwd"]).fillna(0.0)
    tc = cost * pos_d.diff().abs().fillna(pos_d.abs())
    out["pos"], out["gross"], out["net"] = pos_d, gross, gross - tc
    out["net_simple"] = np.expm1(out["net"])
    return out


def leadlag_leakage_check(LL: Any, p: Any, cm: CostModel, qv: pd.Series,
                          folds: pd.DataFrame, sel: pd.DataFrame) -> bool:
    """Truncation re-run: the engine re-run on data cut at the last fold start must reproduce every
    common fold's selected lag and OOS pnl exactly. Fails if selection or pnl used later data."""
    if len(folds) < 2:
        return False
    cut = pd.Timestamp(folds["test_start"].iloc[-1])
    hide = cut - pd.Timedelta(hours=1)
    p2 = dataclasses.replace(p, x=p.x.loc[:hide], y=p.y.loc[:hide])
    sel2, folds2, _ = LL.walk_forward(p2, cm, qv.loc[:hide], end=cut)
    if folds2.empty:
        return False
    common = folds.merge(folds2, on=["test_start", "test_end"], suffixes=("", "_t"))
    if common.empty:
        return False
    if not (common["selected_lag"] == common["selected_lag_t"]).all():
        return False
    for r in common.itertuples():
        a = sel.loc[(sel.index >= r.test_start) & (sel.index < r.test_end), "net"]
        b = sel2.loc[(sel2.index >= r.test_start) & (sel2.index < r.test_end), "net"]
        if len(a) != len(b) or not np.allclose(a.to_numpy(), b.to_numpy(), atol=1e-12, equal_nan=True):
            return False
    return True


def run_leadlag_trial(reg: ResearchRegistry, log: list[str]) -> dict[str, Any]:
    from engine.data.load import load_dataset
    from engine.leadlag import engine as LL
    from engine.regimes.labelers import trend

    syms = sorted(set(LL.ALTS + LL.SAME_ASSET + LL.BASKET + LL.SMALL + ["BTC"]))
    ds = load_dataset(symbols=syms, end=H2_START - pd.Timedelta(hours=1))
    assert_research_window(ds.perp.close.index)
    with open("config/experiment.yaml") as f:
        ccfg = dict(yaml.safe_load(f))["costs"]
    cm, cm2 = CostModel.from_config(ccfg), CostModel.from_config(ccfg, multiplier=2.0 * float(
        ccfg.get("stress_multiplier", 1.0)))
    regimes = trend(ds)
    pairs = LL.build_pairs(ds)
    rows: list[dict[str, Any]] = []
    target: dict[str, Any] = {}
    for p in pairs:
        qv = ds.market(p.market).quote_volume[p.symbol]  # type: ignore[arg-type]
        sel, folds, per_lag = LL.walk_forward(p, cm, qv)
        if sel.empty:
            rows.append({"pair": p.pair_id, "hac_t": math.nan, "sharpe_daily": math.nan})
            continue
        d = delay_one_bar(sel, folds)
        st_ = strategy_stats(d["net_simple"], None, 200, 0)
        rows.append({"pair": p.pair_id, "hac_t": LL._hac_t(d["net"]), "sharpe_daily": st_["sharpe_daily"],
                     "net_total": float(d["net"].sum()), "net_total_zero_latency": float(sel["net"].sum())})
        if p.pair_id == LEADLAG_TRIAL["pair"]:
            sel2, folds2, _ = LL.walk_forward(p, cm2, qv)
            target = {"pair": p, "sel": d, "folds": folds, "per_lag": per_lag,
                      "sel2": delay_one_bar(sel2, folds2), "qv": qv, "raw_sel": sel}
    df = pd.DataFrame(rows)
    df["p"] = [2 * (1 - _norm_cdf(abs(t))) if math.isfinite(t) else math.nan for t in df["hac_t"]]
    rej, q, hp = bh_table(list(df["p"]))
    df["q_bh"], df["bh_reject"], df["p_holm"] = q, rej, hp

    sel, sel2, per_lag, folds = target["sel"], target["sel2"], target["per_lag"], target["folds"]
    leak_ok = leadlag_leakage_check(LL, target["pair"], cm, target["qv"], folds, target["raw_sel"])
    prior = reg.records()
    others = [float(s) for pr, s in zip(df["pair"], df["sharpe_daily"], strict=True)
              if pr != LEADLAG_TRIAL["pair"] and math.isfinite(s)]
    prior_sh = [float(v) for r in prior if isinstance(v := (r.get("results") or {}).get("sharpe_daily"),
                                                       int | float) and math.isfinite(float(v))]
    n_trials = len(prior) + len(df)
    stats = strategy_stats(sel["net_simple"], prior_sh + others, 500, 0, n_trials=n_trials)
    bh = 24 * 365
    series = {"selected": sel["net"]}
    nbr = []
    for L, g in per_lag.groupby("lag_h"):
        gd = delay_one_bar(g.drop(columns="lag_h"), folds)["net"]
        series[f"lag{L}"] = gd
        nbr.append(float(gd.mean() / gd.std() * math.sqrt(bh)) if gd.std() > 0 else math.nan)
    daily = pd.DataFrame({k: v.resample("1D").sum() for k, v in series.items()}).dropna()
    S = min(16, (len(daily) // 10) // 2 * 2)
    pbo, degenerate, n_distinct = math.nan, True, 0
    try:
        rp = pbo_cscv(daily, S=S, min_distinct=MIN_DISTINCT_VARIANTS)
        pbo, degenerate, n_distinct = float(rp["pbo"]), bool(rp["degenerate"]), int(rp["n_distinct"])
    except ValueError:
        pass
    reg_sh = {str(k): float(v.mean() / v.std() * math.sqrt(bh)) if v.std() > 0 else math.nan
              for k, v in sel["net"].groupby(regimes.reindex(sel.index))}
    sd = sel["net"].std()
    sd2 = sel2["net"].std()
    row = df.loc[df["pair"] == LEADLAG_TRIAL["pair"]].iloc[0]
    # benchmark: buy-and-hold of the follower over the same OOS bars (log -> simple)
    from engine.research.multiple_testing import alpha_vs_benchmark

    bench = np.expm1(target["pair"].y.reindex(sel.index).fillna(0.0))
    alpha = alpha_vs_benchmark(sel["net_simple"], bench)
    results = {
        "oos_sharpe": float(sel["net"].mean() / sd * math.sqrt(bh)) if sd > 0 else math.nan,
        "cost_stress_sharpe": float(sel2["net"].mean() / sd2 * math.sqrt(bh)) if sd2 > 0 else math.nan,
        "sharpe_daily": stats.get("sharpe_daily"), "dsr": stats.get("dsr"),
        "n_trials_dsr": stats.get("n_trials"),
        "hac_t": stats.get("hac_t"), "hac_p": stats.get("hac_p"),
        "hac_p_hourly_pair": float(row["p"]), "q_bh_pairs": float(row["q_bh"]),
        "p_holm_pairs": float(row["p_holm"]), "bh_reject_pairs": bool(row["bh_reject"]),
        "pbo": pbo, "pbo_degenerate": degenerate, "n_distinct_variants": n_distinct,
        "n_trades": int((sel["pos"].diff().abs().fillna(0) > 0).sum()),
        "oos_days": (sel.index.max() - sel.index.min()).total_seconds() / 86400.0,
        "total_net_return": float(np.expm1(sel["net"].sum())),
        "zero_latency_net_total": float(target["raw_sel"]["net"].sum()),
        "perturbation_frac_positive": float(np.mean([s > 0 for s in nbr])) if nbr else math.nan,
        "regime_sharpes": reg_sh, "leakage_pass": bool(leak_ok), "causality_pass": bool(leak_ok),
        "n_pairs_tested": int(len(df)), "execution_delay_bars": 1,
        "benchmark_sharpe": alpha["benchmark_sharpe"], "excess_sharpe_vs_benchmark": alpha["excess_sharpe"],
        "alpha_ann": alpha["alpha_ann"], "beta_vs_benchmark": alpha["beta"], "alpha_t": alpha["alpha_t"],
        "alpha_p": alpha["alpha_p"], "rules_version": 2, "batch": BATCH,
    }
    dec = decide(results)
    exp_id = reg.register(ExperimentRecord(
        hypothesis_id=LEADLAG_TRIAL["hypothesis"], family=LEADLAG_TRIAL["family"],
        model_version="leadlag_engine:BTC->ADA", params={"lags": list(LL.LAGS), "test_months": LL.TEST_MONTHS,
                                                         "selection": "train-window lag + OLS beta",
                                                         "execution_delay_bars": 1},
        seed=0, dataset_hash=dataset_hash(pd.DataFrame({"x": target["pair"].x, "y": target["pair"].y})),
        periods={"oos_start": sel.index.min().isoformat(), "oos_end": sel.index.max().isoformat(),
                 "folds": [{"test_start": str(r.test_start), "test_end": str(r.test_end),
                            "selected_lag": int(r.selected_lag)} for r in folds.itertuples()],
                 "h2_start": H2_START.isoformat()},
        cost_model={"source": "config/experiment.yaml", "impact": "sqrt law at $10k (leadlag engine)",
                    "stress": "CostModel multiplier x2 (also raises the trade threshold)"},
        results=results, stats={k: v for k, v in stats.items()}, decision=dec.decision,
        rejection_reason=dec.rejection_reason, reasons=list(dec.reasons),
        notes=f"{BATCH}: lead-lag with one bar of execution delay; rules v2 sha={dec.rules_sha}; "
              "leakage = truncation re-run reproduces common folds"))
    df.to_csv(OUT / "leadlag_pairs_delayed.csv", index=False)
    log.append(f"{exp_id} H-0014/leadlag BTC->ADA (+1 bar delay): {dec.decision}")
    print(log[-1], flush=True)
    return {"hypothesis": "H-0014", "model_id": "leadlag_engine:BTC->ADA", "universe": "BTC->ADA",
            "exp_id": exp_id, "decision": dec.decision,
            "reason": dec.rejection_reason or "; ".join(dec.reasons),
            "regime_specific": dec.regime_specific, **results, "pairs_table": df}


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _fmt(x: Any, nd: int = 2) -> str:
    if isinstance(x, bool):
        return "yes" if x else "no"
    if isinstance(x, int | float):
        return "-" if not math.isfinite(float(x)) else f"{float(x):.{nd}f}"
    return "-" if x is None else str(x)


def total_trials(reg: ResearchRegistry, rows: list[dict[str, Any]]) -> dict[str, int]:
    """Disclosure: registry records (all batches, crashes) + parameter neighbours evaluated."""
    recs = reg.records()
    nbrs = sum(int(r.get("n_neighbors") or 0) for r in rows)
    pairs = sum(int(r.get("n_pairs_tested") or 0) for r in rows)
    b1 = sum(1 for r in recs if str(r.get("id", "")) <= "EXP-000012")
    return {"registry_records": len(recs), "batch_001_records": b1, "batch_002_records": len(rows),
            "batch_002_neighbours": nbrs, "batch_002_leadlag_pairs": pairs,
            "total": len(recs) + nbrs + pairs}


def write_results(rows: list[dict[str, Any]], ll: dict[str, Any], plan: dict[str, Any], log: list[str],
                  runtime_s: float, reg: ResearchRegistry | None = None,
                  path: Path = OUT / "results.md") -> Path:
    allrows = [*rows, ll]
    rej, q, hp = bh_table([r.get("hac_p", math.nan) for r in allrows])
    for r, a, b, c in zip(allrows, rej, q, hp, strict=True):
        r["bh_reject"], r["q_bh"], r["p_holm"] = a, b, c
    counts = pd.Series([r["decision"] for r in allrows]).value_counts()
    tt = total_trials(reg or ResearchRegistry(), allrows)
    L = [f"# Research {BATCH} — results", "",
         f"Plan: `{PLAN_PATH.as_posix()}` (created {plan['created_at']}, spec_sha {plan['spec_sha']}). "
         f"Data {DATA_START} .. < H2_START {H2_START.date()} (H2 sealed, not opened). "
         "Rules: config/promotion_rules_v2.yaml (pre-registered 2026-10-10 after batch_001 invalidation). "
         f"Runtime {runtime_s / 60:.1f} min.",
         "", "No parameter was changed after results were seen; no reruns. batch_001 is invalidated "
         "(reports/research/batch_001/INVALIDATED.md) but its trials still count.", "",
         "## Experiments", "",
         "| EXP | hypothesis | model | universe | OOS net Sharpe | buy&hold Sharpe | alpha ann | alpha p | "
         "2x-cost Sharpe | DSR | PBO | distinct variants | stability | HAC p | BH q | Holm p | decision | "
         "reason | runtime s |",
         "|" + "---|" * 19]
    for r in allrows:
        L.append("| " + " | ".join([
            _fmt(r.get("exp_id")), r["hypothesis"], r["model_id"], r["universe"],
            _fmt(r.get("oos_sharpe")), _fmt(r.get("benchmark_sharpe")), _fmt(r.get("alpha_ann"), 3),
            _fmt(r.get("alpha_p"), 4), _fmt(r.get("cost_stress_sharpe")), _fmt(r.get("dsr"), 3),
            _fmt(r.get("pbo")) + (" (degenerate)" if r.get("pbo_degenerate") else ""),
            _fmt(r.get("n_distinct_variants")), _fmt(r.get("perturbation_frac_positive")),
            _fmt(r.get("hac_p"), 4), _fmt(r.get("q_bh"), 4), _fmt(r.get("p_holm"), 4), r["decision"],
            str(r.get("reason", "")).replace("|", "/"), _fmt(r.get("runtime_s"), 0)]) + " |")
    L += ["", "## Decision counts", ""] + [f"- {k}: {v}" for k, v in counts.items()]
    L += ["", f"## Multiple testing across the batch ({len(allrows)} trials)", "",
          f"Benjamini-Hochberg at q <= {ALPHA} over each trial's daily HAC p-value (NaN -> 1): "
          f"{sum(rej)} rejection(s). Holm (FWER) rejections: {sum(x <= ALPHA for x in hp)}.", "",
          "### Total trial count (disclosure)", "",
          f"- Registry records after this batch (all batches, crashes included): {tt['registry_records']} "
          f"(batch_001: {tt['batch_001_records']}, batch_002: {tt['batch_002_records']})",
          f"- Parameter neighbours evaluated in batch_002: {tt['batch_002_neighbours']}",
          f"- Lead-lag pairs re-tested in batch_002: {tt['batch_002_leadlag_pairs']}",
          f"- Total trials tried: **{tt['total']}** (this N, not the batch size, deflates DSR)", ""]
    ll_df: pd.DataFrame = ll["pairs_table"]
    L += ["## Lead-lag BTC->ADA with one bar of execution delay", "",
          f"- Pairs re-run with unchanged engine code, re-priced with +1 bar latency: {len(ll_df)}",
          f"- BTC->ADA hourly net HAC p = {_fmt(ll.get('hac_p_hourly_pair'), 4)}, BH q (pairs) = "
          f"{_fmt(ll.get('q_bh_pairs'), 4)}, Holm p = {_fmt(ll.get('p_holm_pairs'), 4)}",
          f"- Pairs BH-significant (q <= {ALPHA}): {int(ll_df['bh_reject'].sum())} "
          f"({', '.join(ll_df.loc[ll_df['bh_reject'], 'pair']) or 'none'})",
          f"- Net total: zero-latency {_fmt(ll.get('zero_latency_net_total'), 4)} vs delayed "
          f"{_fmt(ll.get('total_net_return'), 4)}; leakage (truncation re-run) "
          f"{'pass' if ll.get('leakage_pass') else 'FAIL'}",
          f"- Pre-registered decision: **{ll['decision']}** — {ll.get('reason', '')}",
          f"- Full table: `{(OUT / 'leadlag_pairs_delayed.csv').as_posix()}`", ""]
    L += ["## Unmapped testable hypotheses (not run, not registered)", ""]
    L += [f"- {k}: {v}" for k, v in UNMAPPED.items()]
    L += ["", "## Verdicts", ""]
    for r in allrows:
        L.append(f"- {r['hypothesis']} / {r['model_id']} ({r.get('exp_id')}): **{r['decision']}**")
    promo = [r for r in allrows if r["decision"] in ("PROMOTE", "WATCH")]
    L += ["", ("No experiment reached PROMOTE or WATCH: no edge over buy-and-hold established in this batch."
               if not promo else "PROMOTE/WATCH (stats vs buy-and-hold): " + "; ".join(
                   f"{r['exp_id']} {r['model_id']} {r['decision']} Sharpe {_fmt(r.get('oos_sharpe'))} vs B&H "
                   f"{_fmt(r.get('benchmark_sharpe'))}, alpha {_fmt(r.get('alpha_ann'), 3)}/yr "
                   f"p={_fmt(r.get('alpha_p'), 4)}, BH q={_fmt(r.get('q_bh'), 4)}" for r in promo)), ""]
    L += ["## Caveats (declared in plan)", ""] + [f"- {c}" for c in plan["caveats"]]
    L += ["", "## Run log", "", "```", *log, "```", ""]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(L), encoding="utf-8")
    return path


def write_leaderboard(reg: ResearchRegistry, since: str | None = None) -> Path:
    """Leaderboard from registry records decided under rules v2 (batch_001 is invalidated)."""
    from engine.monitor import leaderboard as lb

    rows: dict[str, dict[str, Any]] = {}
    for r in reg.records():
        res = dict(r.get("results") or {})
        if since is not None and str(r.get("registered_at", "")) < since:
            continue
        regs = [v for v in (res.get("regime_sharpes") or {}).values() if isinstance(v, int | float)]
        res["cost_robustness"] = res.get("cost_stress_sharpe")
        res["param_stability"] = res.get("perturbation_frac_positive")
        res["regime_robustness"] = (sum(v > 0 for v in regs) / len(regs)) if regs else None
        key = f"{r.get('model_version')}|{r.get('hypothesis_id')}"
        rows[key] = {**r, "results": res, "exp_id": r.get("id"), "model_id": key}
    ledger = pd.DataFrame(columns=["model_id"])
    md, _ = lb.write(lb.build(rows, ledger, {}), Path("reports"))
    return md


def rows_from_registry(reg: ResearchRegistry, since: str, note: str) -> list[dict[str, Any]]:
    """Rebuild result rows for the planned experiments from registry records registered after the plan.
    Planned experiments with no record are registered now as crashes (reason = note)."""
    hyps = _hyps()
    recs = [r for r in reg.records() if str(r.get("registered_at", "")) >= since]
    out = []
    for e in plan_spec()["experiments"]:
        r = next((x for x in recs if x.get("hypothesis_id") == e["hypothesis"]
                  and x.get("model_version") == e["model_id"]), None)
        if r is None:
            h = hyps[e["hypothesis"]]
            exp_id = reg.register(_crash_record(h, e["model_id"], dict(e["params"]), note))
            r = {"id": exp_id, "decision": "INCONCLUSIVE", "rejection_reason": f"crash: {note}",
                 "results": {}}
        out.append({"hypothesis": e["hypothesis"], "model_id": e["model_id"], "universe": e["universe"],
                    "exp_id": r["id"], "decision": r["decision"],
                    "reason": r.get("rejection_reason") or "; ".join(r.get("reasons") or []),
                    "regime_specific": "regime-specific" in str(r.get("rejection_reason", "")),
                    **(r.get("results") or {})})
    return out


def finish(reg: ResearchRegistry, plan: dict[str, Any], note: str) -> int:
    t0 = time.time()
    log = [f"finish phase {datetime.now(UTC).isoformat()}: {note}"]
    rows = rows_from_registry(reg, str(plan["created_at"]), note)
    log += [f"{r['exp_id']} {r['hypothesis']}/{r['model_id']}: {r['decision']}" for r in rows]
    ll = run_leadlag_trial(reg, log)
    reg.verify()
    out = write_results(rows, ll, plan, log, time.time() - t0, reg)
    print(out, write_leaderboard(reg, str(plan["created_at"])))
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="engine.research.batch")
    ap.add_argument("phase", choices=["plan", "run", "finish"])
    ap.add_argument("--note", default="", help="finish: why the run was finalized from the registry")
    a = ap.parse_args(argv)
    if a.phase == "plan":
        print(write_plan())
        return 0
    plan = check_plan()
    t0 = time.time()
    reg = ResearchRegistry()
    if a.phase == "finish":
        return finish(reg, plan, a.note)
    log: list[str] = [f"run started {datetime.now(UTC).isoformat()}"]
    rows = run_models(reg, log)
    ll = run_leadlag_trial(reg, log)
    reg.verify()
    out = write_results(rows, ll, plan, log, time.time() - t0, reg)
    print(out, write_leaderboard(reg, str(plan["created_at"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
