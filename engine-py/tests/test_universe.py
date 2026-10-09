"""Point-in-time universe: causality (truncation property), rules, and listings parsing."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.contracts import MarketData
from engine.data.listings import classify_pair, select_candidates
from engine.universe import pit_universe_mask

SYMS = ["AAA", "BBB", "CCC", "DDD", "EEE"]
N = 24 * 200


def make_market(seed: int = 0) -> MarketData:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2022-01-01", periods=N, freq="h", tz="UTC")
    close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (N, len(SYMS))), axis=0)),
                         index=idx, columns=SYMS)
    scale = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
    qv = pd.DataFrame(rng.uniform(0.5, 1.5, close.shape) * scale * 1e6, index=idx, columns=SYMS)
    close.iloc[: 24 * 100, 2] = np.nan      # CCC listed on day 100
    close.iloc[24 * 120:, 3] = np.nan       # DDD delisted on day 120
    qv.iloc[24 * 140:, 1] *= 0.01           # BBB volume collapses on day 140
    filled = pd.DataFrame(False, index=idx, columns=SYMS)
    filled.iloc[24 * 170: 24 * 185, 0] = True  # AAA stale 2022-06-20..07-05
    qv = qv.where(close.notna())
    return MarketData(open=close, high=close, low=close, close=close, volume=qv / close,
                      quote_volume=qv, is_filled=filled)


@pytest.mark.parametrize("rebalance", ["monthly", "daily"])
def test_truncation_causality(rebalance: str) -> None:
    md = make_market()
    full = pit_universe_mask(md, top_n=2, min_history_days=20, rebalance=rebalance)  # type: ignore[arg-type]
    for t in md.close.index[[100, 24 * 31, 24 * 31 + 5, 24 * 101, 24 * 141 + 3, 24 * 152, N - 1]]:
        trunc = pit_universe_mask(md.truncate(t), top_n=2, min_history_days=20, rebalance=rebalance)  # type: ignore[arg-type]
        pd.testing.assert_series_equal(trunc.loc[t], full.loc[t], check_names=False)


def test_future_perturbation_does_not_change_past() -> None:
    md = make_market()
    t = md.close.index[24 * 90]
    base = pit_universe_mask(md, top_n=2, min_history_days=20)
    qv = md.quote_volume.copy()
    qv.loc[t + pd.Timedelta(hours=1):] *= 1000 * np.arange(1, 6)[::-1]  # reverse ranking after t
    md2 = MarketData(**{**md.__dict__, "quote_volume": qv})
    pert = pit_universe_mask(md2, top_n=2, min_history_days=20)
    pd.testing.assert_frame_equal(base.loc[:t], pert.loc[:t])


def test_rules() -> None:
    md = make_market()
    m = pit_universe_mask(md, top_n=2, min_history_days=60)
    idx = m.index
    # first month: nobody has 60 days of history
    assert not m.loc[idx < pd.Timestamp("2022-03-01", tz="UTC")].any().any()
    # constant within each month (where tradable)
    month = m.loc["2022-04"]
    assert (month.loc[:, ["AAA", "BBB"]].nunique() == 1).all()
    assert month.iloc[0].loc[["AAA", "BBB"]].all()
    # never True where no valid close
    assert not (m & md.close.isna()).any().any()
    # CCC (listed day 100 = 2022-04-11) can't qualify before 60 days of history
    assert not m.loc[: "2022-06-09", "CCC"].any()
    # BBB volume collapse on day 140 (2022-05-21) -> out from July (June ADV still mixed)
    assert not m.loc["2022-07", "BBB"].any()
    # AAA stale over 2022-06-30 boundary (filled days 170-185) -> excluded in July
    assert not m.loc["2022-07", "AAA"].any()
    assert m.sum(axis=1).max() <= 2


def test_classify_pair() -> None:
    assert classify_pair("BTCUSDT") == "BTC"
    assert classify_pair("1000PEPEUSDT") == "1000PEPE"
    assert classify_pair("BTCUSDT_230929") is None
    assert classify_pair("ETHBUSD") is None
    assert classify_pair("USDCUSDT") is None
    assert classify_pair("BTCUPUSDT") is None


def test_select_candidates_uses_past_only() -> None:
    idx = pd.date_range("2020-01-01", "2020-03-31", freq="D", tz="UTC")
    qv = pd.DataFrame({"A": 10.0, "B": 1.0, "C": np.nan}, index=idx)
    qv.loc["2020-03-01":, "C"] = 100.0  # C lists in March
    cands, per = select_candidates(qv, top_k=1, start="2020-01", end="2020-03")
    assert per["2020-01"] == ["A"] and per["2020-02"] == ["A"] and per["2020-03"] == ["C"]
    assert cands == ["A", "C"]
