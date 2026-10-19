"""Causality + behavior tests for the executable BTC->altcoin lead-lag strategy."""

from __future__ import annotations

import numpy as np
import pandas as pd

from engine.contracts import Dataset, MarketData, TargetWeights
from engine.signals.leadlag import BtcImpulseFollow, LeadLagStrategy

SYMS = ["BTC", "ETH", "SOL", "XRP"]
PARAMS = {"market": "perp", "leader": "BTC", "k": 2.0, "vol_lookback_bars": 50,
          "hold_hours": 1, "gross": 1.0, "max_weight_per_asset": 0.25, "allow_short": True}


def _market(close: pd.DataFrame) -> MarketData:
    vol = pd.DataFrame(50.0, index=close.index, columns=close.columns).where(close.notna())
    filled = pd.DataFrame(False, index=close.index, columns=close.columns)
    return MarketData(open=close, high=close * 1.001, low=close * 0.999, close=close,
                      volume=vol, quote_volume=vol * close, is_filled=filled)


def _dataset(close: pd.DataFrame) -> Dataset:
    fund = pd.DataFrame(0.0, index=close.index[close.index.hour % 8 == 0], columns=close.columns)
    return Dataset(spot=_market(close), perp=_market(close), funding=fund)


def _random_dataset(seed: int = 0, n: int = 1500) -> Dataset:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2022-01-01", periods=n, freq="h", tz="UTC")
    rets = rng.normal(0.0, 0.01, (n, len(SYMS)))
    close = pd.DataFrame(100 * np.exp(np.cumsum(rets, axis=0)), index=idx, columns=SYMS)
    return _dataset(close)


def _row(tw: TargetWeights, t: pd.Timestamp) -> pd.Series:
    f = tw.perp
    return f.loc[t].fillna(0.0) if t in f.index else pd.Series(dtype=float)


def test_truncation_invariance() -> None:
    strat = LeadLagStrategy(PARAMS)
    data = _random_dataset()
    full = strat.target_weights(data)
    rng = np.random.default_rng(1)
    for t in rng.choice(full.perp.index[200:], size=30, replace=False):
        t = pd.Timestamp(t)
        trunc = strat.target_weights(data.truncate(t))
        pd.testing.assert_series_equal(_row(full, t), _row(trunc, t), check_names=False)
    # the random series must actually fire some impulses, else the test is vacuous
    assert (full.perp.abs().to_numpy() > 0).any()


def test_future_perturbation_does_not_change_past() -> None:
    strat = LeadLagStrategy(PARAMS)
    data = _random_dataset()
    full = strat.target_weights(data)
    rng = np.random.default_rng(2)
    t = pd.Timestamp(full.perp.index[800])
    close = data.perp.close.copy()
    close.loc[close.index > t] *= rng.uniform(0.5, 2.0, close.loc[close.index > t].shape)
    pert = strat.target_weights(_dataset(close))
    pd.testing.assert_series_equal(_row(full, t), _row(pert, t), check_names=False)


def test_btc_impulse_sets_follower_direction() -> None:
    # Quiet BTC, then a single +10% impulse at bar 100; followers get an equal-weight long at that bar only.
    idx = pd.date_range("2022-01-01", periods=200, freq="h", tz="UTC")
    btc = np.full(200, 100.0)
    btc[100:] = 110.0                       # +10% jump at bar 100 (one impulse), flat after
    close = pd.DataFrame({"BTC": btc, "ETH": 50.0, "SOL": 20.0, "XRP": 1.0}, index=idx)
    w = LeadLagStrategy(PARAMS).target_weights(_dataset(close)).perp
    t = idx[100]
    assert w.loc[t, "ETH"] == 0.25 and w.loc[t, "SOL"] == 0.25   # gross/3 capped at max_weight
    assert w.loc[t, "BTC"] == 0.0                                # leader never traded
    assert (w.loc[idx[101], ["ETH", "SOL", "XRP"]] == 0.0).all()  # hold_hours=1 -> flat next bar


def test_reversion_flips_the_basket_sign() -> None:
    idx = pd.date_range("2022-01-01", periods=200, freq="h", tz="UTC")
    btc = np.full(200, 100.0)
    btc[100:] = 110.0
    close = pd.DataFrame({"BTC": btc, "ETH": 50.0, "SOL": 20.0, "XRP": 1.0}, index=idx)
    data = _dataset(close)
    cont = LeadLagStrategy({**PARAMS, "direction": "continuation"}).target_weights(data).perp
    rev = LeadLagStrategy({**PARAMS, "direction": "reversion"}).target_weights(data).perp
    t = idx[100]
    pd.testing.assert_series_equal(rev.loc[t], -cont.loc[t], check_names=False)  # exact opposite sign


def test_btc_impulse_baseline_trades_only_leader() -> None:
    idx = pd.date_range("2022-01-01", periods=200, freq="h", tz="UTC")
    btc = np.full(200, 100.0)
    btc[100:] = 110.0
    close = pd.DataFrame({"BTC": btc, "ETH": 50.0, "SOL": 20.0, "XRP": 1.0}, index=idx)
    w = BtcImpulseFollow({"market": "perp", "leader": "BTC", "k": 2.0, "vol_lookback_bars": 50,
                          "hold_hours": 1, "gross": 1.0}).target_weights(_dataset(close)).perp
    t = idx[100]
    assert w.loc[t, "BTC"] == 1.0                                  # long the leader, full gross
    assert (w.loc[t, ["ETH", "SOL", "XRP"]] == 0.0).all()         # no follower exposure
