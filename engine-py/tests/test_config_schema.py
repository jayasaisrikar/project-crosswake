"""Config schema validation (review 04 finding 6) + swallowed-error fixes (finding 5)."""

from __future__ import annotations

import copy
import logging
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml

from engine.config_schema import SCHEMAS, ConfigError, validate
from engine.pipeline import ROOT, load_config


def _raw(name: str) -> dict:
    return yaml.safe_load((ROOT / "config" / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_every_shipped_config_validates(name: str) -> None:
    assert (ROOT / "config" / name).exists()
    assert load_config(name) == _raw(name)


def test_unknown_key_fails_loudly() -> None:
    cfg = _raw("live.yaml")
    cfg["ensemble"]["enable"] = True        # typo of `enabled`
    with pytest.raises(ConfigError, match=r"ensemble\.enable: unknown key"):
        validate("live.yaml", cfg)


def test_unknown_top_level_and_strategy_keys() -> None:
    cfg = _raw("experiment.yaml")
    bad = copy.deepcopy(cfg)
    bad["stratgies"] = {}
    with pytest.raises(ConfigError, match="stratgies"):
        validate("experiment.yaml", bad)
    bad = copy.deepcopy(cfg)
    bad["strategies"]["trend"]["lookback_days"] = [20]
    with pytest.raises(ConfigError, match=r"strategies\.trend\.lookback_days"):
        validate("experiment.yaml", bad)
    bad = copy.deepcopy(cfg)
    bad["strategies"]["mystery"] = {"enabled": True}
    with pytest.raises(ConfigError, match=r"strategies\.mystery"):
        validate("experiment.yaml", bad)


@pytest.mark.parametrize(("key", "value"), [
    ("max_drawdown", 1.5), ("max_drawdown", -0.1), ("daily_loss_limit", 2.0),
    ("max_gross_leverage", 50.0), ("max_exchange_errors", -1), ("max_drawdown", "0.2"),
    ("max_drawdown", True),
])
def test_risk_limits_range_and_type_checked(key: str, value: object) -> None:
    cfg = _raw("live.yaml")
    cfg["risk"][key] = value
    with pytest.raises(ConfigError, match=rf"risk\.{key}"):
        validate("live.yaml", cfg)


def test_missing_required_section() -> None:
    cfg = _raw("live.yaml")
    del cfg["risk"]
    with pytest.raises(ConfigError, match="missing required"):
        validate("live.yaml", cfg)


def test_universe_unknown_key() -> None:
    cfg = _raw("universe.yaml")
    cfg["symbol"] = ["BTC"]
    with pytest.raises(ConfigError, match="symbol: unknown key"):
        validate("universe.yaml", cfg)


def test_unschematised_file_passes_through() -> None:
    assert validate("leadlag.yaml", {"anything": 1}) == {"anything": 1}


def test_scorecard_logs_and_records_stat_failure(monkeypatch: pytest.MonkeyPatch,
                                                 caplog: pytest.LogCaptureFixture) -> None:
    from engine.leadlag import scorecard

    def boom(*_a: object, **_k: object) -> float:
        raise np.linalg.LinAlgError("singular")

    monkeypatch.setattr(scorecard, "sharpe_hac_tstat", boom)
    idx = pd.date_range("2024-01-01", periods=24 * 30, freq="h", tz="UTC")
    net = pd.Series(np.random.default_rng(0).normal(0, 0.001, len(idx)), index=idx)
    cand = scorecard.Candidate(name="x", net=net, gross=net, stress=net, is_baseline=False)
    with caplog.at_level(logging.WARNING):
        df = scorecard.build([cand])
    assert df.loc[0, "hac_t"] is None
    assert "LinAlgError" in df.loc[0, "stat_errors"]
    assert "HAC t-stat failed" in caplog.text


def test_scorecard_does_not_swallow_bugs(monkeypatch: pytest.MonkeyPatch) -> None:
    from engine.leadlag import scorecard

    def bug(*_a: object, **_k: object) -> float:
        raise KeyError("programming error")

    monkeypatch.setattr(scorecard, "sharpe_hac_tstat", bug)
    idx = pd.date_range("2024-01-01", periods=24 * 30, freq="h", tz="UTC")
    net = pd.Series(0.0001, index=idx)
    with pytest.raises(KeyError):
        scorecard.build([scorecard.Candidate(name="x", net=net, gross=net, stress=net)])


def test_collect_reports_unreadable_parquet(tmp_path: Path) -> None:
    from importlib import import_module

    collect = import_module("engine.app.collect")

    p = tmp_path / "bad.parquet"
    p.write_bytes(b"not a parquet file")
    collect._UNREADABLE.clear()
    assert collect._parquet(p) is None
    assert collect._UNREADABLE and "bad.parquet" in collect._UNREADABLE[0]
    assert collect._parquet(tmp_path / "missing.parquet") is None
    assert len(collect._UNREADABLE) == 1
