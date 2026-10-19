"""Timestamp-level audit of the time axis (decision -> fill, funding, staleness, delisting, UTC)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.backtest.engine import run_backtest
from engine.contracts import CostBreakdown, Dataset, MarketData, TargetWeights
from engine.data.clean import clean_bars, parse_funding_csv, parse_kline_csv
from engine.signals.carry import CarryStrategy
from engine.signals.trend import TrendStrategy, tradable_mask

H = pd.Timedelta(hours=1)


@dataclass
class ZeroCost:
    def trade_cost(self, symbol, market, notional_abs, price, adv_quote, daily_vol) -> CostBreakdown:
        return CostBreakdown()


@dataclass
class Fixed:
    spot: pd.DataFrame
    perp: pd.DataFrame
    name: str = "fixed"

    def target_weights(self, data: Dataset) -> TargetWeights:
        return TargetWeights(spot=self.spot, perp=self.perp)


def _idx(n: int, start: str = "2024-01-01") -> pd.DatetimeIndex:
    return pd.date_range(start, periods=n, freq="h", tz="UTC")


def _md(o: list[float], c: list[float], idx, filled: list[bool] | None = None, sym: str = "X") -> MarketData:
    op = pd.DataFrame({sym: o}, index=idx, dtype=float)
    cl = pd.DataFrame({sym: c}, index=idx, dtype=float)
    z = pd.DataFrame(1e9, index=idx, columns=[sym])
    f = pd.DataFrame({sym: filled or [False] * len(idx)}, index=idx)
    return MarketData(op, cl, cl, cl, z, z, f)


def _empty(idx) -> MarketData:
    e = pd.DataFrame(index=idx)
    return MarketData(e, e, e, e, e, e, e)


def _perp_ds(o, c, funding=None, filled=None) -> Dataset:
    idx = _idx(len(c))
    return Dataset(spot=_empty(idx), perp=_md(o, c, idx, filled),
                   funding=funding if funding is not None else pd.DataFrame())


# ---- 1. decision at bar t uses bar t close, fills at bar t+1 open --------------------------------

def test_kline_close_time_is_open_plus_interval_minus_1ms() -> None:
    # Real Binance row layout (open_time ... close_time = open + 3_600_000 - 1)
    row = "1580457600000,1,1,1,1,10,1580461199999,10,5,1,1,0"
    df = parse_kline_csv(row)
    assert df["ts"].iloc[0] == pd.Timestamp("2020-01-31 08:00", tz="UTC")  # ts = OPEN time
    assert 1580461199999 - 1580457600000 == 3_600_000 - 1


def test_decision_fills_at_next_open_never_earlier() -> None:
    o = [100, 100, 150, 150, 150]
    c = [100, 120, 150, 150, 150]
    ds = _perp_ds(o, c)
    idx = ds.perp.close.index
    strat = Fixed(pd.DataFrame(index=idx[:0]), pd.DataFrame({"X": [1.0]}, index=idx[[1]]))
    r = run_backtest(strat, ds, ZeroCost(), 1000.0)
    tr = r.trades.iloc[0]
    assert tr["ts"] == idx[2]          # decided at bar 1 (close 120 known at 01:59:59.999) -> 02:00 open
    assert tr["price"] == 150.0        # bar t+1 OPEN, not bar t close (120)
    assert r.positions["perp"]["X"].iloc[:2].abs().sum() == 0


def test_trend_decision_ignores_future_bars() -> None:
    n = 24 * 30
    idx = _idx(n)
    rng = np.random.default_rng(0)
    c = 100 * np.exp(np.cumsum(rng.normal(0.001, 0.01, n)))
    params = {"market": "perp", "lookbacks_days": [5], "vol_target_annual": 0.2, "vol_lookback_days": 5,
              "rebalance_hours": 24, "max_gross_leverage": 2.0, "max_weight_per_asset": 10.0}
    ds = Dataset(_empty(idx), _md(list(c), list(c), idx), pd.DataFrame())
    full = TrendStrategy(params).target_weights(ds).perp
    t = idx[24 * 20]
    trunc = TrendStrategy(params).target_weights(ds.truncate(t)).perp
    assert full.loc[t, "X"] == pytest.approx(trunc.loc[t, "X"])


# ---- 2. funding --------------------------------------------------------------------------------

@pytest.mark.parametrize("w,sign", [(1.0, +1), (-1.0, -1)])
def test_funding_sign_and_mark_strictly_before(w: float, sign: int) -> None:
    # hold from 01:00 open; settlement at 08:00; mark = close of 07:00 bar (=150), not 08:00 bar (=999)
    n = 10
    o = [100.0] * n
    c = [100.0] * n
    c[7] = 150.0
    o[8] = c[8] = 999.0
    fund = pd.DataFrame({"X": [0.001]}, index=[pd.Timestamp("2024-01-01 08:00", tz="UTC")])
    ds = _perp_ds(o, c, fund)
    idx = ds.perp.close.index
    strat = Fixed(pd.DataFrame(index=idx[:0]), pd.DataFrame({"X": [w]}, index=idx[[0]]))
    r = run_backtest(strat, ds, ZeroCost(), 1000.0)
    qty = 1000.0 * w / 100.0
    # positive rate: long pays (+cost), short receives (-cost)
    assert r.costs["funding"].loc[idx[8]] == pytest.approx(sign * abs(qty) * 150.0 * 0.001)
    assert r.costs["funding"].drop(idx[8]).abs().sum() == 0


def test_funding_ms_jitter_snapped_to_settlement_hour() -> None:
    """REGRESSION: Binance calc_time is often 08:00:00.001; it used to be charged at 09:00 instead of 08:00,
    so a position closed at the 08:00 open escaped funding it really owed."""
    n = 12
    fund = pd.DataFrame({"X": [0.001]}, index=[pd.Timestamp("2024-01-01 08:00:00.001", tz="UTC")])
    ds = _perp_ds([100.0] * n, [100.0] * n, fund)
    idx = ds.perp.close.index
    # long from 01:00 open, flat decided at 07:00 -> closed at 08:00 open (just after settlement)
    w = pd.DataFrame({"X": [1.0, 0.0]}, index=idx[[0, 7]])
    r = run_backtest(Fixed(pd.DataFrame(index=idx[:0]), w), ds, ZeroCost(), 1000.0)
    assert r.costs["funding"].loc[idx[8]] == pytest.approx(10.0 * 100.0 * 0.001)
    assert r.costs["funding"].sum() == pytest.approx(1.0)


def test_position_opened_at_settlement_open_not_charged() -> None:
    """Rule: fills at the settlement bar's open happen just after the settlement snapshot -> not charged."""
    n = 12
    fund = pd.DataFrame({"X": [0.001]}, index=[pd.Timestamp("2024-01-01 08:00", tz="UTC")])
    ds = _perp_ds([100.0] * n, [100.0] * n, fund)
    idx = ds.perp.close.index
    w = pd.DataFrame({"X": [1.0]}, index=idx[[7]])  # fills at 08:00 open
    r = run_backtest(Fixed(pd.DataFrame(index=idx[:0]), w), ds, ZeroCost(), 1000.0)
    assert r.trades["ts"].iloc[0] == idx[8]
    assert r.costs["funding"].sum() == 0.0


def test_parse_funding_archive_columns() -> None:
    txt = "calc_time,funding_interval_hours,last_funding_rate\n1579449600000,8,0.00010000\n"
    df = parse_funding_csv(txt)
    assert df["ts"].iloc[0] == pd.Timestamp("2020-01-19 16:00", tz="UTC")
    assert df["rate"].iloc[0] == pytest.approx(0.0001)  # last column = rate, not interval hours


# ---- 3. carry trailing APR ---------------------------------------------------------------------

CARRY = {"entry_funding_annual": 0.10, "exit_funding_annual": 0.02, "funding_lookback_hours": 72,
         "max_weight_per_asset": 0.5, "max_gross": 1.0}


@pytest.mark.parametrize("every", [8, 4, 2, 1])
def test_carry_apr_interval_agnostic(every: int) -> None:
    """REGRESSION: APR was mean*3*365, overstating 4h/2h/1h symbols' APR by 2x/4x/8x."""
    per_hour = 0.0001 / 8  # 0.01% per 8h equivalent everywhere => 10.95% APR
    t = pd.Timestamp("2024-01-10", tz="UTC")
    ev = pd.date_range(pd.Timestamp("2024-01-01", tz="UTC"), t, freq=f"{every}h")
    f = pd.DataFrame({"X": per_hour * every}, index=ev)
    apr = CarryStrategy(CARRY).trailing_apr(f, t)["X"]
    assert apr == pytest.approx(per_hour * 8760)


def test_carry_apr_uses_only_events_le_t_and_needs_history() -> None:
    t = pd.Timestamp("2024-01-10", tz="UTC")
    ev = pd.date_range("2024-01-01", "2024-01-12", freq="8h", tz="UTC")
    f = pd.DataFrame({"X": np.where(ev > t, 1.0, 0.0001)}, index=ev)  # huge future rates
    cs = CarryStrategy(CARRY)
    assert cs.trailing_apr(f, t)["X"] == pytest.approx(0.0001 * 1095)
    young = f.loc["2024-01-08":]
    assert np.isnan(cs.trailing_apr(young, t)["X"])  # < 72h of history -> no signal


# ---- 4. stale bars -----------------------------------------------------------------------------

def test_stale_returns_excluded_from_vol() -> None:
    """REGRESSION: filled bars (0 return) used to deflate vol -> overleverage."""
    n = 24 * 40
    idx = _idx(n)
    rng = np.random.default_rng(1)
    c = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.01, n)))
    params = {"market": "perp", "lookbacks_days": [5], "vol_target_annual": 0.5, "vol_lookback_days": 10,
              "rebalance_hours": 24, "max_gross_leverage": 100.0, "max_weight_per_asset": 100.0}
    clean = Dataset(_empty(idx), _md(list(c), list(c), idx), pd.DataFrame())
    # every other bar inside the vol window is a 'filled' bar (repeat previous close, flagged)
    c2 = c.copy()
    filled = [False] * n
    for i in range(n - 24 * 10, n, 2):
        c2[i] = c2[i - 1]
        filled[i] = True
    stale = Dataset(_empty(idx), _md(list(c2), list(c2), idx, filled), pd.DataFrame())
    t = idx[-24]
    w_clean = abs(TrendStrategy(params).target_weights(clean).perp.loc[t, "X"])
    w_stale = abs(TrendStrategy(params).target_weights(stale).perp.loc[t, "X"])
    # with zeros kept, vol ~ /sqrt(2) and weight inflated ~1.4x; excluded -> comparable
    assert w_stale < 1.2 * w_clean


def test_stale_over_24_not_eligible() -> None:
    idx = _idx(60)
    filled = [False] * 10 + [True] * 30 + [False] * 20
    md = _md([1.0] * 60, [1.0] * 60, idx, filled)
    m = tradable_mask(md)["X"]
    assert m.iloc[10 + 23] and not m.iloc[10 + 24] and m.iloc[45]


def test_no_fill_on_stale_bar_exit_retried() -> None:
    """Rule: a held symbol that turns stale cannot be traded at a fabricated price; the exit is skipped
    (meta n_skipped_stale) and executes at the first decision whose next bar is real."""
    n = 10
    o = [100.0] * n
    c = [100.0] * n
    filled = [False] * n
    for i in (3, 4):
        filled[i] = True
    ds = _perp_ds(o, c, filled=filled)
    idx = ds.perp.close.index
    w = pd.DataFrame({"X": [1.0, 0.0, 0.0, 0.0]}, index=idx[[0, 2, 3, 4]])
    r = run_backtest(Fixed(pd.DataFrame(index=idx[:0]), w), ds, ZeroCost(), 1000.0)
    sells = r.trades[r.trades["side"] == "sell"]
    assert list(sells["ts"]) == [idx[5]]
    assert r.meta["n_skipped_stale"] == 2


# ---- 5. delisting ------------------------------------------------------------------------------

def test_forced_exit_at_last_real_close() -> None:
    o = [100.0, 100, 100, 100, 50, np.nan, np.nan, np.nan]
    c = [100.0, 100, 100, 100, 40, np.nan, np.nan, np.nan]
    ds = _perp_ds(o, c)
    idx = ds.perp.close.index
    w = pd.DataFrame({"X": [1.0]}, index=idx[[0]])
    r = run_backtest(Fixed(pd.DataFrame(index=idx[:0]), w), ds, ZeroCost(), 1000.0)
    fx = r.trades[r.trades["side"] == "forced_exit"].iloc[0]
    assert fx["ts"] == idx[5] and fx["price"] == 40.0
    assert r.equity.iloc[-1] == pytest.approx(400.0)


def test_clean_never_fills_past_last_real_bar() -> None:
    ts = pd.Series(_idx(5)).drop(index=[2]).reset_index(drop=True)
    raw = pd.DataFrame({"ts": ts, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
                        "volume": 1.0, "quote_volume": 1.0, "trades": 1.0})
    out, _ = clean_bars(raw)
    assert out["ts"].iloc[-1] == ts.iloc[-1] and not out["is_filled"].iloc[-1]
    assert out["is_filled"].tolist() == [False, False, True, False, False]


# ---- 6. UTC / DST / month boundaries -----------------------------------------------------------

def test_utc_no_dst_and_month_boundary() -> None:
    # 2024-03-31 01:00 UTC is the EU DST switch; 2024-03-10 is the US one. UTC must stay 1h-regular.
    for start in ("2024-03-09 20:00", "2024-03-30 22:00", "2024-10-26 22:00"):
        t0 = pd.Timestamp(start, tz="UTC")
        rows = "\n".join(f"{int((t0 + k * H).value // 10**6)},1,1,1,1,1,0,1,1,1,1,0" for k in range(8))
        df = parse_kline_csv(rows)
        assert str(df["ts"].dt.tz) == "UTC"
        assert (df["ts"].diff().dropna() == H).all()
    # month boundary: last bar of Jan opens 23:00 and Feb starts 00:00 -- contiguous, no gap/fill
    jan = int(pd.Timestamp("2024-01-31 23:00", tz="UTC").value // 10**6)
    df = parse_kline_csv(f"{jan},1,1,1,1,1,0,1,1,1,1,0\n{jan + 3_600_000},1,1,1,1,1,0,1,1,1,1,0")
    out, info = clean_bars(df)
    assert info["n_filled"] == 0 and out["ts"].iloc[1] == pd.Timestamp("2024-02-01", tz="UTC")


def test_microsecond_timestamps_detected() -> None:
    us = int(pd.Timestamp("2025-01-01", tz="UTC").value // 1000)
    df = parse_kline_csv(f"{us},1,1,1,1,1,0,1,1,1,1,0")
    assert df["ts"].iloc[0] == pd.Timestamp("2025-01-01", tz="UTC")


# ---- 7. LUNA regression (real data) ------------------------------------------------------------

LUNA = Path("data/cleaned/bars/spot/LUNA.parquet")


@pytest.mark.skipif(not LUNA.exists(), reason="cleaned data not present")
def test_luna_contains_may_2022_crash() -> None:
    df = pd.read_parquet(LUNA)
    real = df[~df["is_filled"]]
    assert pd.Timestamp(real["ts"].iloc[-1]) <= pd.Timestamp("2022-05-31 23:00", tz="UTC")
    before_last = real.iloc[:-1]
    assert (before_last["close"] < 1.0).any()
    assert (before_last.loc[before_last["ts"] >= pd.Timestamp("2022-05-01", tz="UTC"), "close"] < 1.0).any()


def test_trend_trades_when_unheld_symbol_has_nan_returns():
    """Regression: NaN returns in an unheld/unlisted column zeroed portfolio vol -> trend never traded."""
    import numpy as np
    import pandas as pd

    from engine.contracts import Dataset, MarketData
    from engine.signals.trend import TrendStrategy

    idx = pd.date_range("2023-01-01", periods=24 * 200, freq="1h", tz="UTC")
    rng = np.random.default_rng(1)
    up = 100 * np.exp(np.cumsum(0.001 + 0.002 * rng.standard_normal(len(idx))))  # unambiguous uptrend
    close = pd.DataFrame({"AAA": up, "BBB": np.nan}, index=idx)  # BBB never listed
    filled = close.isna()
    md = MarketData(close, close, close, close, close * 0 + 1, close * 0 + 1e9, filled)
    params = {"lookbacks_days": [10, 20], "vol_target_annual": 0.2, "vol_lookback_days": 10,
              "rebalance_hours": 24, "max_gross_leverage": 2.0, "max_weight_per_asset": 1.0}
    w = TrendStrategy(params).target_weights(Dataset(md, md, pd.DataFrame(index=idx[:0])))
    assert (w.perp["AAA"].iloc[-50:] > 0).all()
