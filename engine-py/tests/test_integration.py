"""Integration + regression tests for the audit fixes (AUDIT_REPORT B1-B3, B5, B7-B9, section 7.2)
and the CLI / paper-loop wiring of the new research packages. Synthetic data only, no network."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.costs import CostModel
from engine.live.paper import PaperLedger
from engine.live.signals_live import LiveSignal, resolve_allocation
from engine.research.contract import H2_START
from engine.research.holdout_guard import h2_open_count
from engine.validation.metrics import _round_trip_pnls


def _toy(n: int = 60, stale_at: int | None = None) -> Dataset:
    idx = pd.date_range("2026-01-01", periods=n, freq="h", tz="UTC", name="ts")
    px = pd.DataFrame({"BTC": np.linspace(100, 159, n), "ETH": np.linspace(50, 79.5, n)}, index=idx)
    filled = px < 0
    if stale_at is not None:
        filled.iloc[stale_at, filled.columns.get_loc("ETH")] = True

    def md() -> MarketData:
        return MarketData(open=px - 0.5, high=px + 1, low=px - 1, close=px, volume=px * 0 + 1e6,
                          quote_volume=px * 0 + 1e8, is_filled=filled)

    return Dataset(spot=md(), perp=md(), funding=pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC")))


def _cost() -> CostModel:
    return CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.0)


# --------------------------------------------------------------------------- B1
def test_forced_exit_of_short_is_a_buy() -> None:
    """Short 10 @100, forced exit (engine notional = -qty*p = +900) @90 -> +100 profit, one trip."""
    tr = pd.DataFrame({"ts": pd.date_range("2024-01-01", periods=2, freq="h", tz="UTC"),
                       "symbol": ["X", "X"], "market": ["perp", "perp"], "side": ["sell", "forced_exit"],
                       "qty_notional": [-1000.0, 900.0], "price": [100.0, 90.0]})
    pnl = _round_trip_pnls(tr)
    assert pnl is not None and len(pnl) == 1
    assert pnl.iloc[0] == pytest.approx(100.0)


def test_forced_exit_of_long_is_a_sell() -> None:
    tr = pd.DataFrame({"symbol": ["X", "X"], "side": ["buy", "forced_exit"],
                       "qty_notional": [1000.0, -900.0], "price": [100.0, 90.0]})
    pnl = _round_trip_pnls(tr)
    assert pnl is not None and pnl.iloc[0] == pytest.approx(-100.0)


# --------------------------------------------------------------------------- B2
def test_allocation_rule_shared_by_backtest_and_live() -> None:
    alloc = {"trend": 0.5, "carry": 0.5}
    assert resolve_allocation(["trend", "carry"], alloc) == alloc
    # enabled but unallocated -> skipped (0), configured weights untouched
    assert resolve_allocation(["trend", "carry", "xsmom"], {"trend": 0.5, "carry": 0.5}) == \
        {"trend": 0.5, "carry": 0.5, "xsmom": 0.0}
    # no allocation block -> 1/N
    assert resolve_allocation(["a", "b"], {}) == {"a": 0.5, "b": 0.5}


def test_pipeline_run_all_skips_unallocated_sleeve() -> None:
    from engine.contracts import TargetWeights
    from engine.pipeline import run_all

    d = _toy(200)

    class Flat:
        def __init__(self, name: str) -> None:
            self.name = name

        def target_weights(self, data: Dataset) -> TargetWeights:
            z = data.perp.close * 0.0
            return TargetWeights(spot=z, perp=z)

    exp = {"initial_capital": 10_000.0, "strategies": {"allocation": {"a": 1.0}},
           "costs": {"fee_bps": {"spot": 10.0, "perp": 5.0}, "half_spread_bps": {"default": 2.0},
                     "impact_y": 0.0}}
    out = run_all(1.0, d, exp, None, None, [Flat("a"), Flat("b")])   # type: ignore[list-item]
    assert "A" in out and "B" not in out          # previously "B" ran with 0 capital and was ruined
    assert not out["A"].meta.get("ruined", False)


# --------------------------------------------------------------------------- B3
def test_pipeline_cost_model_resolves_spreads_against_repo(tmp_path: Path, monkeypatch: Any) -> None:
    from engine.pipeline import ROOT, _cost_model, load_config

    exp = load_config("experiment.yaml")
    sf = exp["costs"].get("spreads_file")
    if not sf or not (ROOT / sf).exists():
        pytest.skip("no measured spreads file in this checkout")
    monkeypatch.chdir(tmp_path)                    # CWD without data/ -> must still find spreads
    assert _cost_model(exp, 1.0).measured_spread_bps


# --------------------------------------------------------------------------- B5
def test_paper_fill_skips_stale_bar(tmp_path: Path) -> None:
    d = _toy(60, stale_at=11)                      # ETH bar after the decision is forward-filled
    lg = PaperLedger(tmp_path, 10_000.0)
    lg.set_pending(d.perp.close.index[10], {"spot": {}, "perp": {"BTC": 0.3, "ETH": 0.3}})
    fills = lg.fill_pending(d, _cost())
    assert {f["symbol"] for f in fills} == {"BTC"}
    assert "ETH" not in lg.state.qty["perp"]


# --------------------------------------------------------------------------- B7-B9 holdout logging
def test_log_holdout_view_h2_counts_and_has_params_hash(tmp_path: Path) -> None:
    from engine.pipeline import log_holdout_view

    log = tmp_path / "holdout_log.jsonl"
    r = log_holdout_view("unit test", "abc123", source="test", window="H2", log_path=log)
    assert r["params_hash"] == "abc123" and r["holdout"] == "H2"
    assert h2_open_count(log) == 1
    r1 = log_holdout_view("unit test", "abc123", source="test", window="H1", log_path=log)
    assert r1["contaminated"] and "holdout" not in r1
    assert h2_open_count(log) == 1
    with pytest.raises(ValueError):
        log_holdout_view("  ", "x", source="test", log_path=log)


def test_pipeline_h2_cut_and_open_h2_guards() -> None:
    from engine.pipeline import h2_last_bar, run_pipeline

    assert h2_last_bar() < H2_START and h2_last_bar() + pd.Timedelta(hours=1) == H2_START
    with pytest.raises(ValueError):
        run_pipeline(open_h2=True, reason="x")                  # needs unlock_holdout
    with pytest.raises(ValueError):
        run_pipeline(unlock_holdout=True, open_h2=True, reason="")


def test_backtest_leadlag_open_h2_requires_full() -> None:
    from engine.leadlag.backtest_leadlag import run

    with pytest.raises(ValueError):
        run(full=False, open_h2=True, reason="x")


def test_leadlag_study_stops_before_h2(tmp_path: Path, monkeypatch: Any) -> None:
    from engine.leadlag import study

    idx = pd.date_range(H2_START - pd.Timedelta(days=40), H2_START + pd.Timedelta(days=10), freq="h",
                        tz="UTC", name="ts")
    seen: dict[str, Any] = {}

    def fake_load(root: str, symbols: list[str]) -> Dataset:
        px = pd.DataFrame({s: 100 + np.random.default_rng(0).normal(0, 1, len(idx)).cumsum()
                           for s in symbols}, index=idx)
        md = MarketData(open=px, high=px + 1, low=px - 1, close=px, volume=px * 0 + 1,
                        quote_volume=px * 0 + 1, is_filled=px < -1e9)
        return Dataset(md, md, pd.DataFrame(index=pd.DatetimeIndex([], tz="UTC")))

    def stop(*a: Any, **k: Any) -> Any:
        seen["max_ts"] = a[0].index.max()
        raise RuntimeError("stop")

    monkeypatch.setattr(study, "load_dataset", fake_load)
    monkeypatch.setattr(study, "log_returns", lambda c, f: stop(c))
    monkeypatch.setattr(study, "OUT", tmp_path)
    cfg = {"leader": "BTC", "followers": ["ETH"], "data_root": "x"}
    with pytest.raises(RuntimeError):
        study.run(cfg)
    assert seen["max_ts"] < H2_START
    log = tmp_path / "log.jsonl"
    with pytest.raises(RuntimeError):
        study.run(cfg, open_h2=True, reason="unit test", log_path=log)
    assert seen["max_ts"] >= H2_START and h2_open_count(log) == 1


# --------------------------------------------------------------------------- section 7.2 causal spreads
def test_causal_spread_ignores_future_months() -> None:
    from engine.data.spreads import causal_half_spread_bps

    idx = pd.date_range("2023-01-01", "2023-12-31 23:00", freq="h", tz="UTC")
    rng = np.random.default_rng(1)
    c = pd.Series(100 * np.exp(rng.normal(0, 0.003, len(idx)).cumsum()), index=idx)
    bars = pd.DataFrame({"close": c, "high": c * 1.004, "low": c * 0.996})
    base = causal_half_spread_bps(bars)
    fut = bars.copy()
    fut.loc["2023-09-01":, ["high"]] *= 1.05              # perturb only months >= Sep
    pert = causal_half_spread_bps(fut)
    cut = pd.Timestamp("2023-09-01", tz="UTC")
    pd.testing.assert_series_equal(base[base.index <= cut], pert[pert.index <= cut])
    assert base.iloc[:3].isna().all()                     # min_months prior estimates required


# --------------------------------------------------------------------------- paper monitor / ensemble hook
def _sig(t: pd.Timestamp) -> LiveSignal:
    return LiveSignal(asof=t, sleeves={"trend": {"spot": {}, "perp": {"BTC": 0.4, "ETH": -0.2}}},
                      decided_at={"trend": str(t)}, combined={"spot": {}, "perp": {"BTC": 0.2, "ETH": -0.1}},
                      allocation={"trend": 0.5})


def test_paper_step_logs_and_resolves_predictions(tmp_path: Path) -> None:
    from engine.live.ensemble_hook import log_step_predictions
    from engine.live.paper import close_prices
    from engine.monitor.ledger import Ledger

    d = _toy(60)
    t1 = d.perp.close.index[40]
    r = log_step_predictions(tmp_path, _sig(t1), d.truncate(t1), t1, close_prices(d, t1))
    assert r["predictions_logged"] == 2
    again = log_step_predictions(tmp_path, _sig(t1), d.truncate(t1), t1, close_prices(d, t1))
    assert again["predictions_logged"] == 0                  # append-only, deduped by signal_id
    t2 = d.perp.close.index[42]
    r2 = log_step_predictions(tmp_path, None, d.truncate(t2), t2, close_prices(d, t2))
    assert r2["predictions_resolved"] == 2
    preds = Ledger(tmp_path).predictions()
    assert {p["model_id"] for p in preds} == {"sleeve.trend"}
    assert all(math.isnan(p["confidence"]) for p in preds)


def test_ensemble_layer_off_by_default_and_flat_on_halt(tmp_path: Path) -> None:
    import yaml

    from engine.live.ensemble_hook import apply_ensemble, health_multipliers
    from engine.live.risk import RiskLimits
    from engine.pipeline import ROOT

    live = yaml.safe_load((ROOT / "config" / "live.yaml").read_text(encoding="utf-8"))
    assert live.get("ensemble", {}).get("enabled", False) is False
    (tmp_path / "model_health.json").write_text(json.dumps({"sleeve.trend": {"size_multiplier": 0.4}}))
    assert health_multipliers(tmp_path, ["trend", "carry"]) == {"trend": 0.4, "carry": 1.0}
    d = _toy(60)
    t = d.perp.close.index[-1]
    tgt, rec = apply_ensemble({}, _sig(t), d, t, t, 10_000.0, 10_000.0, True, ["test halt"],
                              RiskLimits(), _cost(), tmp_path)
    assert tgt == {"spot": {}, "perp": {}}
    assert rec["health_multipliers"]["trend"] == 0.4 and rec["no_trade"]


# --------------------------------------------------------------------------- CLI
def test_cli_parses_new_subcommands() -> None:
    import argparse

    from engine import cli

    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")
    cli.add_research_parsers(sub)
    for argv in (["pit", "build"], ["universe-at", "2024-01-01"], ["features", "list"], ["data", "validate"],
                 ["research", "run", "--hypothesis", "H-0001", "--model", "m"],
                 ["research", "open-h2", "--reason", "r"], ["research", "registry"], ["leadlag-engine"],
                 ["regimes"], ["monitor", "drift"], ["events", "ingest", "listings"],
                 ["events", "ingest", "--rss", "u", "--source", "s"]):
        a = p.parse_args(argv)
        assert a.cmd in cli.RESEARCH_CMDS


def test_cli_features_list(capsys: Any) -> None:
    from engine import cli

    with pytest.raises(SystemExit) as e:
        cli.main(["features", "list"])
    assert e.value.code == 0
    assert "ret_1h" in capsys.readouterr().out
