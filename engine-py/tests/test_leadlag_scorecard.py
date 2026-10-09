"""Tests for the §11 scorecard and its pre-registered rejection gate."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.leadlag import scorecard as sc


def _ret(mu: float, sd: float, days: int, seed: int) -> pd.Series:
    n = days * 24
    idx = pd.date_range("2021-01-01", periods=n, freq="h", tz="UTC")
    return pd.Series(np.random.default_rng(seed).normal(mu, sd, n), index=idx)


def test_winner_passes_all_criteria() -> None:
    win = _ret(1.2e-4, 1e-3, 400, 1)          # strong positive drift, high t-stat
    cands = [
        sc.Candidate("winner", net=win, gross=_ret(1.4e-4, 1e-3, 400, 2),
                     stress=_ret(1.0e-4, 1e-3, 400, 3), n_trades=500, turnover_annual=50.0),
        sc.Candidate("flat_baseline", net=_ret(0.0, 1e-3, 400, 4), is_baseline=True),
    ]
    card = sc.build(cands, trial_sharpes=[0.05, 0.03, 0.04])
    row = card[card.strategy == "winner"].iloc[0]
    assert row["gate"] == "PASS" and row["reject_reason"] == ""
    assert row["incremental_sharpe"] > 0 and abs(row["hac_t"]) > 2.0
    assert sc.verdict(card).startswith("EDGE")


def test_losing_candidate_rejected_with_reason() -> None:
    lose = _ret(-2e-4, 1e-3, 400, 10)
    cands = [
        sc.Candidate("loser", net=lose, gross=_ret(-1e-4, 1e-3, 400, 11),
                     stress=_ret(-3e-4, 1e-3, 400, 12), n_trades=500, turnover_annual=80.0),
        sc.Candidate("flat_baseline", net=_ret(0.0, 1e-3, 400, 13), is_baseline=True),
    ]
    card = sc.build(cands)
    row = card[card.strategy == "loser"].iloc[0]
    assert row["gate"] == "REJECT" and row["reject_reason"] == "net_sharpe<=0"
    assert sc.verdict(card).startswith("NO EDGE")


def test_gross_edge_but_cost_eaten_is_rejected_not_as_dead_signal() -> None:
    # Positive gross (0x) edge, but 1x costs flip it negative -> still rejected (net_sharpe<=0),
    # yet gross_sharpe records that a signal existed before costs (distinguishes the failure mode).
    cands = [
        sc.Candidate("costly", net=_ret(-5e-5, 1e-3, 400, 20), gross=_ret(2e-4, 1e-3, 400, 21),
                     stress=_ret(-2e-4, 1e-3, 400, 22), n_trades=800, turnover_annual=200.0),
        sc.Candidate("flat_baseline", net=_ret(0.0, 1e-3, 400, 23), is_baseline=True),
    ]
    card = sc.build(cands)
    row = card[card.strategy == "costly"].iloc[0]
    assert row["gate"] == "REJECT" and row["reject_reason"] == "net_sharpe<=0"
    assert row["gross_sharpe"] > 0 and row["cost_sensitivity"] > 0


def test_baseline_rows_not_gated() -> None:
    cands = [sc.Candidate("b", net=_ret(1e-4, 1e-3, 100, 30), is_baseline=True)]
    card = sc.build(cands)
    assert card.iloc[0]["gate"] == "baseline"
