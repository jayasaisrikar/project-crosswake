"""Net-of-cost backtest of the lead-lag strategy vs baselines, over the common framework.

This turns the event study (engine.leadlag.events) into an executable strategy and prices it with the
SAME backtester and cost model as every other sleeve, so the "is BTC->alt lead-lag tradable on hourly
bars?" question is answered in net-return terms, not just t-stats. Runs on the DEVELOPMENT period only by
default (truncates at split.dev_end) to keep the locked holdout clean. --full adds a descriptive H1
view (data stop before H2_START) and appends an H1 view with params_hash to
experiments/holdout_log.jsonl; --full --open-h2 --reason "..." also includes the sealed H2 window and is
logged as an H2 opening (AUDIT_REPORT B9). Writes reports/leadlag/strategy_comparison.csv and appends to
the experiment registry.

Usage: uv run python -m engine.leadlag.backtest_leadlag [--full [--open-h2 --reason "..."]]
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd
import yaml

from engine.backtest.engine import run_backtest
from engine.backtest.portfolio import benchmark_buy_hold
from engine.costs import CostModel
from engine.data.load import load_dataset
from engine.leadlag import scorecard as sc
from engine.signals.leadlag import BtcImpulseFollow, LeadLagStrategy
from engine.signals.trend import TrendStrategy
from engine.validation import metrics
from engine.validation.walkforward import ExperimentRegistry

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "reports" / "leadlag"
KEYS = ("total_return", "cagr", "ann_vol", "sharpe", "sortino", "max_drawdown")

# Pre-registered variant grid: thresholds x holding horizons (continuation direction).
VARIANTS: list[dict[str, Any]] = [
    {"k": 2.0, "hold_hours": 1}, {"k": 2.0, "hold_hours": 2}, {"k": 2.0, "hold_hours": 4},
    {"k": 3.0, "hold_hours": 1}, {"k": 3.0, "hold_hours": 2}, {"k": 3.0, "hold_hours": 4},
]


def _cfg(name: str) -> dict[str, Any]:
    with open(ROOT / "config" / name, encoding="utf-8") as f:
        return dict(yaml.safe_load(f))


def _period_rows(res: Any, name: str, dev_end: pd.Timestamp, full: bool) -> list[dict[str, Any]]:
    r = res.returns
    rows = []
    segs = {"dev": r[r.index <= dev_end]}
    if full:
        segs["holdout"] = r[r.index > dev_end]
    for seg, rr in segs.items():
        s = metrics.performance_summary(rr)
        rows.append({"strategy": name, "segment": seg, "n_trades": res.meta.get("n_trades", 0),
                     "turnover_annual": round(res.meta.get("turnover_annual", 0.0), 2),
                     **{k: (round(float(s[k]), 4) if s.get(k) is not None else None) for k in KEYS}})
    return rows


def run_params_hash(exp: dict[str, Any], symbols: list[str]) -> str:
    from engine.track.versions import params_hash

    return params_hash({"leadlag": exp["strategies"]["leadlag"], "trend": exp["strategies"]["trend"]},
                       symbols, {"variants": VARIANTS, "script": "backtest_leadlag"})


def run(full: bool = False, open_h2: bool = False, reason: str = "",
        log_path: str | Path | None = None) -> pd.DataFrame:
    from engine.pipeline import h2_last_bar, log_holdout_view

    if open_h2 and not full:
        raise ValueError("--open-h2 requires --full")
    uni, exp = _cfg("universe.yaml"), _cfg("experiment.yaml")
    if full:   # log BEFORE any post-dev data is read
        ph = run_params_hash(exp, list(uni["symbols"]))
        log_holdout_view(reason or "backtest_leadlag --full descriptive H1 view", ph,
                         source="backtest_leadlag --full", window="H1", log_path=log_path)
        if open_h2:
            log_holdout_view(reason, ph, source="backtest_leadlag --full --open-h2", window="H2",
                             log_path=log_path)
    OUT.mkdir(parents=True, exist_ok=True)
    data = load_dataset(str(ROOT / "data" / "cleaned"), symbols=uni["symbols"])
    dev_end = pd.Timestamp(exp["split"]["dev_end"], tz="UTC") + pd.Timedelta(hours=23)
    end = (None if open_h2 else h2_last_bar()) if full else dev_end
    if end is not None:
        data = data.truncate(end)
    cap = float(exp["initial_capital"])
    cm = CostModel.from_config(exp["costs"], base_dir=ROOT)   # B3: spreads resolved vs repo root
    cm0 = cm.with_multiplier(0.0)   # gross: zero trade costs (funding still applies)
    cm2 = cm.with_multiplier(2.0)
    reg = ExperimentRegistry(str(ROOT / "experiments" / "registry.jsonl"))

    base = dict(exp["strategies"]["leadlag"])
    rows: list[dict[str, Any]] = []
    cands: list[sc.Candidate] = []

    def dev(res: Any) -> pd.Series:
        return res.returns[res.returns.index <= dev_end]

    # Lead-lag variants at 1x cost, plus the headline (k=2,h=1) also at 0x (gross) and 2x (stress).
    for v in VARIANTS:
        prm = {**base, **v, "enabled": True}
        name = f"leadlag_k{v['k']:g}_h{v['hold_hours']}"
        res = run_backtest(LeadLagStrategy(prm), data, cm, cap, end=end, name=name)
        rows += _period_rows(res, name, dev_end, full)
        reg.log(strategy="leadlag", params=prm,
                metrics={**metrics.performance_summary(dev(res)),
                         "period": "dev", "cost_mult": 1.0}, data_hash="")
        gross = stress = None
        if v == {"k": 2.0, "hold_hours": 1}:
            res0 = run_backtest(LeadLagStrategy(prm), data, cm0, cap, end=end, name=name + "_0x")
            rows += _period_rows(res0, name + "_0xcost_gross", dev_end, full)
            res2 = run_backtest(LeadLagStrategy(prm), data, cm2, cap, end=end, name=name + "_2x")
            rows += _period_rows(res2, name + "_2xcost", dev_end, full)
            gross, stress = dev(res0), dev(res2)
        cands.append(sc.Candidate(name=name, net=dev(res), gross=gross, stress=stress,
                                  n_trades=int(res.meta.get("n_trades", 0)),
                                  turnover_annual=float(res.meta.get("turnover_annual", 0.0))))

    # Reversion (overreaction) variant of the headline cell -- prices the opposite sign fairly.
    rev = {**base, "k": 2.0, "hold_hours": 1, "direction": "reversion", "enabled": True}
    res_rev = run_backtest(LeadLagStrategy(rev), data, cm, cap, end=end, name="leadlag_k2_h1_reversion")
    rows += _period_rows(res_rev, "leadlag_k2_h1_reversion", dev_end, full)
    cands.append(sc.Candidate(name="leadlag_k2_h1_reversion", net=dev(res_rev),
                              n_trades=int(res_rev.meta.get("n_trades", 0)),
                              turnover_annual=float(res_rev.meta.get("turnover_annual", 0.0))))

    # Baselines on the same window.
    # §4.H single-asset baseline: trade only BTC in its own impulse direction (no cross-asset claim).
    imp_base = {"market": "perp", "leader": "BTC", "k": 2.0, "vol_lookback_bars": 720, "hold_hours": 1,
                "gross": 1.0}
    bimp = run_backtest(BtcImpulseFollow(imp_base), data, cm, cap, end=end, name="btc_impulse")
    rows += _period_rows(bimp, "btc_impulse_baseline", dev_end, full)
    trend = run_backtest(TrendStrategy(exp["strategies"]["trend"]), data, cm, cap, end=end, name="trend")
    rows += _period_rows(trend, "trend_baseline", dev_end, full)
    btc = benchmark_buy_hold(data, "BTC", "spot", cap, cm, end=end)
    rows += _period_rows(btc, "btc_buy_hold", dev_end, full)
    for res, bname in ((bimp, "btc_impulse_baseline"), (trend, "trend_baseline"), (btc, "btc_buy_hold")):
        cands.append(sc.Candidate(name=bname, net=dev(res), is_baseline=True,
                                  n_trades=int(res.meta.get("n_trades", 0)),
                                  turnover_annual=float(res.meta.get("turnover_annual", 0.0))))

    df = pd.DataFrame(rows)
    df.to_csv(OUT / "strategy_comparison.csv", index=False)

    # §11 scorecard + pre-registered rejection gate + honest verdict (dev window only).
    trials = [s for s in (_daily_sharpe(c.net) for c in cands if not c.is_baseline) if s == s]
    card = sc.build(cands, trial_sharpes=trials)
    card.to_csv(OUT / "scorecard.csv", index=False)
    verdict = sc.verdict(card)
    reg.log(strategy="leadlag_scorecard",
            params={"criteria": sc.REJECTION, "segment": "dev"},
            metrics={"verdict": verdict, "n_candidates": int((~card["is_baseline"]).sum()),
                     "n_pass": int((card["gate"] == "PASS").sum())}, data_hash="")

    pd.set_option("display.width", 220, "display.max_columns", 30)
    print(df.to_string(index=False))
    print("\n=== SCORECARD (dev) ===")
    print(card.to_string(index=False))
    print(f"\nVERDICT: {verdict}")
    return df


def _daily_sharpe(r: pd.Series) -> float:
    d = metrics.daily_returns(r).to_numpy()
    sd = d.std(ddof=1) if len(d) > 1 else 0.0
    return float(d.mean() / sd) if sd > 0 else float("nan")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(prog="engine.leadlag.backtest_leadlag")
    ap.add_argument("--full", action="store_true", help="add a descriptive H1 view (logged)")
    ap.add_argument("--open-h2", action="store_true", help="with --full: include sealed H2 (logged)")
    ap.add_argument("--reason", default="")
    a = ap.parse_args()
    run(full=a.full, open_h2=a.open_h2, reason=a.reason)
