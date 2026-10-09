from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from engine.validation.metrics import (
    drawdown_series,
    monthly_returns,
    performance_summary,
    yearly_returns,
)
from engine.validation.stats import (
    block_bootstrap_ci,
    deflated_sharpe,
    pbo_cscv,
    probabilistic_sharpe,
    sharpe_hac_tstat,
    spa_test,
)
from engine.validation.walkforward import (
    ExperimentRegistry,
    HoldoutLock,
    HoldoutViolation,
    walk_forward_splits,
)


def hourly(values: np.ndarray, start: str = "2021-01-01") -> pd.Series:
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq="h", tz="UTC"))


def test_constant_daily_return_metrics() -> None:
    # 1%/day, spread as a single hourly return at 00:00 each day
    days = 365
    v = np.zeros(days * 24)
    v[::24] = 0.01
    r = hourly(v)
    s = performance_summary(r)
    assert s["total_return"] == pytest.approx(1.01**days - 1)
    assert s["max_drawdown"] == 0.0
    assert s["worst_day"] == pytest.approx(0.01)
    assert s["pct_positive_months"] == 1.0
    assert s["hit_rate"] == 1.0 and s["trade_basis"] == "daily_return"
    assert s["cagr"] == pytest.approx(1.01**days - 1, rel=1e-9)


def test_monthly_table_compounds() -> None:
    idx = pd.date_range("2022-01-01", "2022-02-28 23:00", freq="h", tz="UTC")
    r = pd.Series(0.0, index=idx)
    r.loc["2022-01-05 00:00"] = 0.10
    r.loc["2022-01-20 00:00"] = 0.10
    r.loc["2022-02-10 00:00"] = -0.05
    t = monthly_returns(r)
    assert t.loc[2022, 1] == pytest.approx(0.21)
    assert t.loc[2022, 2] == pytest.approx(-0.05)
    assert np.isnan(t.loc[2022, 3])
    assert t.loc[2022, "Year"] == pytest.approx(1.21 * 0.95 - 1)
    assert yearly_returns(r).loc[2022] == pytest.approx(1.21 * 0.95 - 1)


def test_drawdown() -> None:
    r = hourly(np.array([0.10, -0.50, 0.20, 1.0, -0.1]))
    dd = drawdown_series(r)
    # equity 1.1, .55, .66, 1.32, 1.188
    assert dd.iloc[1] == pytest.approx(-0.5)
    assert dd.iloc[2] == pytest.approx(0.66 / 1.1 - 1)
    assert dd.iloc[3] == 0.0
    assert dd.iloc[4] == pytest.approx(-0.1)
    s = performance_summary(r)
    assert s["max_drawdown"] == pytest.approx(-0.5)
    assert s["max_dd_start"] == r.index[0] and s["max_dd_end"] == r.index[3]


def test_trade_pairing() -> None:
    trades = pd.DataFrame(
        {
            "ts": pd.date_range("2022-01-01", periods=4, freq="h", tz="UTC"),
            "symbol": ["BTC", "BTC", "ETH", "ETH"],
            "market": "perp",
            "side": ["buy", "sell", "sell", "buy"],
            "qty_notional": [100.0, 110.0, 100.0, 120.0],
            "price": [100.0, 110.0, 100.0, 120.0],
            "fee": 0.0,
        }
    )
    s = performance_summary(hourly(np.full(10, 0.001)), trades=trades)
    assert s["trade_basis"] == "round_trip"
    assert s["n_trades"] == 2
    assert s["hit_rate"] == 0.5
    assert s["expectancy"] == pytest.approx(-5.0)
    assert s["profit_factor"] == pytest.approx(0.5)


def test_psr_monotonic_and_dsr_below_psr() -> None:
    srs = np.linspace(-0.1, 0.3, 9)
    psr = [probabilistic_sharpe(s, 500, 0.0, 3.0) for s in srs]
    assert all(np.diff(psr) > 0)
    assert probabilistic_sharpe(0.1, 2000, 0, 3) > probabilistic_sharpe(0.1, 200, 0, 3)
    rng = np.random.default_rng(1)
    r = pd.Series(rng.normal(0.001, 0.01, 1000))
    sr = r.mean() / r.std()
    base = probabilistic_sharpe(sr, len(r), float(r.skew()), float(r.kurt() + 3))
    trials = list(rng.normal(0, 0.05, 200))
    assert deflated_sharpe(r, trials) < base


def test_pbo_dominant_vs_noise() -> None:
    rng = np.random.default_rng(42)
    noise = pd.DataFrame(rng.normal(0, 0.01, (2000, 20)))
    dom = noise.copy()
    dom[0] = dom[0] + 0.005
    assert pbo_cscv(dom, S=16)["pbo"] < 0.05
    res = pbo_cscv(noise, S=16)
    assert 0.3 < res["pbo"] < 0.7
    assert len(res["logits"]) == 12870


def test_hac_bootstrap_spa() -> None:
    rng = np.random.default_rng(0)
    r = hourly(rng.normal(0.0005, 0.005, 24 * 400))
    assert np.isfinite(sharpe_hac_tstat(r))
    d = pd.Series(rng.normal(0.001, 0.01, 500))
    lo, hi = block_bootstrap_ci(d, lambda x: float(np.mean(x)), n=300, seed=1)
    assert lo < d.mean() < hi
    strat = pd.DataFrame(rng.normal(0, 0.01, (500, 3)))
    strat[0] += 0.01
    out = spa_test(strat, pd.Series(np.zeros(500)), reps=300)
    assert out["pvalue"] < 0.05
    assert out["pvalue_lower"] <= out["pvalue_consistent"] <= out["pvalue_upper"]


def test_walk_forward_non_overlapping_with_embargo() -> None:
    idx = pd.date_range("2020-01-01", "2023-12-31 23:00", freq="h", tz="UTC")
    splits = walk_forward_splits(idx, 12, 3, 168)
    assert len(splits) == 12
    prev_tests: list[np.ndarray] = []
    for tr, te in splits:
        assert tr.max() < te.min() - 168
        assert not set(tr) & set(te)
        for pt in prev_tests:
            assert not set(tr) & set(pt[-1] + np.arange(1, 169))
        prev_tests.append(te)
    tests = np.concatenate([te for _, te in splits])
    assert len(tests) == len(set(tests))
    assert idx[splits[0][1][0]] == pd.Timestamp("2021-01-01", tz="UTC")
    short = walk_forward_splits(idx, 12, 3, 168, end="2021-06-30 23:00")
    assert len(short) == 2 and idx[short[-1][1][-1]] == pd.Timestamp("2021-06-30 23:00", tz="UTC")


def test_holdout_lock(tmp_path) -> None:
    log = tmp_path / "holdout_log.jsonl"
    lock = HoldoutLock("2024-07-01", log_path=log)
    df = pd.DataFrame({"x": 1.0}, index=pd.date_range("2024-06-30", periods=48, freq="h", tz="UTC"))
    with pytest.raises(HoldoutViolation):
        lock.read(df)
    assert len(lock.dev_only(df)) == 24
    lock.read(lock.dev_only(df))
    lock.unlock("final evaluation")
    assert lock.read(df) is df
    lock.lock()
    lock.unlock("again")
    recs = [json.loads(x) for x in log.read_text().splitlines()]
    assert [r["reason"] for r in recs] == ["final evaluation", "again"]
    assert all("timestamp" in r for r in recs)
    with pytest.raises(ValueError):
        lock.unlock("")


def test_registry_appends(tmp_path) -> None:
    reg = ExperimentRegistry(tmp_path / "registry.jsonl")
    reg.log("trend", {"lb": 20}, {"sharpe": 1.0}, data_hash="abc")
    reg.log("trend", {"lb": 60}, {"sharpe": 0.5, "x": float("nan")})
    reg.log("carry", {"e": 0.1}, {"sharpe": 2.0})
    assert reg.all_trial_sharpes("trend") == [1.0, 0.5]
    recs = reg.records()
    assert len(recs) == 3
    assert {"id", "timestamp", "strategy", "params_hash", "params", "data_hash", "git_sha", "metrics"} <= set(
        recs[0]
    )
    assert recs[0]["params_hash"] != recs[1]["params_hash"]
