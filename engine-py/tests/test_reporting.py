from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.contracts import BacktestResult
from engine.reporting.csv_export import export_tables
from engine.reporting.html_report import build_report, monthly_table


def _fake(name: str, seed: int, drift: float) -> BacktestResult:
    idx = pd.date_range("2021-01-01", "2024-12-31 23:00", freq="h", tz="UTC")
    rng = np.random.default_rng(seed)
    r = pd.Series(rng.normal(drift, 0.004, len(idx)), index=idx)
    r.iloc[0] = 0.0
    eq = 10_000 * (1 + r).cumprod()
    pos = pd.DataFrame({"BTC": eq * 0.5, "ETH": -eq * 0.3}, index=idx)
    costs = pd.DataFrame({"fees": 0.05, "spread": 0.02, "impact": 0.01, "funding": -0.005}, index=idx)
    trades = pd.DataFrame({
        "ts": idx[::24], "symbol": "BTC", "market": "perp", "side": "buy",
        "qty_notional": 1000.0, "price": 40000.0, "fee": 0.4, "spread": 0.2, "impact": 0.1,
    })
    return BacktestResult(name, eq, r, {"perp": pos}, trades, costs, {"git_sha": "abc123"})


@pytest.fixture
def ctx() -> dict:
    res = {"Combined": _fake("Combined", 1, 3e-5), "Trend": _fake("Trend", 2, 2e-5),
           "BTC buy&hold": _fake("BTC", 3, 1e-5)}
    return {
        "title": "Test Report",
        "results": res,
        "oos_label": {"Combined": {"in_sample_end": "2023-06-30", "holdout_start": "2023-07-01"}},
        "stress": pd.DataFrame({"CAGR": [0.2, 0.15, 0.1], "Sharpe": [1.2, 1.0, 0.8]}, index=[1.0, 1.5, 2.0]),
        "walk_forward": pd.DataFrame({"train": ["2021-2022"], "test": ["2023"], "test_return": [0.1],
                                      "test_sharpe": [1.1]}),
        "stats": {"hac_t": 2.5, "psr": 0.97, "dsr": 0.93, "pbo": 0.2, "spa_p": 0.03, "n_trials": 40,
                  "bootstrap_ci": [0.4, 1.6]},
        "notes": ["Synthetic data used in test."],
    }


def test_monthly_table_correct(ctx: dict) -> None:
    r = ctx["results"]["Combined"].returns
    tbl = monthly_table(r)
    assert tbl.loc[2021, "Jan"] == pytest.approx(float((1 + r.loc["2021-01"]).prod() - 1))
    assert tbl.loc[2022, "Year"] == pytest.approx(float((1 + r.loc["2022"]).prod() - 1))
    assert list(tbl.index) == [2021, 2022, 2023, 2024]


def test_build_report(ctx: dict, tmp_path: Path) -> None:
    out = build_report(ctx, str(tmp_path / "r.html"))
    text = Path(out).read_text(encoding="utf-8")
    for s in ["Performance summary", "Equity curves", "Drawdowns", "Monthly returns", "Calendar-year returns",
              "Cost breakdown", "Cost stress test", "Walk-forward validation", "Statistical robustness",
              "Exposure &amp; turnover", "Methodology &amp; limitations", "In-sample vs out-of-sample",
              "93% probability the Sharpe is real after 40 trials", "Synthetic data used in test."]:
        assert s in text, s
    jan21 = monthly_table(ctx["results"]["Combined"].returns).loc[2021, "Jan"]
    assert f"{jan21 * 100:.1f}%" in text
    assert not re.search(r"<script[^>]*\bsrc\s*=", text, re.I)
    assert not re.search(r"<link[^>]*href\s*=\s*[\"']https?:", text, re.I)
    assert "Plotly" in text


def test_build_report_results_only(ctx: dict, tmp_path: Path) -> None:
    out = build_report({"results": ctx["results"]}, str(tmp_path / "r2.html"))
    text = Path(out).read_text(encoding="utf-8")
    assert "Monthly returns" in text and "Cost stress test" not in text


def test_csv_export(ctx: dict, tmp_path: Path) -> None:
    paths = export_tables(ctx, str(tmp_path / "csv"))
    names = {Path(p).name for p in paths}
    for n in ["monthly_combined.csv", "yearly_trend.csv", "trades_btc_buy_hold.csv", "summary.csv",
              "stress.csv", "walk_forward.csv"]:
        assert n in names
        assert (tmp_path / "csv" / n).exists()
    s = pd.read_csv(tmp_path / "csv" / "summary.csv", index_col=0)
    assert "CAGR" in s.columns and "cost_fees" in s.columns
