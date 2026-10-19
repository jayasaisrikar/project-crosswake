from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from engine.costs import CostModel
from engine.ensemble.calibration import (
    IsotonicCalibrator,
    PlattCalibrator,
    brier_score,
    calibrate_prediction,
    expected_calibration_error,
    pav,
    reliability_table,
    walk_forward_calibrate,
)
from engine.ensemble.combine import (
    combine_predictions,
    diversification_diagnostics,
    inverse_variance_weights,
    select_models,
    sign_dispersion,
)
from engine.ensemble.edge import MarketState, apply_edge, cost_breakdown
from engine.ensemble.no_trade import NoTradeConfig, NoTradeReason, TradeContext, evaluate, gate
from engine.ensemble.risk import RiskConfig, RiskInputs, portfolio_cvar, target_weights
from engine.research.contract import Prediction

T0 = pd.Timestamp("2024-01-01", tz="UTC")


def pred(er: float = 0.01, model: str = "m", conf: float = 0.6, **kw: object) -> Prediction:
    return Prediction(timestamp=T0, asset="BTC", model_id=model, horizon_hours=24, expected_return=er,
                      direction=1 if er > 0 else -1, confidence=conf, uncertainty=0.01, risk=0.03,
                      **kw)  # type: ignore[arg-type]


def cm() -> CostModel:
    return CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.7)


# ---------------- calibration ----------------
def _miscalibrated(n: int, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    true_p = rng.uniform(0.3, 0.7, n)
    score = 0.5 + 2.5 * (true_p - 0.5)  # overconfident raw score
    y = (rng.uniform(size=n) < true_p).astype(float)
    return score, y


def test_pav_monotone_and_mean_preserving() -> None:
    y = np.array([1, 0, 0, 1, 0, 1, 1, 1], float)
    f = pav(y)
    assert np.all(np.diff(f) >= -1e-12)
    assert f.mean() == pytest.approx(y.mean())


@pytest.mark.parametrize("cal_cls", [IsotonicCalibrator, PlattCalibrator])
def test_calibration_monotone_and_ece_improves(cal_cls: type) -> None:
    s_tr, y_tr = _miscalibrated(20_000, 1)
    s_te, y_te = _miscalibrated(20_000, 2)
    cal = cal_cls(min_samples=100).fit(s_tr, y_tr)
    grid = np.linspace(s_te.min(), s_te.max(), 200)
    assert np.all(np.diff(cal.predict(grid)) >= -1e-12)
    p = cal.predict(s_te)
    assert expected_calibration_error(p, y_te) < 0.5 * expected_calibration_error(np.clip(s_te, 0, 1), y_te)
    assert brier_score(p, y_te) < brier_score(np.clip(s_te, 0, 1), y_te)
    assert reliability_table(p, y_te)["count"].sum() == len(y_te)


def test_insufficient_samples_gives_nan() -> None:
    s, y = _miscalibrated(50)
    cal = IsotonicCalibrator(min_samples=100).fit(s, y)
    assert np.isnan(cal.predict(0.6)).all()
    assert math.isnan(calibrate_prediction(pred(), cal).confidence)
    wf = walk_forward_calibrate(pd.Series(s), pd.Series(y), min_samples=30)
    assert wf.iloc[:30].isna().all() and wf.iloc[30:].notna().all()


# ---------------- edge ----------------
def test_edge_subtracts_costs() -> None:
    ms = MarketState(cost_model=cm(), market="perp", notional=1e4, adv_quote=1e9, daily_vol=0.03,
                     funding_rate_per_8h=0.0001, slippage_bps=1.0, adverse_buffer=0.0005)
    bd = cost_breakdown(1, 24, ms, "BTC")
    assert bd.fees == pytest.approx(2 * 5e-4)
    assert bd.spread == pytest.approx(2 * 2e-4)
    assert bd.slippage == pytest.approx(2 * 1e-4)
    assert bd.impact == pytest.approx(2 * 0.7 * 0.03 * math.sqrt(1e4 / 1e9))
    assert bd.funding == pytest.approx(3 * 0.0001)
    out = apply_edge(pred(0.02), ms)
    assert out.expected_cost == pytest.approx(bd.total)
    assert out.expected_net_edge == pytest.approx(0.02 - bd.total)
    assert out.direction == 1
    # short receives positive funding -> conservatively not credited
    assert cost_breakdown(-1, 24, ms, "BTC").funding == 0.0


def test_edge_no_trade_when_cost_exceeds_er() -> None:
    ms = MarketState(cost_model=cm(), market="spot", adv_quote=1e9, daily_vol=0.03)
    out = apply_edge(pred(0.001), ms)  # round-trip spot fees alone are 0.2%
    assert out.direction == 0 and out.expected_net_edge < 0
    assert out.reason.startswith("insufficient_edge")


# ---------------- combiner ----------------
def _model_returns(n: int = 2000) -> pd.DataFrame:
    rng = np.random.default_rng(3)
    a = 0.001 + rng.normal(0, 0.01, n)
    b = 0.001 + rng.normal(0, 0.01, n)
    return pd.DataFrame({"a": a, "a_dup": a + rng.normal(0, 1e-4, n), "b": b})


def test_combiner_rejects_duplicate_model() -> None:
    r = _model_returns()
    res = select_models(r, corr_cap=0.8)
    assert "b" in res.admitted
    assert ("a" in res.admitted) != ("a_dup" in res.admitted)
    dup = "a_dup" if "a" in res.admitted else "a"
    assert "correlation" in res.rejected[dup]
    # even with no corr cap the marginal test rejects it
    res2 = select_models(r, corr_cap=1.01, min_t=2.0)
    assert dup in res2.rejected or ("a" in res2.rejected or "a_dup" in res2.rejected)


def test_diagnostics_and_weights() -> None:
    r = _model_returns()
    d = diversification_diagnostics(r, r, regimes=pd.Series(np.arange(len(r)) % 2, index=r.index))
    assert d.return_corr.loc["a", "a_dup"] > 0.99
    assert d.regime_overlap is not None
    err = pd.DataFrame({"x": np.random.default_rng(0).normal(0, 1, 500),
                        "y": np.random.default_rng(1).normal(0, 2, 500)})
    w = inverse_variance_weights(err, shrinkage=0.0)
    assert w.sum() == pytest.approx(1.0) and w["x"] > w["y"]
    assert inverse_variance_weights(err, shrinkage=1.0)["x"] == pytest.approx(0.5)


def test_disagreement_no_trade() -> None:
    ps = [pred(0.01, "a"), pred(-0.01, "b")]
    assert sign_dispersion(ps) == pytest.approx(1.0)
    out = combine_predictions(ps, {"a": 1.0, "b": 1.0})
    assert out.direction == 0 and "disagreement" in out.reason
    agree = combine_predictions([pred(0.01, "a"), pred(0.02, "b")], {"a": 1.0, "b": 1.0})
    assert agree.direction == 1 and agree.expected_return == pytest.approx(0.015)
    assert agree.model_sources == ("a", "b")


# ---------------- no trade ----------------
def test_no_trade_reasons() -> None:
    ok = pred(0.02, expected_net_edge=0.01)
    ctx = TradeContext(now=T0, last_data_time=T0, half_spread_bps=1.0, adv_quote=1e9)
    assert evaluate(ok, ctx).trade
    bad = TradeContext(now=T0 + pd.Timedelta(hours=5), last_data_time=T0, half_spread_bps=50, adv_quote=10,
                       regime_prob=0.3, model_health=0.1, corr_to_book=0.95, risk_halt=True)
    p2, dec = gate(pred(0.02, conf=float("nan"), expected_net_edge=-0.01,
                        features={"sign_dispersion": 0.9}), bad, NoTradeConfig())
    assert not dec.trade and p2.direction == 0
    assert set(dec.reasons) == set(NoTradeReason)


# ---------------- risk ----------------
def test_risk_caps_respected() -> None:
    assets = ["BTC", "ETH", "SOL", "DOGE"]
    rng = np.random.default_rng(5)
    base = rng.normal(0, 0.03, (1000, 1))
    scen = pd.DataFrame(base + rng.normal(0, 0.01, (1000, 4)), columns=assets)
    inp = RiskInputs(alpha=pd.Series([1.0, 1.0, 1.0, -0.2], index=assets), vol=scen.std(), cov=scen.cov(),
                     equity=1e6, adv_quote=pd.Series([1e10, 1e10, 1e10, 1e6], index=assets),
                     scenarios=scen, drawdown=0.15,
                     sector={"BTC": "L1", "ETH": "L1", "SOL": "L1", "DOGE": "meme"},
                     exchange={a: "binance" for a in assets})
    cfg = RiskConfig(target_vol_annual=2.0, max_asset_weight=0.3, max_gross_leverage=0.8,
                     max_net_leverage=0.5,
                     max_adv_fraction=0.01, cluster_corr=0.7, max_cluster_gross=0.6, max_cvar=0.02,
                     max_sector_gross={"L1": 0.5}, max_exchange_gross={"binance": 0.7})
    res = target_weights(inp, cfg)
    w = res.weights
    assert (w.abs() <= 0.3 + 1e-9).all()
    assert w.abs().sum() <= 0.8 + 1e-9 and abs(w.sum()) <= 0.5 + 1e-9
    assert abs(w["DOGE"]) * 1e6 <= 0.01 * 1e6 + 1e-6
    assert w[["BTC", "ETH", "SOL"]].abs().sum() <= 0.5 + 1e-9
    assert portfolio_cvar(w, scen, 0.95) <= 0.02 + 1e-9
    assert any(b.startswith("drawdown_throttle") for b in res.binding)
    assert res.binding
    halted = target_weights(RiskInputs(alpha=inp.alpha, vol=inp.vol, halt=True), cfg)
    assert halted.weights.abs().sum() == 0
    deep = target_weights(RiskInputs(alpha=inp.alpha, vol=inp.vol, drawdown=0.5), cfg)
    assert deep.weights.abs().sum() == 0
