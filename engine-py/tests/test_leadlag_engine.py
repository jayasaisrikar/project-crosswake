"""Lead-lag engine: methods detect a planted lag, lag selection sees training data only, BH, verdicts."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.leadlag import engine as E
from engine.leadlag import methods as M


def planted(n: int = 24 * 500, lag: int = 2, beta: float = 0.3, seed: int = 0) -> tuple[pd.Series, pd.Series]:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2021-01-01", periods=n, freq="h", tz="UTC")
    x = pd.Series(rng.normal(0, 0.01, n), index=idx)
    y = beta * x.shift(lag).fillna(0) + pd.Series(rng.normal(0, 0.01, n), index=idx)
    return x, y


def test_methods_find_planted_lag() -> None:
    x, y = planted(n=5000)
    assert M.lagged_xcorr(x, y, 2)["p"] < 1e-6
    assert M.lagged_xcorr(x, y, 4)["p"] > 1e-3
    assert M.lagged_ols_hac(x, y, 2)["p"] < 1e-6
    assert M.granger(x, y, 2)["p"] < 1e-6
    assert M.transfer_entropy(x, y, 2, n_surr=49)["p"] <= 0.02
    assert M.mutual_information(x, y, 2, n_surr=49)["p"] <= 0.02
    irf = M.var_irf(x, y, [1, 2, 4], order=4)
    assert irf[2]["p"] < 1e-6 and abs(irf[2]["stat"] - 0.3) < 0.05


def test_select_lag_uses_training_data_only() -> None:
    x, y = planted(lag=2)
    split = x.index[len(x) // 2]
    tr = slice(None, split)
    best, _ = E.select_lag(x.loc[tr], y.loc[tr])
    assert best == 2
    # Rewrite the TEST half so that lag 8 dominates there; training selection must not move.
    y2 = y.copy()
    rest = y.index > split
    y2[rest] = 0.9 * x.shift(8)[rest].fillna(0)
    best2, _ = E.select_lag(x.loc[tr], y2.loc[tr])
    assert best2 == best == 2


def test_walk_forward_selection_invariant_to_future_folds() -> None:
    x, y = planted(n=24 * 900, lag=1)
    p = E.Pair("X->Y", "test", x, y, "BTC", "perp")
    cm = E.CostModel(fee_bps={"perp": 5.0, "spot": 10.0}, half_spread_bps={"default": 1.0}, impact_y=0.0)
    qv = pd.Series(1e9, index=x.index)
    _, folds, _ = E.walk_forward(p, cm, qv, end=x.index[-1])
    assert len(folds) >= 2 and (folds["selected_lag"] == 1).all()
    # Destroy data after the first test fold: the first fold's selection/beta cannot change.
    first_end = folds["test_end"].iloc[0]
    y3 = y.copy()
    y3[y3.index >= first_end] = np.random.default_rng(9).normal(0, 0.05, int((y3.index >= first_end).sum()))
    _, folds3, _ = E.walk_forward(E.Pair("X->Y", "t", x, y3, "BTC", "perp"), cm, qv, end=x.index[-1])
    assert folds3["selected_lag"].iloc[0] == folds["selected_lag"].iloc[0]
    assert folds3["train_t"].iloc[0] == folds["train_t"].iloc[0]


def test_strategy_is_causal() -> None:
    x, y = planted(n=2000, lag=1)
    full = E.strategy_pnl(x, y, 0.0, 0.3, 1, 1e-4)
    t = x.index[1000]
    cut = E.strategy_pnl(x.loc[:t], y.loc[:t], 0.0, 0.3, 1, 1e-4)
    pd.testing.assert_series_equal(full["pos"].loc[:t], cut["pos"])


def test_bh_and_verdict() -> None:
    rej, q = M.benjamini_hochberg(np.array([0.001, 0.02, 0.5, np.nan]), 0.05)
    assert list(rej) == [True, True, False, False] and np.isnan(q[3])
    good = {"active_bars": 5000, "net_hac_t": 3.0, "net_total": 0.5}
    assert E.verdict(True, good, 5, 0.8) == E.EDGE
    assert E.verdict(True, {**good, "net_total": -0.1}, 5, 0.8) == E.NO_EDGE
    assert E.verdict(True, {**good, "net_hac_t": 1.0}, 5, 0.8) == E.INSUFF
    assert E.verdict(True, {**good, "active_bars": 10}, 5, 0.8) == E.INSUFF
    assert E.verdict(False, {**good, "net_hac_t": 0.5}, 5, 0.8) == E.NO_EDGE
