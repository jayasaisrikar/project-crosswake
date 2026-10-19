"""Review 01 fixes in engine.models / runner: drift-free direction (#1), xs demeaning + PIT ranks (#1, #9),
>= 3 assets for xs (#5), vectorised stale mask + predict_many == predict (#6), funding + open fills (#7, #12),
and leakage checks that actually catch a leaky model (#10)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset
from engine.costs import CostModel
from engine.models import DataUnavailable, build_model
from engine.models.base import ScoreModel, forward_return, stale_run_length_fast
from engine.research.hypothesis import Hypothesis
from engine.research.runner import (
    ResearchDataset,
    RunConfig,
    benchmark_returns,
    causality_check,
    net_returns,
    perturb_after,
    run_experiment,
)
from engine.signals.trend import stale_run_length
from test_models import END, FAST, T_PRED, make_dataset

COSTS = CostModel(fee_bps={"spot": 10.0, "perp": 5.0}, half_spread_bps={"default": 2.0}, impact_y=0.7)


def _fitted(mid: str, ds: Dataset, **kw: Any) -> ScoreModel:
    m = build_model(mid, **{**FAST.get(mid, {}), **kw})
    assert isinstance(m, ScoreModel)
    m.fit(ds, end=END)
    return m


def test_stale_run_length_fast_matches_reference() -> None:
    rng = np.random.default_rng(0)
    f = pd.DataFrame(rng.random((500, 7)) < 0.3).astype(object)
    f.iloc[10:60, 2] = True
    f.iloc[3, 4] = None
    assert (stale_run_length_fast(f).to_numpy() == stale_run_length(f).to_numpy()).all()


@pytest.mark.parametrize("mid", ["tsmom", "donchian", "xs_mom", "zscore_reversal", "ridge", "logit_sign",
                                 "ar"])
def test_predict_many_equals_pointwise(mid: str) -> None:
    ds = make_dataset()
    m = _fitted(mid, ds)
    many = m.predict_many(ds.truncate(T_PRED[-1]), T_PRED)
    point = [p for t in T_PRED for p in m.predict(ds.truncate(t), t)]
    key = lambda ps: sorted((p.timestamp, p.asset, p.direction, round(p.expected_return, 10)) for p in ps)  # noqa: E731
    assert key(many) == key(point) and len(many) > 0


def test_direction_ignores_training_drift() -> None:
    """A strong positive drift a with b*s mixed in sign must not make every position long."""
    ds = make_dataset()
    m = _fitted("tsmom", ds)
    m.coef_ = (0.05, 0.001)                  # drift dominates: sign(a + b*s) would be always +1
    ps = m.predict(ds.truncate(T_PRED[0]), T_PRED[0])
    signs = {p.direction for p in ps}
    assert all(p.expected_return == pytest.approx(0.001 * p.features["score"]) for p in ps)
    assert all(p.features["er_with_drift"] > 0 for p in ps)
    assert -1 in signs or len({np.sign(p.features["score"]) for p in ps}) == 1


def test_xs_book_is_demeaned_and_needs_three_assets() -> None:
    ds = make_dataset()
    m = _fitted("xs_mom", ds)
    m.coef_ = (0.05, 0.01)
    ps = m.predict(ds.truncate(T_PRED[0]), T_PRED[0])
    assert len(ps) >= 3
    assert sum(p.expected_return for p in ps) == pytest.approx(0.0, abs=1e-12)
    assert {p.direction for p in ps} == {-1, 1}
    two = Dataset(*[type(ds.spot)(**{k: getattr(md, k)[["BTC", "ETH"]] for k in md.__dataclass_fields__})
                    for md in (ds.spot, ds.perp)], ds.funding.reindex(columns=["BTC", "ETH"]))
    with pytest.raises(DataUnavailable, match=">= 3 assets"):
        build_model("st_reversal", **FAST["st_reversal"]).fit(two, end=END)


def test_xs_rank_uses_pit_members_only() -> None:
    ds = make_dataset()
    m = build_model("xs_mom", **FAST["xs_mom"])
    assert isinstance(m, ScoreModel)
    base = m.score_panel(ds)
    mask = pd.DataFrame(True, index=ds.perp.close.index, columns=ds.perp.close.columns)
    mask["XRP"] = False                       # XRP not in the universe: must not shift others' ranks
    m.pit_mask = mask
    pit = m.score_panel(ds)
    t = T_PRED[0]
    assert math.isnan(pit.loc[t, "XRP"])
    assert not np.allclose(base.loc[t, ["BTC", "ETH", "SOL"]], pit.loc[t, ["BTC", "ETH", "SOL"]])
    assert pit.loc[t, ["BTC", "ETH", "SOL"]].sum() == pytest.approx(0.0)


def test_net_returns_funding_and_open_fill() -> None:
    idx = pd.date_range("2021-01-01", periods=4, freq="h", tz="UTC")
    w = pd.DataFrame({"A": [1.0, 1.0, 0.0, 0.0]}, index=idx)
    r = pd.DataFrame({"A": [0.0, 0.01, 0.02, 0.03]}, index=idx)
    zero = pd.Series({"A": 0.0})
    base = net_returns(w, r, zero)
    f = pd.DataFrame({"A": [0.0, 0.001, 0.0, 0.0]}, index=idx)
    assert net_returns(w, r, zero, funding=f).iloc[1] == pytest.approx(base.iloc[1] - 0.001)  # long pays
    oc = pd.DataFrame({"A": [0.0, 0.004, 0.02, 0.03]}, index=idx)
    nf = net_returns(w, r, zero, open_returns=oc)
    # bar 1: old position (0) earns the gap, new position (1) earns open->close only
    assert nf.iloc[1] == pytest.approx(0.004)
    assert nf.iloc[2] == pytest.approx(0.02)                                     # held all bar
    assert nf.iloc[3] == pytest.approx(1.03 / 1.03 - 1.0)                      # flat at open of 3: gap only
    ds = ResearchDataset(None, r, funding=f)
    assert benchmark_returns(ds).iloc[1] == pytest.approx(0.01 - 0.001)


# ------------------------------------------------------------------ leakage checks that can fail


class LeakyScore(ScoreModel):
    """Score = the realised forward return (future data inside score_panel)."""

    model_id = "leaky_score"
    default_params = {"vol_hours": 72, "horizon_hours": 24}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        return forward_return(data.perp.close, 1).fillna(0.0)


class LeakyFit(ScoreModel):
    """Causal score, but fit() ignores `end` and calibrates on the full sample."""

    model_id = "leaky_fit"
    default_params = {"vol_hours": 72, "horizon_hours": 24}

    def score_panel(self, data: Dataset) -> pd.DataFrame:
        return np.log(data.perp.close).diff(24)

    def fit(self, data: object, end: pd.Timestamp) -> None:
        assert isinstance(data, Dataset)
        last = pd.Timestamp(data.perp.close.index[-1])
        super().fit(data, end=last)


def _rds() -> ResearchDataset:
    ds = make_dataset()
    rets = ds.perp.close.pct_change(fill_method=None)
    return ResearchDataset(ds, rets, "synthetic")


def test_clean_model_passes_all_leakage_checks() -> None:
    rds = _rds()
    times = [pd.Timestamp("2022-02-25 00:00", tz="UTC"), pd.Timestamp("2022-03-01 00:00", tz="UTC")]
    res = causality_check(lambda p: build_model("tsmom", **FAST["tsmom"]), {}, rds, times, END)
    assert all(res.values()), res


def test_leaky_score_is_caught(tmp_path: Any) -> None:
    """predict() slices to [t - warmup, t] so it is accidentally causal, but the batched predict_many path
    used for PnL sees the future: the pointwise-vs-batch check must catch it and REJECT."""
    from engine.research.registry import ResearchRegistry

    res = run_experiment(Hypothesis(id="H-S", family="leak"), lambda p: LeakyScore(), _rds(), COSTS,
                         config=RunConfig(n_splits=2, embargo=pd.Timedelta(hours=24), bootstrap_n=20,
                                          causality_checks=4),
                         registry=ResearchRegistry(tmp_path / "r.jsonl"))
    assert res.results["leakage_checks"]["pointwise"] is False
    assert res.results["leakage_pass"] is False and res.decision.decision == "REJECT"


def test_leaky_fit_is_caught() -> None:
    rds = _rds()
    times = [pd.Timestamp("2022-02-25 00:00", tz="UTC"), pd.Timestamp("2022-03-01 00:00", tz="UTC")]
    res = causality_check(lambda p: LeakyFit(), {}, rds, times, END)
    assert res["fit"] is False, res


def test_runner_rejects_leaky_fit_model(tmp_path: Any) -> None:
    from engine.research.registry import ResearchRegistry

    rds = _rds()
    res = run_experiment(Hypothesis(id="H-L", family="leak"), lambda p: LeakyFit(), rds, COSTS,
                         config=RunConfig(n_splits=2, embargo=pd.Timedelta(hours=24), bootstrap_n=20),
                         registry=ResearchRegistry(tmp_path / "r.jsonl"))
    assert res.results["leakage_pass"] is False
    assert res.results["leakage_checks"]["fit"] is False
    assert res.decision.decision == "REJECT"


def test_perturb_after_keeps_past() -> None:
    ds = make_dataset()
    t = END
    p = perturb_after(ds, t)
    assert p.perp.close.loc[:t].equals(ds.perp.close.loc[:t])
    assert not np.allclose(p.perp.close.loc[t + pd.Timedelta(hours=1):].to_numpy(),
                           ds.perp.close.loc[t + pd.Timedelta(hours=1):].to_numpy())
