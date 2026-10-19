from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.monitor import dashboard, drift, health, leaderboard
from engine.monitor.ledger import Ledger, joined, resolve
from engine.monitor.metrics import by_group, calibration, summarize
from engine.research.contract import Prediction

T0 = pd.Timestamp("2026-01-01 00:00", tz="UTC")
RULES = health.load_rules(Path(__file__).resolve().parents[1] / "config/health_rules.yaml")


def _pred(i: int, direction: int = 1, conf: float = 0.6, model: str = "m1", asset: str = "BTC") -> Prediction:
    return Prediction(timestamp=T0 + pd.Timedelta(hours=i), asset=asset, model_id=model, horizon_hours=4,
                      expected_return=0.01 * direction, direction=direction, confidence=conf,
                      uncertainty=0.02, risk=0.02, expected_cost=0.001, regime="trend")


def _prices(n: int = 100, step: float = 0.001) -> pd.Series:
    idx = pd.date_range(T0, periods=n, freq="h")
    return pd.Series(100 * (1 + step) ** np.arange(n), index=idx)


def test_ledger_append_only_and_dedup(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    assert len(led.append([_pred(0), _pred(1)], {"BTC": 100.0}, now=T0)) == 2
    before = led.predictions_path.read_text()
    assert led.append([_pred(0), _pred(2)], {"BTC": 100.0}, now=T0) == [led.predictions()[-1]["signal_id"]]
    after = led.predictions_path.read_text()
    assert after.startswith(before) and len(led.predictions()) == 3
    resolve(led, {"BTC": _prices()}, T0 + pd.Timedelta(hours=50))
    assert led.predictions_path.read_text() == after  # resolution never edits predictions


def test_resolve_correctness(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    px = _prices()
    led.append([_pred(0, 1), _pred(1, -1), _pred(10, 0)], {"BTC": float(px.iloc[0])}, now=T0)
    # before expiry: nothing
    assert resolve(led, {"BTC": px}, T0 + pd.Timedelta(hours=3)) == []
    rows = resolve(led, {"BTC": px}, T0 + pd.Timedelta(hours=5))
    assert len(rows) == 2  # only first two have expired (t=4h, t=5h)
    r0 = rows[0]
    exp_ret = px.iloc[4] / px.iloc[0] - 1
    assert r0["realized_return"] == pytest.approx(exp_ret)
    assert r0["hit"] is True and r0["error"] == pytest.approx(exp_ret - 0.01)
    assert r0["net_return"] == pytest.approx(exp_ret - 0.001)
    assert rows[1]["hit"] is False and rows[1]["signed_return"] < 0
    # idempotent: second call resolves nothing new
    assert resolve(led, {"BTC": px}, T0 + pd.Timedelta(hours=6)) == []
    df = joined(led)
    assert df["realized_return"].notna().sum() == 2


def test_metrics_and_calibration(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    px = _prices(200)
    led.append([_pred(i, 1 if i % 3 else -1, conf=0.7) for i in range(100)], {"BTC": math.nan}, now=T0)
    resolve(led, {"BTC": px}, T0 + pd.Timedelta(hours=300))
    df = joined(led)
    s = summarize(df)
    assert s["n"] == 100 and 0.6 < s["hit_rate"] < 0.7
    tab, ece = calibration(df)
    assert not tab.empty and 0 <= ece < 0.1
    g = by_group(df, ["model_id", "regime", "conf_bucket"])
    assert list(g["conf_bucket"]) == ["0.70-1.00"]


def test_health_transitions() -> None:
    assert health.transition("ACTIVE", 20, RULES) == "QUARANTINED"  # downgrades can jump
    assert health.transition("QUARANTINED", 90, RULES) == "REDUCED"  # upgrades one step
    assert health.transition("REDUCED", 32, RULES) == "REDUCED"  # hysteresis: WARNING needs 45+5
    assert health.transition("REDUCED", 50, RULES) == "WARNING"
    assert health.transition("QUARANTINED", 10, RULES, quarantine_streak=2) == "RESEARCH"
    assert health.transition("RESEARCH", 99, RULES) == "RESEARCH"  # sticky


def test_healthbook_never_deletes(tmp_path: Path) -> None:
    led = Ledger(tmp_path)
    px = _prices(200, step=0.002)
    led.append([_pred(i, -1, conf=0.9, model="bad") for i in range(60)], {"BTC": math.nan}, now=T0)
    resolve(led, {"BTC": px}, T0 + pd.Timedelta(hours=300))
    hb = health.HealthBook(tmp_path, RULES)
    for k in range(4):
        st = hb.evaluate(joined(led), T0 + pd.Timedelta(days=k), models=["idle"])
    assert st["bad"]["state"] == "RESEARCH" and st["bad"]["size_multiplier"] == 0.0
    assert "idle" in st
    hb.reinstate("bad", T0, "manual review")
    assert hb.states()["bad"]["state"] == "REDUCED" and len(hb.history()) >= 4


def test_drift_detects_synthetic_shift(tmp_path: Path) -> None:
    rng = np.random.default_rng(0)
    ref = pd.DataFrame({"f": rng.normal(0, 1, 2000), "g": rng.normal(0, 1, 2000)})
    same = pd.DataFrame({"f": rng.normal(0, 1, 500), "g": rng.normal(0, 1, 500)})
    shifted = pd.DataFrame({"f": rng.normal(1.5, 1, 500), "g": rng.normal(0, 1, 500)})
    assert drift.feature_drift(ref, same, T0) == []
    ev = drift.feature_drift(ref, shifted, T0)
    assert [e.name for e in ev] == ["f"] and ev[0].statistic == "psi"
    # Page-Hinkley on an error stream with a mean shift
    err = np.r_[rng.normal(0, 0.01, 300), rng.normal(0.03, 0.01, 100)]
    idx = drift.page_hinkley(err, delta=0.005, lam=0.5)
    assert idx is not None and idx >= 300
    assert drift.page_hinkley(rng.normal(0, 0.01, 400), delta=0.005, lam=0.5) is None
    # market structure
    b = rng.normal(0, 0.01, 1000)
    mref = pd.DataFrame({"btc_ret": b, "alt_ret": b + rng.normal(0, 0.003, 1000), "ret": b,
                         "volume": 1e6 + rng.normal(0, 1e4, 1000), 
                         "funding": 1e-4 + rng.normal(0, 1e-5, 1000)})
    mcur = pd.DataFrame({"btc_ret": b[:300], "alt_ret": rng.normal(0, 0.01, 300), "ret": b[:300] * 3,
                         "volume": 3e5 + rng.normal(0, 1e4, 300), 
                         "funding": -3e-4 + rng.normal(0, 1e-5, 300)})
    names = {e.name for e in drift.market_structure(mref, mcur, T0)}
    assert {"btc_alt_corr", "volatility", "liquidity", "funding_level", "funding_sign"} <= names
    p = tmp_path / "research/triggers.jsonl"
    rows = drift.write_triggers(ev, p)
    assert rows[0]["type"] == "new_hypothesis_request"
    assert drift.write_triggers(ev, p) == []  # deduped


def test_leaderboard_and_dashboard(tmp_path: Path) -> None:
    reg = tmp_path / "exp_registry.jsonl"
    reg.write_text('{"exp_id":"e1","model_id":"m1","hypothesis_id":"h1","results":{"oos_sharpe":1.2,'
                   '"max_dd":-0.1},"decision":"accept"}\n{"exp_id":"e2","model_id":"m2"}\nnot json\n'
                   '{"exp_id":"e3","model_id":"m3","results":{"oos_sharpe":-0.5,"max_dd":-0.5},'
                   '"decision":"reject"}\n')
    led = Ledger(tmp_path)
    px = _prices(200)
    led.append([_pred(i, 1, model="m1") for i in range(40)], {"BTC": math.nan}, now=T0)
    resolve(led, {"BTC": px}, T0 + pd.Timedelta(hours=300))
    df = joined(led)
    lb = leaderboard.build(leaderboard.load_registry(reg), df, {})
    assert list(lb["model_id"])[0] == "m1" and list(lb["model_id"])[-1] == "m3"
    md, csv = leaderboard.write(lb, tmp_path / "reports")
    assert md.exists() and csv.exists() and "MODEL_LEADERBOARD" in md.read_text()
    assert leaderboard.build(leaderboard.load_registry(tmp_path / "missing.jsonl"), pd.DataFrame(), {}).empty
    out = dashboard.render(tmp_path / "reports/research_dashboard.html", now=T0, ledger_df=df, leaderboard=lb,
                           drift_events=[], triggers=[], registry={}, equity=[], initial_capital=1e5)
    html = out.read_text(encoding="utf-8")
    for s in ("MARKET", "SIGNALS", "MODELS", "PAPER TRADING", "RESEARCH", "prefers-color-scheme"):
        assert s in html
    assert "http://" not in html and "https://" not in html
