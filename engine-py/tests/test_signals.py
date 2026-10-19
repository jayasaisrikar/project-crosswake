from __future__ import annotations

import numpy as np
import pandas as pd

from engine.contracts import Dataset, MarketData
from engine.signals.carry import CarryStrategy
from engine.signals.registry import build_strategies
from engine.signals.trend import TrendStrategy

N = 24 * 60
IDX = pd.date_range("2023-01-01", periods=N, freq="h", tz="UTC")
FIDX = IDX[IDX.hour % 8 == 0]

TREND = {"market": "perp", "lookbacks_days": [5, 10, 20], "vol_target_annual": 0.2, "vol_lookback_days": 10,
         "rebalance_hours": 24, "max_gross_leverage": 2.0, "max_weight_per_asset": 10.0, "allow_short": True}
CARRY = {"entry_funding_annual": 0.10, "exit_funding_annual": 0.02, "funding_lookback_hours": 72,
         "max_weight_per_asset": 0.2, "max_gross": 1.0}


def md_from(close: pd.DataFrame) -> MarketData:
    v = close * 0 + 1.0
    f = pd.DataFrame(False, index=close.index, columns=close.columns)
    return MarketData(close, close, close, close, v, v, f)


def path(drift: float, vol: float, seed: int) -> np.ndarray:
    r = np.random.default_rng(seed).normal(0, vol, N)
    return 100 * np.exp(np.cumsum(r - r.mean() + drift))


def ds(close: pd.DataFrame, funding: pd.DataFrame | None = None) -> Dataset:
    if funding is None:
        funding = pd.DataFrame(0.0, index=FIDX, columns=close.columns)
    return Dataset(spot=md_from(close), perp=md_from(close), funding=funding)


def test_trend_direction() -> None:
    close = pd.DataFrame({"UP": path(0.002, 0.002, 0), "DN": path(-0.002, 0.002, 1)}, index=IDX)
    tw = TrendStrategy(TREND).target_weights(ds(close))
    w = tw.perp.iloc[-1]
    assert w["UP"] > 0 and w["DN"] < 0
    assert tw.spot.shape[1] == 0 and tw.spot.index.equals(tw.perp.index)


def test_trend_vol_scaling() -> None:
    base = np.random.default_rng(3).normal(0, 0.005, N)
    close = pd.DataFrame({"A": 100 * np.exp(np.cumsum(base + 0.001)),
                          "B": 100 * np.exp(np.cumsum(2 * base + 0.001))}, index=IDX)
    w = TrendStrategy(TREND).target_weights(ds(close)).perp.iloc[-1]
    assert w["A"] > 0 and w["B"] > 0
    assert abs(w["B"] / w["A"] - 0.5) < 0.05


def test_trend_caps() -> None:
    close = pd.DataFrame({f"S{i}": path(0.002, 0.0005, i) for i in range(6)}, index=IDX)
    p = dict(TREND, max_weight_per_asset=0.25, max_gross_leverage=1.0)
    w = TrendStrategy(p).target_weights(ds(close)).perp
    assert (w.abs() <= 0.25 + 1e-12).all().all()
    assert (w.abs().sum(axis=1) <= 1.0 + 1e-9).all()
    assert w.iloc[-1].abs().sum() > 0.99
    assert (w.index.hour == 0).all()
    dn = pd.DataFrame({"DN": path(-0.002, 0.002, 1)}, index=IDX)
    assert (TrendStrategy(dict(TREND, allow_short=False)).target_weights(ds(dn)).perp >= 0).all().all()


def _funding(rates: dict[str, np.ndarray]) -> pd.DataFrame:
    return pd.DataFrame(rates, index=FIDX)


def test_carry_high_funding() -> None:
    close = pd.DataFrame({"A": path(0, 0.01, 0), "B": path(0, 0.01, 1)}, index=IDX)
    n = len(FIDX)
    fund = _funding({"A": np.full(n, 0.0003), "B": np.full(n, 0.00001)})
    tw = CarryStrategy(CARRY).target_weights(ds(close, fund))
    s, p = tw.spot.iloc[-1], tw.perp.iloc[-1]
    assert s["A"] == 0.2 and p["A"] == -0.2
    assert s["B"] == 0 and p["B"] == 0
    assert set(tw.spot.index.hour) <= {0, 8, 16}


def test_carry_hysteresis() -> None:
    close = pd.DataFrame({"A": path(0, 0.01, 0)}, index=IDX)
    n = len(FIDX)
    # 0.0003*1095 ~ 33% APR; 0.00005*1095 ~ 5.5% (between exit 2% and entry 10%); 0 -> exit
    r = np.concatenate([np.full(30, 0.00005), np.full(30, 0.0003), np.full(30, 0.00005), np.zeros(n - 90)])
    s = CarryStrategy(CARRY).target_weights(ds(close, _funding({"A": r}))).spot["A"]
    assert s.loc[FIDX[25]] == 0     # 5.5% never triggers entry
    assert s.loc[FIDX[45]] > 0      # entered on high funding
    assert s.loc[FIDX[80]] > 0      # 5.5% > exit -> still held
    assert s.loc[FIDX[100]] == 0    # 0% < exit -> exited


def test_carry_unlisted_zero() -> None:
    close = pd.DataFrame({"A": path(0, 0.01, 0), "B": path(0, 0.01, 1)}, index=IDX)
    close.iloc[:500, 1] = np.nan
    n = len(FIDX)
    fund = _funding({"A": np.full(n, 0.0003), "B": np.full(n, 0.0003)})
    tw = CarryStrategy(CARRY).target_weights(ds(close, fund))
    assert (tw.spot["B"].loc[: IDX[499]] == 0).all()
    assert tw.spot["B"].iloc[-1] > 0
    assert (tw.spot.abs().sum(axis=1) <= 0.5 + 1e-12).all()


def test_registry() -> None:
    cfg = {"strategies": {"trend": dict(TREND, enabled=True), "carry": dict(CARRY, enabled=False),
                          "allocation": {"trend": 0.5}}}
    assert [s.name for s in build_strategies(cfg)] == ["trend"]


def test_carry_skips_mismatched_spot_perp_basis():
    """Regression: FTT spot/perp diverged (0.28x-2.5x) in 2025; carry must not 'hedge' them."""
    import numpy as np
    import pandas as pd

    from engine.contracts import Dataset, MarketData
    from engine.signals.carry import CarryStrategy

    idx = pd.date_range("2024-01-01", periods=24 * 10, freq="1h", tz="UTC")
    cols = ["AAA", "BBB"]

    def md(px):
        f = pd.DataFrame(px, index=idx, columns=cols)
        return MarketData(f, f, f, f, f * 0 + 1e6, f * 0 + 1e9, f * 0 > 1)

    spot = np.ones((len(idx), 2)) * 100
    perp = spot.copy()
    perp[:, 1] = 50  # BBB perp is a different instrument
    fidx = idx[idx.hour % 8 == 0]
    funding = pd.DataFrame(0.001, index=fidx, columns=cols)
    params = {"entry_funding_annual": 0.1, "exit_funding_annual": 0.02, "funding_lookback_hours": 72,
              "max_weight_per_asset": 0.2, "max_gross": 1.0}
    tw = CarryStrategy(params).target_weights(Dataset(md(spot), md(perp), funding))
    assert tw.spot["AAA"].iloc[-1] > 0
    assert tw.spot["BBB"].fillna(0).abs().max() == 0
