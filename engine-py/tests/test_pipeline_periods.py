"""Period-labelled evaluation: slicing, locked dev-only output, allocation arithmetic (synthetic data)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.contracts import BacktestResult
from engine.pipeline import (
    ALLOCATIONS,
    BENCH,
    PRIMARY,
    build_allocations,
    cost_row,
    evaluate_periods,
    make_periods,
    slice_result,
)
from engine.reporting.csv_export import export_period_tables
from engine.reporting.html_report import build_report
from engine.validation import metrics

DEV_END, HOLDOUT_START = "2022-06-30", "2022-07-01"
TRADE_COLS = ["ts", "symbol", "market", "side", "qty_notional", "price", "fee", "spread", "impact"]


def _fake(name: str, idx: pd.DatetimeIndex, seed: int, cap: float = 100_000.0, drift: float = 2e-5,
          ) -> BacktestResult:
    rng = np.random.default_rng(seed)
    r = pd.Series(rng.normal(drift, 0.003, len(idx)), index=idx)
    eq = cap * (1 + r).cumprod()
    pos = pd.DataFrame({"BTC": eq * 0.5}, index=idx)
    costs = pd.DataFrame({"fees": 0.5, "spread": 0.2, "impact": 0.1, "funding": 0.05}, index=idx)
    trades = pd.DataFrame({"ts": idx[::24], "symbol": "BTC", "market": "perp", "side": "buy",
                           "qty_notional": 1000.0, "price": 40000.0, "fee": 0.4, "spread": 0.2,
                           "impact": 0.1})
    return BacktestResult(name, eq.rename("equity"), r.rename("returns"), {"perp": pos}, trades, costs,
                          {"initial_capital": cap})


def _index(end: str) -> pd.DatetimeIndex:
    return pd.date_range("2021-01-01", end, freq="h", tz="UTC")


def test_slice_uses_only_in_period_returns_and_rebases() -> None:
    idx = _index("2022-12-31 23:00")
    res = _fake("x", idx, 1)
    s, e = pd.Timestamp("2022-07-01", tz="UTC"), pd.Timestamp("2022-12-31 23:00", tz="UTC")
    sl = slice_result(res, s, e)
    inside = res.returns.loc[s:e]
    assert sl.equity.index[0] == s and sl.equity.index[-1] == e
    pd.testing.assert_series_equal(sl.returns, inside, check_names=False)
    # rebased: equity starts from initial capital, grows only with in-period returns
    assert sl.equity.iloc[0] == pytest.approx(100_000.0 * (1 + inside.iloc[0]))
    assert sl.equity.iloc[-1] / 100_000.0 - 1 == pytest.approx(float((1 + inside).prod() - 1))
    # identical to the original equity scaled by cap / equity-before-start
    k = 100_000.0 / res.equity.loc[: s - pd.Timedelta(hours=1)].iloc[-1]
    np.testing.assert_allclose(sl.equity.to_numpy(), res.equity.loc[s:e].to_numpy() * k, rtol=1e-10)
    # metrics differ from the full-period metrics (i.e. not computed on the whole run)
    full_tot = metrics.performance_summary(res.returns)["total_return"]
    assert metrics.performance_summary(sl.returns)["total_return"] != pytest.approx(full_tot)
    # costs and trades scaled and restricted to the window
    in_window = (res.trades.ts >= s) & (res.trades.ts <= e)
    assert sl.costs.index.min() >= s and len(sl.trades) == int(in_window.sum())
    assert sl.costs["fees"].iloc[0] == pytest.approx(0.5 * k)
    row = cost_row(sl)
    assert row["Gross P&L"] == pytest.approx(row["Net P&L"] + row["Total costs"])
    assert row["Funding (+paid / -received)"] == pytest.approx(0.05 * k * len(sl.costs))


def test_make_periods_locked_vs_unlocked() -> None:
    idx = _index("2022-12-31 23:00")
    locked = make_periods(idx, DEV_END, HOLDOUT_START, unlocked=False)
    assert [p.key for p in locked] == ["dev"]
    assert locked[0].end == pd.Timestamp("2022-06-30 23:00", tz="UTC")
    unlocked = make_periods(idx, DEV_END, HOLDOUT_START, unlocked=True)
    assert [p.key for p in unlocked] == ["dev", "holdout", "full"]
    assert unlocked[1].start == pd.Timestamp(HOLDOUT_START, tz="UTC")
    assert unlocked[2].start == idx[0] and unlocked[2].end == idx[-1]


def _results(idx: pd.DatetimeIndex) -> dict[str, BacktestResult]:
    return {PRIMARY: _fake(PRIMARY, idx, 1), "Trend": _fake("trend", idx, 2, 50_000.0),
            "Carry": _fake("carry", idx, 3, 50_000.0), BENCH: _fake("btc", idx, 4)}


def test_locked_dev_report_contains_no_holdout_dates(tmp_path: Path) -> None:
    idx = _index("2022-06-30 23:00")  # what the locked pipeline sees (data truncated at dev_end)
    results = _results(idx)
    trials = {f"trend_{i}": _fake(f"t{i}", idx, 10 + i) for i in range(4)}
    allocs = {"Trend 100%": _fake("a", idx, 20), BENCH: results[BENCH]}
    periods = make_periods(idx, DEV_END, HOLDOUT_START, unlocked=False)
    pctx, sj = evaluate_periods(periods, results, trials, allocs, {1.0: results})
    assert list(sj) == ["dev"]
    assert "pbo_trend" in sj["dev"] and "dsr_trend" in sj["dev"]
    ctx = {"title": "T", "results": results, "periods": pctx, "holdout_views": 3,
           "holdout_log": pd.DataFrame({"timestamp": ["x"], "reason": ["r"], "holdout_start": ["h"]}),
           "walk_forward": pd.DataFrame({"train": ["a"], "test": ["2021-01-01 → 2021-03-31"],
                                         "test_return": [0.01]})}
    text = Path(build_report(ctx, str(tmp_path / "report.html"))).read_text(encoding="utf-8")
    assert "Hypothetical backtest. Holdout viewed 3 times" in text
    assert "DEVELOPMENT: 2021-01-01 → 2022-06-30" in text
    assert "HOLDOUT ONLY" not in text and "2022-07" not in text
    export_period_tables(ctx, str(tmp_path / "tables"))
    assert sorted(p.name for p in (tmp_path / "tables").iterdir() if p.is_dir()) == ["dev"]
    for f in (tmp_path / "tables" / "dev").glob("*.csv"):
        assert "2022-07" not in f.read_text(encoding="utf-8"), f.name


def test_unlocked_report_has_separate_labelled_periods(tmp_path: Path) -> None:
    idx = _index("2022-12-31 23:00")
    results = _results(idx)
    trials = {f"trend_{i}": _fake(f"t{i}", idx, 10 + i) for i in range(4)}
    periods = make_periods(idx, DEV_END, HOLDOUT_START, unlocked=True)
    pctx, sj = evaluate_periods(periods, results, trials, {BENCH: results[BENCH]}, {1.0: results})
    assert set(sj) == {"dev", "holdout", "full"}
    ho = next(p for p in pctx if p["key"] == "holdout")
    exp_cagr = metrics.performance_summary(results[PRIMARY].returns.loc[HOLDOUT_START:])["cagr"]
    assert ho["summary"].loc[PRIMARY, "cagr"] == pytest.approx(exp_cagr)
    text = Path(build_report({"results": results, "periods": pctx, "holdout_views": 1},
                             str(tmp_path / "r.html"))).read_text(encoding="utf-8")
    for h in ("DEVELOPMENT: 2021-01-01 → 2022-06-30", "HOLDOUT ONLY: 2022-07-01 → 2022-12-31",
              "FULL PERIOD (descriptive only): 2021-01-01 → 2022-12-31"):
        assert h in text


def test_allocation_rows_sum_correctly() -> None:
    idx = _index("2021-03-31 23:00")
    rng = np.random.default_rng(5)
    base = {"trend": pd.Series(rng.normal(1e-4, 0.004, len(idx)), index=idx),
            "carry": pd.Series(rng.normal(2e-5, 0.001, len(idx)), index=idx)}
    calls: list[tuple[str, float]] = []

    def run_sleeve(name: str, capital: float) -> BacktestResult:
        calls.append((name, capital))
        r = base[name]
        return BacktestResult(
            name, (capital * (1 + r).cumprod()).rename("equity"), r, {}, pd.DataFrame(columns=TRADE_COLS),
            pd.DataFrame(0.0, index=idx, columns=["fees", "spread", "impact", "funding"]),
            {"initial_capital": capital})

    cap = 100_000.0
    out = build_allocations(run_sleeve, cap)
    assert list(out) == [label for label, _ in ALLOCATIONS]
    # every sleeve was run at its exact capital (no linear rescale), each distinct size once
    assert sorted(calls) == sorted({("trend", 100_000.0), ("trend", 75_000.0), ("trend", 50_000.0),
                                    ("carry", 25_000.0), ("carry", 50_000.0), ("carry", 100_000.0)})
    g = {k: (1 + v).cumprod() for k, v in base.items()}
    for label, alloc in ALLOCATIONS:
        expect = sum(cap * w * g.get(k, 1.0) for k, w in alloc.items())
        np.testing.assert_allclose(out[label].equity.to_numpy(), np.asarray(expect, dtype=float), rtol=1e-12)
        assert out[label].returns.iloc[0] == pytest.approx(float(expect.iloc[0] / cap - 1))
    with pytest.raises(ValueError):
        build_allocations(run_sleeve, cap, [("bad", {"trend": 0.6})])
