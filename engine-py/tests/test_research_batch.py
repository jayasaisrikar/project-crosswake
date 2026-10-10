from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.research import batch
from engine.research.contract import Prediction


class _Inner:
    model_id = "dummy"
    horizon_hours = 24

    def fit(self, data: object, end: pd.Timestamp) -> None:
        self.end = end

    def predict(self, data: object, t: pd.Timestamp) -> list[Prediction]:
        return [Prediction(t, a, "dummy", 24, 0.01, 1, math.nan, 0.0, 0.01) for a in ("A", "B")]


def test_pit_filter_drops_non_members() -> None:
    idx = pd.date_range("2021-01-01", periods=3, freq="h", tz="UTC")
    mask = pd.DataFrame({"A": [True, False, True], "B": [False, False, True]}, index=idx)
    m = batch.PITFiltered(_Inner(), mask)
    assert m.model_id == "dummy" and m.horizon_hours == 24
    assert [p.asset for p in m.predict(None, idx[0])] == ["A"]
    assert m.predict(None, idx[1]) == []
    assert [p.asset for p in m.predict(None, idx[2])] == ["A", "B"]
    assert m.predict(None, idx[2] + pd.Timedelta(hours=5)) == []


def test_bh_table_treats_nan_as_one() -> None:
    rej, q, holm = batch.bh_table([0.001, float("nan"), 0.04, 0.9])
    assert rej[0] and not rej[1]
    assert q[1] == pytest.approx(1.0)
    assert all(h >= p for h, p in zip(holm, [0.001, 1.0, 0.04, 0.9], strict=True))
    assert batch.bh_table([]) == ([], [], [])


def test_plan_spec_mapping_is_complete_and_disjoint() -> None:
    spec = batch.plan_spec()
    mapped = {e["hypothesis"] for e in spec["experiments"]}
    assert not mapped & set(batch.UNMAPPED)
    from engine.models.registry import REGISTRY
    for e in spec["experiments"]:
        assert e["model_id"] in REGISTRY
        assert e["n_variants"] >= batch.MIN_DISTINCT_VARIANTS
        if e["cross_sectional"]:
            assert e["universe"] == "pit_top_n"


def test_plan_rejects_xs_model_on_two_assets(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = [{"hypothesis": "H-0011", "model_id": "st_reversal", "universe": "majors",
            "params": {"lookback_hours": 4, "horizon_hours": 4},
            "param_grid": {"lookback_hours": [1, 4, 12, 24], "horizon_hours": [4, 8]}}]
    monkeypatch.setattr(batch, "PLAN", bad)
    with pytest.raises(ValueError, match="needs >= 3 assets"):
        batch.plan_spec()


def test_plan_rejects_too_few_variants(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = [{"hypothesis": "H-0001", "model_id": "tsmom", "universe": "majors", "params": {},
            "param_grid": {"horizon_hours": [24, 72]}}]
    monkeypatch.setattr(batch, "PLAN", bad)
    with pytest.raises(ValueError, match="variants"):
        batch.plan_spec()


def test_delay_one_bar_shifts_positions() -> None:
    idx = pd.date_range("2021-01-01", periods=6, freq="h", tz="UTC")
    sel = pd.DataFrame({"pred": 0.0, "pos": [1.0, 1.0, -1.0, 0.0, 1.0, 1.0],
                        "fwd": [0.01, 0.02, -0.01, 0.03, 0.0, 0.01], "gross": 0.0, "net": 0.0}, index=idx)
    folds = pd.DataFrame({"test_start": [idx[0]], "test_end": [idx[-1] + pd.Timedelta(hours=1)],
                          "cost_side_bps": [0.0]})
    d = batch.delay_one_bar(sel, folds)
    assert list(d["pos"]) == [0.0, 1.0, 1.0, -1.0, 0.0, 1.0]
    assert d["net"].iloc[1] == pytest.approx(0.02) and d["net"].iloc[3] == pytest.approx(-0.03)


def test_plan_written_once_and_checked(tmp_path: Path) -> None:
    p = tmp_path / "plan.yaml"
    batch.write_plan(p)
    with pytest.raises(FileExistsError):
        batch.write_plan(p)
    assert batch.check_plan(p)["spec_sha"]
    p.write_text(p.read_text(encoding="utf-8").replace("spec_sha: ", "spec_sha: x"), encoding="utf-8")
    with pytest.raises(RuntimeError):
        batch.check_plan(p)
    with pytest.raises(FileNotFoundError):
        batch.check_plan(tmp_path / "missing.yaml")


def test_subset_and_returns() -> None:
    from engine.contracts import Dataset, MarketData

    idx = pd.date_range("2021-01-01", periods=5, freq="h", tz="UTC")
    close = pd.DataFrame({"A": np.arange(1.0, 6.0), "B": 2.0}, index=idx)
    filled = pd.DataFrame(False, index=idx, columns=close.columns)
    filled.iloc[2, 0] = True
    md = MarketData(close, close, close, close, close, close, filled)
    ds = Dataset(md, md, pd.DataFrame(columns=["A", "B"], dtype=float))
    sub = batch.subset(ds, ["A"])
    assert list(sub.perp.close.columns) == ["A"]
    r = batch.perp_returns(sub)
    assert math.isnan(r["A"].iloc[2]) and r["A"].iloc[1] == pytest.approx(1.0)
