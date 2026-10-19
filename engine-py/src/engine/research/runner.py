"""Experiment runner: walk-forward OOS predictions -> positions -> net PnL -> stats -> decision.

Only data strictly before H2_START is accepted (H2Violation otherwise). The model only ever sees
data truncated at `end` (fit) or `t` (predict) when the data object is pandas / a dict of pandas /
has a `.truncate(t)` method, so it cannot peek forward. Models exposing `predict_many(data, times)`
are evaluated once per fold on data truncated at the fold's last decision (review 01 #6).

Leakage checks that CAN fail (review 01 #10, 2026-10-10):
  * pointwise: the OOS predictions used for PnL must equal predict(truncate(data, t), t);
  * full-data: predict(full research data, t) must equal predict(truncate(data, t), t);
  * perturbation: predict(data with every value after t scrambled, t) must equal the truncated one;
  * fit causality: a model fitted on data whose values after `end` are scrambled (passed in full, with
    `end`) must predict exactly like a model fitted on truncate(data, end). A model that refuses data
    past `end` (raises AssertionError/ValueError) passes that check.
Any mismatch => leakage_pass False => REJECT.

Execution model (README rule 4): decision at bar close t, FILLED AT THE OPEN of bar t+1. During bar
t+1 the previous position earns the close(t)->open(t+1) gap and the new position earns open->close
(when `open_returns` is given; otherwise close-to-close, the 24/7 approximation). Held until the next
decision (every horizon_hours). Perp funding is charged: a position w held over bar t pays
w * funding_rate for every funding event binned to bar t (longs pay positive funding, review 01 #7).
Costs per unit of turnover (fraction of equity) = (taker fee + half-spread) bps from
engine.costs.CostModel x multiplier. Square-root impact needs order notional vs ADV and is NOT applied
here (research is notional-free); the 2x cost-stress gate covers it conservatively for liquid assets.
Positions are equal-weighted across the assets predicted at t (not across every dataset column).

Benchmark (review 01 #1/#8): equal-weight buy-and-hold of the assets with a valid return (or the
supplied `benchmark_weights`, e.g. the PIT universe), funding included, no turnover cost. Results carry
the strategy's daily alpha vs that benchmark with a Newey-West t and one-sided p.

DSR deflation (review 01 #4): N = every trial in the registry (all families and batches, crashes
included) + every parameter neighbour evaluated here (crashed neighbours included) + this run.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
import pandas as pd

from engine.costs import CostModel
from engine.research.contract import H2_START, Prediction, SignalModel
from engine.research.holdout_guard import H2Violation, assert_research_window
from engine.research.hypothesis import Hypothesis
from engine.research.multiple_testing import alpha_vs_benchmark, pbo_cscv, strategy_stats
from engine.research.perturbation import evaluate_neighborhood
from engine.research.promotion import PromotionDecision, decide
from engine.research.registry import ExperimentRecord, ResearchRegistry, dataset_hash
from engine.research.splits import walk_forward

PositionMode = Literal["sign", "vol_target", "edge"]


@dataclass
class ResearchDataset:
    data: Any                       # passed (truncated) to model.fit / model.predict
    returns: pd.DataFrame           # bar returns r[t] = close[t]/close[t-1]-1, cols = assets
    name: str = ""
    market: str = "perp"
    feature_versions: dict[str, str] = field(default_factory=dict)
    funding: pd.DataFrame | None = None           # funding rate charged in bar t (events binned)
    open_returns: pd.DataFrame | None = None      # open[t] -> close[t] return, for fills at open t+1
    benchmark_weights: pd.DataFrame | None = None  # buy-and-hold weights at t (default: equal, valid assets)


@dataclass
class RunConfig:
    n_splits: int = 5
    embargo: pd.Timedelta = pd.Timedelta(hours=168)
    position_mode: PositionMode = "sign"
    vol_target_annual: float = 0.20
    max_leverage: float = 2.0
    edge_threshold: float = 0.0
    seed: int = 0
    param_grid: dict[str, list[Any]] = field(default_factory=dict)
    causality_checks: int = 3
    bootstrap_n: int = 500
    pbo_min_distinct: int = 5        # promotion_rules_v2: fewer distinct variants -> PBO degenerate


@dataclass
class ExperimentResult:
    exp_id: str | None
    decision: PromotionDecision
    results: dict[str, Any]
    net_returns: pd.Series
    predictions: list[Prediction]


ModelFactory = Callable[[dict[str, Any]], SignalModel]
RegimeLabeler = Callable[[pd.DatetimeIndex], pd.Series]


def truncate(data: Any, t: pd.Timestamp) -> Any:
    """Data visible at time t (inclusive)."""
    if isinstance(data, pd.Series | pd.DataFrame):
        return data.loc[data.index <= t]
    if isinstance(data, dict):
        return {k: truncate(v, t) for k, v in data.items()}
    if hasattr(data, "truncate") and callable(data.truncate):
        return data.truncate(t)
    return data


def _check_data_window(data: Any) -> None:
    if isinstance(data, pd.Series | pd.DataFrame):
        assert_research_window(data.index)
    elif isinstance(data, dict):
        for v in data.values():
            _check_data_window(v)


def _bar_hours(idx: pd.DatetimeIndex) -> float:
    return float(pd.Series(idx).diff().median() / pd.Timedelta(hours=1)) if len(idx) > 1 else 1.0


def _cost_per_turnover(cost_model: CostModel, assets: list[str], market: str, mult: float) -> pd.Series:
    fee = float(cost_model.fee_bps.get(market, max(cost_model.fee_bps.values())))
    return pd.Series({a: (fee + cost_model.half_spread(a, market)) * 1e-4 * mult for a in assets})


def _weight(p: Prediction, cfg: RunConfig) -> float:
    if p.direction == 0:
        return 0.0
    if cfg.position_mode == "sign":
        return float(p.direction)
    if cfg.position_mode == "edge":
        edge = abs(p.expected_return) - p.expected_cost
        return float(p.direction) if edge > cfg.edge_threshold else 0.0
    target = cfg.vol_target_annual * math.sqrt(p.horizon_hours / 8760.0)
    if not math.isfinite(p.risk) or p.risk <= 0:
        return 0.0
    return float(p.direction) * min(target / p.risk, cfg.max_leverage)


@dataclass
class _Oos:
    weights: pd.DataFrame
    predictions: list[Prediction]
    span: tuple[pd.Timestamp, pd.Timestamp]
    folds: list[dict[str, str]]
    boundary_ok: bool


def _predict_block(model: SignalModel, data: Any, times: list[pd.Timestamp]) -> list[Prediction]:
    """Predictions for one fold. Fast path: one panel computation on data <= max(times)."""
    if not times:
        return []
    many = getattr(model, "predict_many", None)
    if callable(many):
        out: list[Prediction] = list(many(truncate(data, max(times)), times))
        return out
    res: list[Prediction] = []
    for t in times:
        res.extend(model.predict(truncate(data, t), t))
    return res


def _oos_weights(model_factory: ModelFactory, params: dict[str, Any], ds: ResearchDataset,
                 cfg: RunConfig) -> _Oos:
    rets = ds.returns
    ridx = pd.DatetimeIndex(rets.index)
    probe = model_factory(params)
    h = int(probe.horizon_hours)
    step = max(1, int(round(h / _bar_hours(ridx))))
    decision_idx = ridx[::step]
    splits = walk_forward(decision_idx, cfg.n_splits, pd.Timedelta(hours=h), cfg.embargo)
    preds: list[Prediction] = []
    folds = []
    boundary_ok = True
    for sp in splits:
        model = model_factory(params)
        model.fit(truncate(ds.data, sp.train_end), end=sp.train_end)
        # sanity only (holds by construction of walk_forward): last label ends before the test block
        boundary_ok &= bool(sp.train_end + pd.Timedelta(hours=h) < sp.test_start)
        folds.append({"train_end": sp.train_end.isoformat(), "test_start": sp.test_start.isoformat(),
                      "test_end": sp.test_end.isoformat()})
        times = list(decision_idx[sp.test])
        tset = set(times)
        for p in _predict_block(model, ds.data, times):
            if p.timestamp not in tset or p.timestamp >= H2_START:
                raise H2Violation(f"prediction timestamp {p.timestamp} invalid for fold {sp.test_start}")
            preds.append(p)
    all_dec = [t for sp in splits for t in decision_idx[sp.test]]
    w = pd.DataFrame(np.nan, index=rets.index, columns=rets.columns)
    if all_dec:
        w.loc[pd.DatetimeIndex(all_dec)] = 0.0
    rows = [(p.timestamp, p.asset, _weight(p, cfg)) for p in preds if p.asset in w.columns]
    if rows:
        df = pd.DataFrame(rows, columns=["t", "asset", "w"])
        n_at_t = df.groupby("t")["asset"].transform("count")
        df["w"] = df["w"] / n_at_t                     # equal weight across assets predicted at t
        piv = df.pivot_table(index="t", columns="asset", values="w", aggfunc="sum")
        piv = piv.reindex(columns=w.columns)
        sub = w.loc[piv.index]
        w.loc[piv.index] = piv.where(piv.notna(), sub).fillna(0.0)
    start = splits[0].test_start if splits else ridx[0]
    end = splits[-1].test_end if splits else ridx[-1]
    w = w.ffill(limit=step - 1).fillna(0.0) if step > 1 else w.fillna(0.0)
    w.loc[w.index > end + pd.Timedelta(hours=h)] = 0.0
    return _Oos(w, preds, (start, end), folds, boundary_ok)


def net_returns(weights: pd.DataFrame, returns: pd.DataFrame, cost_per_turnover: pd.Series,
                funding: pd.DataFrame | None = None, open_returns: pd.DataFrame | None = None) -> pd.Series:
    """Position decided at close t, filled at open t+1; cost charged on turnover at t.

    Without `open_returns`: w[t] earns r[t+1] (close-to-close). With it: during bar t+1 the old
    position w[t-1] earns the gap close(t)->open(t+1) and w[t] earns open(t+1)->close(t+1).
    Funding: the position held over bar t (w[t-1]) pays w[t-1] * funding[t]."""
    r = returns.fillna(0.0)
    w1 = weights.shift(1).fillna(0.0)
    if open_returns is None:
        gross = (w1 * r).sum(axis=1)
    else:
        oc = open_returns.reindex_like(returns)
        oc = oc.where(oc.notna() & returns.notna(), returns).fillna(0.0)
        gap = (1.0 + r) / (1.0 + oc) - 1.0
        w2 = weights.shift(2).fillna(0.0)
        gross = (w2 * gap).sum(axis=1) + (w1 * oc).sum(axis=1)
    if funding is not None:
        f = funding.reindex(index=weights.index, columns=weights.columns).fillna(0.0)
        gross = gross - (w1 * f).sum(axis=1)
    turnover = weights.diff().abs()
    turnover.iloc[0] = weights.iloc[0].abs()
    cost = (turnover * cost_per_turnover.reindex(weights.columns).fillna(0.0)).sum(axis=1)
    return gross - cost


def benchmark_returns(ds: ResearchDataset) -> pd.Series:
    """Buy-and-hold benchmark: equal weight over assets with a valid return at t (or the supplied
    benchmark_weights), funding paid by the long, no turnover cost (review 01 #1)."""
    rets = ds.returns
    if ds.benchmark_weights is not None:
        bw = ds.benchmark_weights.reindex(index=rets.index, columns=rets.columns).fillna(0.0).astype(float)
    else:
        valid = rets.notna().astype(float)
        bw = valid.div(valid.sum(axis=1).replace(0.0, np.nan), axis=0).fillna(0.0)
    held = bw.shift(1).fillna(0.0)
    out = (held * rets.fillna(0.0)).sum(axis=1)
    if ds.funding is not None:
        out = out - (held * ds.funding.reindex_like(rets).fillna(0.0)).sum(axis=1)
    return out


def _ann_sharpe(r: pd.Series, bar_hours: float) -> float:
    r = r.dropna()
    if len(r) < 2 or r.std(ddof=1) == 0:
        return float("nan")
    return float(r.mean() / r.std(ddof=1) * math.sqrt(8760.0 / bar_hours))


def _daily_sharpe(r: pd.Series) -> float:
    d = (1.0 + r.dropna()).resample("1D").prod() - 1.0 if isinstance(r.index, pd.DatetimeIndex) else r
    sd = float(d.std(ddof=1)) if len(d) > 1 else 0.0
    return float(d.mean() / sd) if sd > 0 else float("nan")


def perturb_after(data: Any, t: pd.Timestamp, seed: int = 12345) -> Any:
    """Copy of `data` where every numeric value strictly after t is scrambled (x * U[0.5, 1.5], funding
    sign-flipped). A causal model's output at t (and its fit with end=t) must not change."""
    rng = np.random.default_rng(seed)

    def frame(x: Any, flip: bool = False) -> Any:
        if not isinstance(x, pd.Series | pd.DataFrame) or not len(x):
            return x
        after = x.index > t
        if not after.any():
            return x
        y = x.copy()
        num = y.select_dtypes("number") if isinstance(y, pd.DataFrame) else y
        if isinstance(y, pd.DataFrame):
            cols = [c for c in num.columns if y[c].dtype != bool]
            k = rng.uniform(0.5, 1.5, (int(after.sum()), len(cols)))
            y.loc[after, cols] = y.loc[after, cols].to_numpy(dtype=float) * (-3.0 if flip else k)
        elif y.dtype != bool and pd.api.types.is_numeric_dtype(y):
            y.loc[after] = y.loc[after].to_numpy(dtype=float) * rng.uniform(0.5, 1.5, int(after.sum()))
        return y

    if isinstance(data, pd.Series | pd.DataFrame):
        return frame(data)
    if isinstance(data, dict):
        return {k: perturb_after(v, t, seed + i) for i, (k, v) in enumerate(data.items())}
    from engine.contracts import Dataset, MarketData

    if isinstance(data, Dataset):
        def md(m: MarketData) -> MarketData:
            return MarketData(**{k: frame(getattr(m, k)) for k in m.__dataclass_fields__})

        return Dataset(md(data.spot), md(data.perp), frame(data.funding, flip=True))
    return data


def _key(ps: list[Prediction]) -> list[tuple[str, int, float]]:
    return sorted((p.asset, int(p.direction), float(p.expected_return)) for p in ps)


def _same(a: list[Prediction], b: list[Prediction], rtol: float = 1e-6, atol: float = 1e-10) -> bool:
    ka, kb = _key(a), _key(b)
    if len(ka) != len(kb):
        return False
    for (aa, da, ea), (ab, db, eb) in zip(ka, kb, strict=True):
        if aa != ab or da != db or not math.isclose(ea, eb, rel_tol=rtol, abs_tol=atol):
            return False
    return True


def causality_check(model_factory: ModelFactory, params: dict[str, Any], ds: ResearchDataset,
                    times: list[pd.Timestamp], fit_end: pd.Timestamp,
                    oos_predictions: list[Prediction] | None = None,
                    cfg: RunConfig | None = None) -> dict[str, bool]:
    """Leakage checks that can fail (see module docstring). Returns per-check booleans."""
    model = model_factory(params)
    model.fit(truncate(ds.data, fit_end), end=fit_end)
    full_ok = pert_ok = point_ok = fit_ok = True
    by_t: dict[pd.Timestamp, list[Prediction]] = {}
    for p in oos_predictions or []:
        by_t.setdefault(p.timestamp, []).append(p)
    for t in times:
        ref = model.predict(truncate(ds.data, t), t)
        full_ok &= _same(model.predict(ds.data, t), ref)
        pert_ok &= _same(model.predict(perturb_after(ds.data, t), t), ref)
    # fit causality: fit on full-length data scrambled after fit_end
    leaky: SignalModel | None = model_factory(params)
    try:
        assert leaky is not None
        leaky.fit(perturb_after(ds.data, fit_end), end=fit_end)
    except (AssertionError, ValueError):
        leaky = None  # the model refuses data past `end`: cannot leak through fit
    if leaky is not None:
        for t in times:
            d = truncate(ds.data, t)
            fit_ok &= _same(leaky.predict(d, t), model.predict(d, t))
    # pointwise: the OOS (batch) predictions must equal a fresh pointwise prediction by the fold model
    if oos_predictions is not None:
        for t in times:
            if t in by_t:
                point_ok &= _same(by_t[t], _fold_pointwise(model_factory, params, ds, t, cfg or RunConfig()))
    return {"full_data": bool(full_ok), "perturbation": bool(pert_ok), "fit": bool(fit_ok),
            "pointwise": bool(point_ok)}


def _fold_pointwise(model_factory: ModelFactory, params: dict[str, Any], ds: ResearchDataset,
                    t: pd.Timestamp, cfg: RunConfig) -> list[Prediction]:
    """Re-create the fold model that produced the OOS prediction at t and predict pointwise."""
    rets = ds.returns
    ridx = pd.DatetimeIndex(rets.index)
    probe = model_factory(params)
    h = int(probe.horizon_hours)
    step = max(1, int(round(h / _bar_hours(ridx))))
    decision_idx = ridx[::step]
    for sp in walk_forward(decision_idx, cfg.n_splits, pd.Timedelta(hours=h), cfg.embargo):
        if t in set(decision_idx[sp.test]):
            m = model_factory(params)
            m.fit(truncate(ds.data, sp.train_end), end=sp.train_end)
            return list(m.predict(truncate(ds.data, t), t))
    return []


def run_experiment(hypothesis: Hypothesis, model_factory: ModelFactory, dataset: ResearchDataset,
                   cost_model: CostModel, params: dict[str, Any] | None = None,
                   config: RunConfig | None = None, regime_labeler: RegimeLabeler | None = None,
                   registry: ResearchRegistry | None = None, register: bool = True) -> ExperimentResult:
    cfg = config or RunConfig()
    params = dict(hypothesis.params if params is None else params)
    assert_research_window(dataset.returns.index)
    _check_data_window(dataset.data)
    reg = registry or ResearchRegistry()
    np.random.seed(cfg.seed)
    rets = dataset.returns
    ridx = pd.DatetimeIndex(rets.index)
    bh = _bar_hours(ridx)
    assets = list(rets.columns)
    c1 = _cost_per_turnover(cost_model, assets, dataset.market, cost_model.multiplier)
    c2 = _cost_per_turnover(cost_model, assets, dataset.market, cost_model.multiplier * 2.0)

    fund, oc = dataset.funding, dataset.open_returns
    oos = _oos_weights(model_factory, params, dataset, cfg)
    lo, hi = oos.span
    in_oos = (rets.index >= lo) & (rets.index <= hi)
    net = net_returns(oos.weights, rets, c1, fund, oc)[in_oos]
    net2 = net_returns(oos.weights, rets, c2, fund, oc)[in_oos]
    bench = benchmark_returns(dataset)[in_oos]
    turnover = oos.weights.diff().abs().sum(axis=1)[in_oos]
    n_trades = int((oos.weights.diff().abs()[in_oos] > 1e-12).to_numpy().sum())
    sharpe = _ann_sharpe(net, bh)

    # leakage checks that can fail, on a few OOS decision times
    test_times = list(pd.DatetimeIndex([p.timestamp for p in oos.predictions]).unique())
    picks = [test_times[int(i)] for i in np.linspace(0, len(test_times) - 1,
                                                       min(cfg.causality_checks, len(test_times)))]
    checks = causality_check(model_factory, params, dataset, picks, lo - pd.Timedelta(hours=1),
                             oos.predictions, cfg) if picks else {}
    causal = all(checks.values()) if checks else True
    leakage_pass = bool(oos.boundary_ok and causal)

    # perturbation + PBO over the neighbourhood (crashed neighbours count as trials, Sharpe NaN)
    pert: dict[str, Any] = {}
    pbo = float("nan")
    pbo_info: dict[str, Any] = {"degenerate": None, "n_distinct": None}
    nbr_daily: list[float] = []
    n_nbr = 0
    if cfg.param_grid:
        series: dict[str, pd.Series] = {"base": net}

        def nbr_sharpe(p: dict[str, Any]) -> float:
            try:
                o = _oos_weights(model_factory, p, dataset, cfg)
            except Exception:  # noqa: BLE001 - a crashed neighbour is a NaN trial, still counted
                nbr_daily.append(float("nan"))
                return float("nan")
            r = net_returns(o.weights, rets, c1, fund, oc)[in_oos]
            series[f"n{len(series)}"] = r
            nbr_daily.append(_daily_sharpe(r))
            return _ann_sharpe(r, bh)

        pert = evaluate_neighborhood(params, cfg.param_grid, nbr_sharpe, sharpe)
        n_nbr = int(pert.get("n_neighbors", 0))
        daily = pd.DataFrame({k: (1 + v).resample("1D").prod() - 1 for k, v in series.items()})
        S = min(16, (len(daily) // 10) // 2 * 2)
        if daily.shape[1] >= 2 and S >= 2:
            try:
                res_pbo = pbo_cscv(daily, S=S, min_distinct=cfg.pbo_min_distinct)
                pbo = float(res_pbo["pbo"])
                pbo_info = {"degenerate": bool(res_pbo["degenerate"]),
                            "n_distinct": int(res_pbo["n_distinct"])}
            except ValueError:
                pbo = float("nan")
        else:
            pbo_info = {"degenerate": True, "n_distinct": int(daily.shape[1])}
    else:
        pbo_info = {"degenerate": True, "n_distinct": 1}

    # DSR: all registered trials (every family / batch, crashes included) + neighbours + this run
    prior = reg.records()
    prior_sh = [float(v) for r in prior
                if isinstance(v := (r.get("results") or {}).get("sharpe_daily"), int | float)
                and math.isfinite(float(v))]
    trial_sh = prior_sh + [x for x in nbr_daily if math.isfinite(x)]
    n_trials = len(prior) + n_nbr + 1
    stats = strategy_stats(net, trial_sh, cfg.bootstrap_n, cfg.seed, n_trials=n_trials)
    alpha = alpha_vs_benchmark(net, bench)

    regime_sharpes: dict[str, float] = {}
    if regime_labeler is not None:
        labels = regime_labeler(pd.DatetimeIndex(net.index)).reindex(net.index)
        for lab, grp in net.groupby(labels):
            regime_sharpes[str(lab)] = _ann_sharpe(grp, bh)

    results: dict[str, Any] = {
        "oos_sharpe": sharpe,
        "cost_stress_sharpe": _ann_sharpe(net2, bh),
        "sharpe_daily": stats.get("sharpe_daily"),
        "dsr": stats.get("dsr"),
        "hac_t": stats.get("hac_t"),
        "hac_p": stats.get("hac_p"),
        "pbo": pbo,
        "pbo_degenerate": pbo_info["degenerate"],
        "n_distinct_variants": pbo_info["n_distinct"],
        "n_neighbors": n_nbr,
        "n_trials_dsr": stats.get("n_trials"),
        "benchmark_sharpe": alpha["benchmark_sharpe"],
        "excess_sharpe_vs_benchmark": alpha["excess_sharpe"],
        "alpha_ann": alpha["alpha_ann"],
        "beta_vs_benchmark": alpha["beta"],
        "alpha_t": alpha["alpha_t"],
        "alpha_p": alpha["alpha_p"],
        "funding_included": fund is not None,
        "fill": "open t+1" if oc is not None else "close t (24/7 approx of open t+1)",
        "n_trades": n_trades,
        "oos_days": (pd.Timestamp(hi) - pd.Timestamp(lo)).total_seconds() / 86400.0,
        "total_net_return": float(np.prod(1.0 + net.to_numpy(dtype=float)) - 1.0),
        "mean_turnover": float(turnover.mean()) if len(turnover) else 0.0,
        "perturbation_frac_positive": pert.get("frac_positive", float("nan")),
        "perturbation_dispersion": pert.get("dispersion", float("nan")),
        "regime_sharpes": regime_sharpes,
        "leakage_pass": leakage_pass,
        "rules_version": 2,
        "causality_pass": causal,
        "leakage_checks": checks,
        "n_predictions": len(oos.predictions),
    }
    decision = decide(results)
    exp_id = None
    if register:
        exp_id = reg.register(ExperimentRecord(
            hypothesis_id=hypothesis.id,
            family=hypothesis.family,
            model_version=str(getattr(model_factory(params), "model_id", "unknown")),
            params=params,
            seed=cfg.seed,
            dataset_hash=dataset_hash(rets),
            periods={"data_start": ridx[0].isoformat(), "data_end": ridx[-1].isoformat(),
                     "oos_start": lo.isoformat(), "oos_end": hi.isoformat(), "folds": oos.folds,
                     "h2_start": H2_START.isoformat()},
            cost_model={"fee_bps": cost_model.fee_bps, "multiplier": cost_model.multiplier,
                        "half_spread_bps": {a: cost_model.half_spread(a, dataset.market) for a in assets},
                        "market": dataset.market, "impact": "not applied (notional-free research)"},
            results=results,
            stats={**stats, "perturbation": {k: v for k, v in pert.items() if k != "neighbors"}},
            decision=decision.decision,
            rejection_reason=decision.rejection_reason,
            reasons=list(decision.reasons),
            feature_versions=dataset.feature_versions,
            notes=f"position_mode={cfg.position_mode}; rules_sha={decision.rules_sha}",
        ))
    return ExperimentResult(exp_id, decision, results, net, oos.predictions)
