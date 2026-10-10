"""End-to-end research pipeline: load data -> run strategies -> validate -> report.

Integrity rules enforced here:
  * Locked runs (default) truncate the data at split.dev_end and only ever produce DEVELOPMENT-period
    results. The holdout is only evaluated with unlock_holdout=True, and every unlock is permanently logged
    (experiments/holdout_log.jsonl).
  * One backtest is run over all available data. Strategies are causal, so results are then sliced into
    labelled periods (DEVELOPMENT, HOLDOUT ONLY, FULL PERIOD). Every period's statistics are computed from
    the returns WITHIN that period only, with equity rebased to the initial capital at the period start.
  * Every run (including parameter variants) is appended to the experiment registry, so the deflated
    Sharpe uses the honest number of trials. PBO / DSR use the development-period trial grid as the
    selection-relevant figures; holdout values are reported separately.
  * Results are re-run at 1.0x / 1.5x / 2.0x costs. Allocation mixes are re-run at the exact sleeve capital.
  * H2 (>= engine.research.contract.H2_START) is sealed. Even with unlock_holdout the data stops before
    H2_START; open_h2=True (CLI --open-h2, needs a reason) is the only way past it and every such run is
    appended to experiments/holdout_log.jsonl with its params_hash (AUDIT_REPORT B7).
"""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import math
import shutil
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import partial
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

from engine.backtest.engine import run_backtest
from engine.backtest.portfolio import benchmark_buy_hold, combine
from engine.contracts import BacktestResult, Dataset, Strategy, TargetWeights
from engine.costs import CostModel
from engine.data.load import load_dataset
from engine.live.signals_live import resolve_allocation
from engine.reporting.csv_export import export_period_tables
from engine.reporting.html_report import build_report
from engine.signals.registry import build_strategies
from engine.validation import metrics, stats
from engine.validation.walkforward import ExperimentRegistry, HoldoutLock, walk_forward_splits

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
HOLDOUT_LOG = ROOT / "experiments" / "holdout_log.jsonl"

PRIMARY = "Combined"
BENCH = "BTC buy&hold"
CASH = "cash"

# (label, {sleeve: weight}); weights sum to 1; "cash" earns 0.
ALLOCATIONS: list[tuple[str, dict[str, float]]] = [
    ("Trend 100%", {"trend": 1.0}),
    ("Trend 75% / Carry 25%", {"trend": 0.75, "carry": 0.25}),
    ("Trend 50% / Carry 50%", {"trend": 0.5, "carry": 0.5}),
    ("Carry 100%", {"carry": 1.0}),
    ("Trend 50% / Cash 50%", {"trend": 0.5, CASH: 0.5}),
]

LEGACY_OUTPUTS = ("report_dev.html", "report_holdout.html", "stats_dev.json", "stats_holdout.json",
                  "tables_dev", "tables_holdout")


def load_config(name: str) -> dict[str, Any]:
    """Load config/<name> and validate it against engine.config_schema (unknown keys and
    out-of-range risk limits raise ConfigError)."""
    from engine.config_schema import validate

    with open(ROOT / "config" / name, encoding="utf-8") as f:
        cfg: dict[str, Any] = validate(name, yaml.safe_load(f))
    return cfg


def git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True,
                                       stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError) as e:
        log.warning("git_sha unavailable (%s): recording 'uncommitted'", e)
        return "uncommitted"


def data_hash(root: Path) -> str:
    audit = root / "audit.json"
    return hashlib.sha256(audit.read_bytes()).hexdigest()[:12] if audit.exists() else "unknown"


# --------------------------------------------------------------------------- periods
@dataclass(frozen=True)
class Period:
    key: str            # "dev" | "holdout" | "full"
    label: str          # e.g. "DEVELOPMENT"
    start: pd.Timestamp  # inclusive (bar open time, UTC)
    end: pd.Timestamp    # inclusive

    @property
    def range_text(self) -> str:
        return f"{self.start:%Y-%m-%d} → {self.end:%Y-%m-%d}"

    @property
    def title(self) -> str:
        return f"{self.label} ({self.range_text})"


def _utc(x: Any) -> pd.Timestamp:
    t = pd.Timestamp(x)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def make_periods(index: pd.DatetimeIndex, dev_end: Any, holdout_start: Any, unlocked: bool) -> list[Period]:
    """Labelled evaluation periods, clipped to the bars actually present in ``index``."""
    idx = pd.DatetimeIndex(index)
    d_end = _utc(dev_end) + pd.Timedelta(hours=23)
    h_start = _utc(holdout_start)
    dev_bars = idx[idx <= d_end]
    out: list[Period] = []
    if len(dev_bars):
        out.append(Period("dev", "DEVELOPMENT", dev_bars[0], dev_bars[-1]))
    if unlocked:
        ho = idx[idx >= h_start]
        if len(ho):
            out.append(Period("holdout", "HOLDOUT ONLY", ho[0], ho[-1]))
        if len(idx):
            out.append(Period("full", "FULL PERIOD (descriptive only)", idx[0], idx[-1]))
    return out


def slice_result(res: BacktestResult, start: Any, end: Any) -> BacktestResult:
    """Restrict a result to [start, end] using only in-period returns; equity rebased to the initial capital.

    Rebasing factor k = initial_capital / equity just before ``start``. Equity, positions, costs and trade
    notionals are all multiplied by k, so P&L and cost figures are expressed per initial capital invested at
    the period start (equivalent to cap * cumprod(1 + in-period returns)).
    """
    s, e = _utc(start), _utc(end)
    eq = res.equity.astype(float)
    cap = float(res.meta.get("initial_capital", eq.iloc[0] if len(eq) else 1.0))
    before = eq.loc[eq.index < s]
    base = float(before.iloc[-1]) if len(before) else cap
    k = cap / base if base > 0 else 0.0
    mask = (eq.index >= s) & (eq.index <= e)
    r = res.returns.reindex(eq.index).loc[mask].fillna(0.0).astype(float)
    if k == 0.0:
        r = r * 0.0
    equity = (cap * (1.0 + r).cumprod()).rename("equity")
    positions = {m: p.loc[(p.index >= s) & (p.index <= e)] * k for m, p in (res.positions or {}).items()}
    c = res.costs if res.costs is not None else pd.DataFrame()
    costs = c.loc[(c.index >= s) & (c.index <= e)] * k
    tr = res.trades if res.trades is not None else pd.DataFrame()
    if len(tr) and "ts" in tr.columns:
        ts = pd.to_datetime(tr["ts"], utc=True)
        tr = tr.loc[((ts >= s) & (ts <= e)).to_numpy()].copy()
        for col in ("qty_notional", "fee", "spread", "impact"):
            if col in tr.columns:
                tr[col] = tr[col] * k
    meta = {**res.meta, "initial_capital": cap, "period_start": str(s), "period_end": str(e),
            "rebase_factor": k}
    return BacktestResult(res.name, equity, r.rename("returns"), positions, tr.reset_index(drop=True),
                          costs, meta)


def slice_results(results: Mapping[str, BacktestResult], p: Period) -> dict[str, BacktestResult]:
    return {n: slice_result(r, p.start, p.end) for n, r in results.items()}


# --------------------------------------------------------------------------- per-result tables
def cost_row(res: BacktestResult) -> dict[str, float]:
    """Gross P&L, every cost component separately, net P&L and annual turnover (x avg equity)."""
    c = res.costs if res.costs is not None else pd.DataFrame()
    comp = {k: float(c[k].sum()) if k in c.columns else 0.0 for k in ("fees", "spread", "impact", "funding")}
    eq = res.equity.astype(float)
    cap = float(res.meta.get("initial_capital", eq.iloc[0] if len(eq) else 0.0))
    net = float(eq.iloc[-1] - cap) if len(eq) else 0.0
    total = sum(comp.values())
    years = len(eq) / 8760.0
    traded = float(res.trades["qty_notional"].abs().sum()) if len(res.trades) else 0.0
    avg_eq = float(eq.mean()) if len(eq) else float("nan")
    return {
        "Gross P&L": net + total,
        "Fees": comp["fees"],
        "Spread": comp["spread"],
        "Impact": comp["impact"],
        "Funding (+paid / -received)": comp["funding"],
        "Total costs": total,
        "Net P&L": net,
        "Annual turnover (x avg equity)": (traded / avg_eq / years) if years > 0 and avg_eq > 0
        else float("nan"),
    }


def cost_table(results: Mapping[str, BacktestResult]) -> pd.DataFrame:
    df = pd.DataFrame({n: cost_row(r) for n, r in results.items()}).T
    df.index.name = "Strategy"
    return df


SUMMARY_KEYS = ("total_return", "cagr", "ann_vol", "sharpe", "sortino", "calmar", "max_drawdown",
                "worst_month", "best_month", "pct_positive_months")


def summary_table(results: Mapping[str, BacktestResult]) -> pd.DataFrame:
    rows = {}
    for n, r in results.items():
        s = metrics.performance_summary(r.returns)
        rows[n] = {k: s.get(k) for k in SUMMARY_KEYS} | {"final_equity": float(r.equity.iloc[-1])}
    df = pd.DataFrame(rows).T
    df.index.name = "Strategy"
    return df


# --------------------------------------------------------------------------- allocations
def cash_result(index: pd.DatetimeIndex, capital: float) -> BacktestResult:
    """A sleeve that holds cash (earns 0, no costs, no trades)."""
    idx = pd.DatetimeIndex(index)
    return BacktestResult(
        CASH, pd.Series(float(capital), index=idx, name="equity"), pd.Series(0.0, index=idx, name="returns"),
        {}, pd.DataFrame(columns=["ts", "symbol", "market", "side", "qty_notional", "price", "fee", "spread",
                                  "impact"]),
        pd.DataFrame(0.0, index=idx, columns=["fees", "spread", "impact", "funding"]),
        {"initial_capital": float(capital)},
    )


def build_allocations(
    run_sleeve: Callable[[str, float], BacktestResult],
    capital: float,
    allocations: list[tuple[str, dict[str, float]]] = ALLOCATIONS,
) -> dict[str, BacktestResult]:
    """Combine sleeves for each allocation. Each sleeve is RE-RUN at exactly capital * weight (impact is
    non-linear in size, so no linear rescaling). Combined equity = sum of sleeve equities (no rebalancing)."""
    cache: dict[tuple[str, float], BacktestResult] = {}
    out: dict[str, BacktestResult] = {}
    for label, alloc in allocations:
        if not math.isclose(sum(alloc.values()), 1.0, abs_tol=1e-9):
            raise ValueError(f"allocation {label} does not sum to 1")
        sleeves: dict[str, BacktestResult] = {}
        for name, w in alloc.items():
            if name == CASH or w <= 0:
                continue
            key = (name, round(capital * w, 6))
            if key not in cache:
                cache[key] = run_sleeve(name, capital * w)
            sleeves[name] = cache[key]
        if not sleeves:
            raise ValueError(f"allocation {label} has no risky sleeve")
        if alloc.get(CASH, 0.0) > 0:
            idx = pd.DatetimeIndex(sorted(set().union(*[r.equity.index for r in sleeves.values()])))
            sleeves[CASH] = cash_result(idx, capital * alloc[CASH])
        out[label] = combine(sleeves, {k: alloc.get(k, 0.0) for k in sleeves}, capital)
    return out


def allocation_table(period_allocs: Mapping[str, BacktestResult], trend: BacktestResult | None,
                     carry: BacktestResult | None) -> pd.DataFrame:
    """Per-allocation stats on the (already sliced) period, plus the daily trend/carry correlation."""
    corr = float("nan")
    if trend is not None and carry is not None:
        td, cd = metrics.daily_returns(trend.returns), metrics.daily_returns(carry.returns)
        both = pd.concat([td, cd], axis=1).dropna()
        if len(both) > 2 and both.std().min() > 0:
            corr = float(np.corrcoef(both.to_numpy(dtype=float).T)[0, 1])
    rows = {}
    for n, r in period_allocs.items():
        s = metrics.performance_summary(r.returns)
        rows[n] = {"CAGR": s["cagr"], "Sharpe": s["sharpe"], "Sortino": s["sortino"],
                   "Max drawdown": s["max_drawdown"], "Worst month": s["worst_month"],
                   "% positive months": s["pct_positive_months"],
                   "Net P&L": float(r.equity.iloc[-1] - r.meta.get("initial_capital", r.equity.iloc[0])),
                   "Corr(trend, carry) daily": corr}
    df = pd.DataFrame(rows).T
    df.index.name = "Allocation"
    return df


# --------------------------------------------------------------------------- statistics
def _safe(fn: Callable[[], Any]) -> Any:
    try:
        v = fn()
    except Exception as exc:  # noqa: BLE001 - too few observations etc. -> reported, not hidden
        return f"n/a ({type(exc).__name__})"
    return v


def _psr(d: pd.Series) -> float:
    x = d.dropna().to_numpy(dtype=float)
    if len(x) < 3 or x.std(ddof=1) == 0:
        return float("nan")
    from scipy import stats as st

    return stats.probabilistic_sharpe(float(x.mean() / x.std(ddof=1)), len(x), float(st.skew(x)),
                                      float(st.kurtosis(x, fisher=False)))


def _boot_ci(d: pd.Series) -> list[float]:
    return list(stats.block_bootstrap_ci(d, lambda x: float(x.mean() / x.std() * (365**0.5)), seed=7))


def period_stats(results: Mapping[str, BacktestResult], trials: Mapping[str, BacktestResult],
                 p: Period) -> dict[str, Any]:
    """All robustness statistics computed on daily returns WITHIN the (already sliced) period."""
    out: dict[str, Any] = {"period": p.key, "label": p.label, "start": str(p.start), "end": str(p.end)}
    daily = {n: metrics.daily_returns(r.returns) for n, r in results.items()}
    for n in ("Combined", "Trend", "Carry"):
        if n not in daily:
            continue
        d = daily[n]
        out[f"{n.lower()}_hac_tstat"] = _safe(partial(stats.sharpe_hac_tstat, d))
        out[f"{n.lower()}_bootstrap_sharpe_ci"] = _safe(partial(_boot_ci, d))
        out[f"{n.lower()}_psr"] = _safe(partial(_psr, d))
    trial_df = pd.DataFrame({k: metrics.daily_returns(r.returns) for k, r in trials.items()}).dropna()
    trial_sharpes = [float(c.mean() / c.std()) for _, c in trial_df.items() if c.std() > 0]
    if "Trend" in daily and trial_sharpes:
        out["dsr_trend"] = _safe(lambda: stats.deflated_sharpe(daily["Trend"], trial_sharpes))
    if len(trial_df.columns) >= 2:
        out["pbo_trend"] = _safe(lambda: stats.pbo_cscv(trial_df, S=16)["pbo"])
        if BENCH in daily:
            bench = daily[BENCH].reindex(trial_df.index).fillna(0.0)
            out["spa_vs_btc"] = _safe(lambda: stats.spa_test(trial_df, bench))
    out["n_trials"] = len(trial_sharpes)
    out["n_days"] = int(len(daily.get(PRIMARY, pd.Series(dtype=float))))
    return out


def evaluate_periods(
    periods: Sequence[Period],
    results: Mapping[str, BacktestResult],
    trials: Mapping[str, BacktestResult],
    allocs: Mapping[str, BacktestResult],
    stress_runs: Mapping[float, Mapping[str, BacktestResult]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Slice every result set into each period and compute that period's tables and statistics."""
    period_ctx: list[dict[str, Any]] = []
    stats_json: dict[str, Any] = {}
    for p in periods:
        pres = slice_results(results, p)
        ptrials = slice_results(trials, p)
        palloc = slice_results(allocs, p)
        st_rows = {}
        for mult, rs in stress_runs.items():
            s = metrics.performance_summary(slice_result(rs[PRIMARY], p.start, p.end).returns)
            st_rows[f"{mult:.1f}x costs"] = {k: s.get(k) for k in ("cagr", "sharpe", "max_drawdown")}
        pstats = period_stats(pres, ptrials, p)
        entry: dict[str, Any] = {
            "key": p.key, "label": p.label, "range": p.range_text, "title": p.title,
            "start": p.start, "end": p.end,
            "results": pres,
            "trials": ptrials,
            "summary": summary_table(pres),
            "costs": cost_table(pres),
            "allocations": allocation_table(palloc, pres.get("Trend"), pres.get("Carry")),
            "stress": pd.DataFrame(st_rows).T,
            "stats": pstats,
        }
        period_ctx.append(entry)
        stats_json[p.key] = {**pstats, "summary": entry["summary"], "costs": entry["costs"],
                             "allocations": entry["allocations"], "stress": entry["stress"]}
    return period_ctx, stats_json


def walk_forward_table(comb_ret: pd.Series, wf_cfg: dict, periods: list[Period],
                       holdout_start: Any) -> pd.DataFrame:
    """Fixed-parameter walk-forward folds; each test window is labelled with the period it lies in."""
    rows = []
    idx = pd.DatetimeIndex(comb_ret.index)
    hs = _utc(holdout_start)
    for tr_pos, te_pos in walk_forward_splits(idx, wf_cfg["train_months"], wf_cfg["test_months"],
                                              wf_cfg["embargo_bars"]):
        tr, te = idx[tr_pos], idx[te_pos]
        s = metrics.performance_summary(comb_ret.loc[te[0]:te[-1]])
        where = "HOLDOUT" if te[0] >= hs else ("DEVELOPMENT" if te[-1] < hs else "straddles split")
        rows.append({"train": f"{tr[0]:%Y-%m-%d} → {tr[-1]:%Y-%m-%d}",
                     "test": f"{te[0]:%Y-%m-%d} → {te[-1]:%Y-%m-%d}", "test period": where,
                     "test_return": s.get("total_return"), "test_sharpe": s.get("sharpe"),
                     "test_max_drawdown": s.get("max_drawdown")})
    return pd.DataFrame(rows)


def read_holdout_log(path: Path) -> pd.DataFrame:
    rows = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    df = pd.DataFrame(rows, columns=["timestamp", "reason", "holdout_start"])
    df.index = pd.RangeIndex(1, len(df) + 1, name="#")
    return df


# --------------------------------------------------------------------------- running
class _CachedStrategy:
    """Weights do not depend on capital or costs; compute them once per strategy."""

    def __init__(self, strat: Strategy) -> None:
        self.name = strat.name
        self._s = strat
        self._tw: TargetWeights | None = None

    def target_weights(self, data: Dataset) -> TargetWeights:
        if self._tw is None:
            self._tw = self._s.target_weights(data)
        return self._tw


def _cost_model(exp: dict, mult: float) -> CostModel:
    cfg = copy.deepcopy(exp["costs"])
    cfg["stress_multiplier"] = cfg.get("stress_multiplier", 1.0) * mult
    return CostModel.from_config(cfg, base_dir=ROOT)   # spreads_file resolved vs repo, not CWD (B3)


def h2_last_bar() -> pd.Timestamp:
    """Last hourly bar strictly before the sealed H2 window."""
    from engine.research.contract import H2_START

    return pd.Timestamp(H2_START) - pd.Timedelta(hours=1)


def log_holdout_view(reason: str, params_hash: str, source: str, window: str = "H2",
                     log_path: str | Path | None = None) -> dict[str, Any]:
    """Append one holdout view to experiments/holdout_log.jsonl (append-only) and return the record.

    window="H2": tagged `holdout: "H2"` so engine.research.holdout_guard.h2_open_count() counts it.
    window="H1": a view of the consumed H1 window by a script outside run_pipeline (e.g. lead-lag --full);
    recorded with params_hash so HoldoutLock.reserve() can see it (AUDIT_REPORT B6/B9)."""
    from engine.research.contract import H1_START, H2_START
    from engine.research.holdout_guard import H2_TAG, h2_open_count

    if not reason or not reason.strip():
        raise ValueError("a holdout view needs a non-empty reason")
    p = Path(log_path) if log_path is not None else HOLDOUT_LOG
    p.parent.mkdir(parents=True, exist_ok=True)
    rec: dict[str, Any] = {"timestamp": datetime.now(UTC).isoformat(), "reason": reason.strip(),
                           "params_hash": params_hash, "source": source}
    if window == "H2":
        rec.update(holdout=H2_TAG, holdout_start=pd.Timestamp(H2_START).isoformat(),
                   h2_opening_number=h2_open_count(p) + 1)
    elif window == "H1":
        rec.update(holdout_start=pd.Timestamp(H1_START).isoformat(), contaminated=True)
    else:
        raise ValueError(f"unknown holdout window {window!r}")
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def run_all(cost_multiplier: float, data: Dataset, exp: dict, start: Any, end: Any,
            strategies: Sequence[Strategy] | None = None) -> dict[str, BacktestResult]:
    cm = _cost_model(exp, cost_multiplier)
    cap = float(exp["initial_capital"])
    strats = list(strategies if strategies is not None else build_strategies(exp))
    # Same allocation rule as live (engine.live.signals_live.resolve_allocation): unallocated sleeves
    # are skipped instead of being run with zero capital (AUDIT_REPORT B2).
    alloc = resolve_allocation([s.name for s in strats], exp["strategies"].get("allocation"))
    sleeves: dict[str, BacktestResult] = {}
    for strat in strats:
        if alloc[strat.name] <= 0.0:
            continue
        sleeves[strat.name] = run_backtest(
            strat, data, cm, cap * alloc.get(strat.name, 0.0), start=start, end=end, name=strat.name
        )
    out: dict[str, BacktestResult] = {PRIMARY: combine(sleeves, alloc, cap)}
    out.update({k.capitalize(): v for k, v in sleeves.items()})
    out[BENCH] = benchmark_buy_hold(data, "BTC", "spot", cap, cm, start=start, end=end)
    return out


def trend_trial_grid(exp: dict) -> list[dict]:
    """Small, pre-declared parameter grid (all variants count as trials for DSR / PBO)."""
    base = exp["strategies"]["trend"]
    grid = []
    for lbs in ([20, 60, 120], [10, 30, 90], [30, 90, 180]):
        for vt in (0.15, 0.20, 0.30):
            p = dict(base, lookbacks_days=lbs, vol_target_annual=vt)
            grid.append(p)
    return grid


def _jsonable(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, list | tuple):
        return [_jsonable(v) for v in o]
    if isinstance(o, np.floating | float):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, pd.DataFrame):
        return _jsonable(o.to_dict(orient="index"))
    if isinstance(o, pd.Timestamp | pd.Timedelta):
        return str(o)
    return o


def run_pipeline(unlock_holdout: bool = False, reason: str = "", out_dir: str = "reports",
                 acknowledge_reuse: bool = False, open_h2: bool = False) -> Path:
    if open_h2 and not unlock_holdout:
        raise ValueError("open_h2 requires unlock_holdout")
    if open_h2 and not reason.strip():
        raise ValueError("opening H2 requires an explicit --reason")
    uni, exp = load_config("universe.yaml"), load_config("experiment.yaml")
    data_root = ROOT / "data" / "cleaned"
    data = load_dataset(str(data_root), symbols=uni["symbols"])
    log_path = ROOT / "experiments" / "holdout_log.jsonl"

    split = exp["split"]
    lock = HoldoutLock(split["holdout_start"], log_path=str(log_path))
    prior_views = 0
    if unlock_holdout:
        from engine.track.versions import params_hash

        ph = params_hash(exp["strategies"], list(uni["symbols"]), {})
        prior_views = lock.reserve(ph, acknowledge_reuse)     # raises before any holdout data is read
        lock.unlock(reason or "final evaluation", params_hash=ph, prior_views=prior_views)
        if open_h2:
            log_holdout_view(reason, ph, source="pipeline --open-h2", window="H2", log_path=log_path)
    if unlock_holdout:
        end: pd.Timestamp | None = None if open_h2 else h2_last_bar()   # H2 sealed unless opened (B7)
    else:
        end = _utc(split["dev_end"]) + pd.Timedelta(hours=23)
    if end is not None:
        data = data.truncate(end)
    lock.check(data.perp.close)

    registry = ExperimentRegistry(str(ROOT / "experiments" / "registry.jsonl"))
    sha, dh = git_sha(), data_hash(data_root)
    cap = float(exp["initial_capital"])
    strategies = [_CachedStrategy(s) for s in build_strategies(exp)]
    by_name = {s.name: s for s in strategies}

    # 1) One run over all available data at 1x costs (+ stress multiples)
    results = run_all(1.0, data, exp, None, end, strategies)
    stress_runs = {1.0: results}
    for mult in (1.5, 2.0):
        stress_runs[mult] = {PRIMARY: run_all(mult, data, exp, None, end, strategies)[PRIMARY]}

    periods = make_periods(pd.DatetimeIndex(results[PRIMARY].equity.index), split["dev_end"],
                           split["holdout_start"], unlock_holdout)

    # 2) Trend trial grid (one run each, sliced per period)
    from engine.signals.trend import TrendStrategy

    cm1 = _cost_model(exp, 1.0)
    trials: dict[str, BacktestResult] = {}
    grid = trend_trial_grid(exp)
    for i, prm in enumerate(grid):
        trials[f"trend_{i}"] = run_backtest(TrendStrategy(prm), data, cm1, cap, end=end, name=f"trend_{i}")

    # 3) Allocation mixes, sleeves re-run at exact capital
    def run_sleeve(name: str, capital: float) -> BacktestResult:
        return run_backtest(by_name[name], data, cm1, capital, end=end, name=f"{name}@{capital:.0f}")

    allocs = build_allocations(run_sleeve, cap)
    allocs[BENCH] = results[BENCH]

    # 4) Per-period evaluation (returns inside each period only, equity rebased)
    period_ctx, stats_json = evaluate_periods(periods, results, trials, allocs, stress_runs)
    dev_trials = next((pc["trials"] for pc in period_ctx if pc["key"] == "dev"), None)
    if dev_trials is not None:
        for i, prm in enumerate(grid):
            registry.log(strategy="trend", params=prm,
                         metrics={**metrics.performance_summary(dev_trials[f"trend_{i}"].returns),
                                  "period": "dev"}, data_hash=dh)

    # 5) Walk-forward folds of the combined portfolio (parameters fixed)
    wf = walk_forward_table(results[PRIMARY].returns, exp["walk_forward"], periods, split["holdout_start"])

    for name, r in results.items():
        registry.log(strategy=name, params=exp["strategies"],
                     metrics={**metrics.performance_summary(r.returns),
                              "period": "full" if unlock_holdout else "dev"}, data_hash=dh)

    hlog = read_holdout_log(log_path)
    stats_json["walk_forward"] = wf.to_dict(orient="records")
    stats_json["holdout_views"] = len(hlog)
    stats_json["holdout_unlocked_this_run"] = unlock_holdout
    stats_json["holdout_contaminated"] = bool(unlock_holdout and prior_views)
    stats_json["h2_opened_this_run"] = open_h2
    stats_json["n_trials"] = len(grid)

    full_idx = results[PRIMARY].equity.index
    ctx = {
        "title": "Systematic Crypto Engine — Backtest Report"
                 + ((" (all periods incl. H2, holdout unlocked)" if open_h2 else
                     " (DEVELOPMENT + H1, holdout unlocked; H2 sealed)")
                    if unlock_holdout else " (DEVELOPMENT period only)")
                 + (f" — HOLDOUT CONTAMINATED: viewed {prior_views} time(s) before, NOT out-of-sample"
                    if prior_views else ""),
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        "data_range": f"{full_idx.min():%Y-%m-%d} → {full_idx.max():%Y-%m-%d}",
        "universe": uni["symbols"],
        "git_sha": sha,
        "params": exp,
        "results": results,
        "periods": period_ctx,
        "walk_forward": wf,
        "holdout_log": hlog,
        "holdout_views": len(hlog),
        "holdout_unlocked": unlock_holdout,
        "oos_label": {PRIMARY: {"in_sample_end": split["dev_end"], "holdout_start": split["holdout_start"]}}
        if unlock_holdout else {},
        "notes": [
            "Fills at next 1h bar open after the decision bar; taker fees, half-spread, sqrt impact.",
            "Half-spreads come from data/cleaned/spreads.json (perp: Binance bookTicker sample 2023-24; "
            "spot and other perps: Abdi-Ranaldo estimator). They are full-sample statistics, not "
            "point-in-time (AUDIT_REPORT B10, section 7.2).",
            "Universe picked in 2026 includes LUNA and FTT but is still partly survivorship-biased.",
            "Exchange/counterparty failure (e.g. FTX 2022) is not modeled; carry assumes Binance solvency.",
            "Period statistics use only returns inside that period; equity is rebased at each period start.",
            "Walk-forward keeps parameters fixed (no re-fit per fold): it measures stability, not fitting.",
            "Past performance does not guarantee future results. Not investment advice.",
        ],
    }
    out = ROOT / out_dir
    out.mkdir(exist_ok=True)
    for legacy in LEGACY_OUTPUTS:
        lp = out / legacy
        if lp.is_dir():
            shutil.rmtree(lp)
        elif lp.exists():
            lp.unlink()
    tables = out / "tables"
    if tables.exists():
        shutil.rmtree(tables)  # never leave stale holdout tables next to a locked (dev-only) run
    html = build_report(ctx, str(out / "report.html"))
    export_period_tables(ctx, str(tables))
    (out / "stats.json").write_text(json.dumps(_jsonable(stats_json), default=str, indent=2),
                                    encoding="utf-8")
    return Path(html)
