from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.data.integrity import check_dataset


def _idx(n: int, start: str = "2024-01-01") -> pd.DatetimeIndex:
    return pd.date_range(start, periods=n, freq="h", tz="UTC")


def _market(idx, closes: dict[str, list[float]], *, filled: dict[str, list[bool]] | None = None,
            opens=None, highs=None, lows=None, vols=None) -> MarketData:
    c = pd.DataFrame(closes, index=idx, dtype=float)
    o = pd.DataFrame(opens, index=idx, dtype=float) if opens else c.copy()
    h = pd.DataFrame(highs, index=idx, dtype=float) if highs else c.copy()
    low = pd.DataFrame(lows, index=idx, dtype=float) if lows else c.copy()
    v = pd.DataFrame(vols, index=idx, dtype=float) if vols else pd.DataFrame(
        {k: [1000.0] * len(idx) for k in closes}, index=idx)
    fil = pd.DataFrame({k: (filled or {}).get(k, [False] * len(idx)) for k in closes}, index=idx)
    return MarketData(open=o, high=h, low=low, close=c, volume=v, quote_volume=v, is_filled=fil)


def _clean_dataset(n: int = 48) -> Dataset:
    idx = _idx(n)
    rng = np.random.default_rng(0)
    px = 100 * np.exp(np.cumsum(rng.normal(0, 0.005, n)))
    closes = {"ETH": list(px)}
    spot = _market(idx, closes,
                   highs={"ETH": list(px * 1.002)}, lows={"ETH": list(px * 0.998)})
    perp = _market(idx, {"ETH": list(px * 1.0005)},
                   highs={"ETH": list(px * 1.0025)}, lows={"ETH": list(px * 0.9985)})
    funding = pd.DataFrame({"ETH": [0.0001, 0.0001]}, index=idx[[8, 16]])
    return Dataset(spot=spot, perp=perp, funding=funding)


def test_clean_dataset_passes():
    rep = check_dataset(_clean_dataset())
    assert rep.ok, rep.to_dict()["issues"]
    assert rep.counts()["critical"] == 0 and rep.counts()["high"] == 0
    assert rep.stats["n_bars"] == 48
    assert rep.stats["n_funding_events"] == 2


def test_duplicate_timestamps_are_critical():
    idx = _idx(6)
    dup = idx.insert(3, idx[2])  # duplicate hour
    px = [100.0] * 7
    spot = _market(dup, {"X": px})
    perp = _market(dup, {"X": px})
    rep = check_dataset(Dataset(spot=spot, perp=perp, funding=pd.DataFrame()))
    assert not rep.ok
    assert any(i.check == "grid" and i.severity == "critical" for i in rep.issues)


def test_non_hour_aligned_is_critical():
    idx = _idx(5) + pd.Timedelta(minutes=30)
    spot = _market(idx, {"X": [100.0] * 5})
    rep = check_dataset(Dataset(spot=spot, perp=_market(idx, {"X": [100.0] * 5}), funding=pd.DataFrame()))
    assert any(i.check == "grid" and "hour-aligned" in i.detail for i in rep.issues)
    assert not rep.ok


def test_hole_in_grid_is_high():
    idx = _idx(10).delete(5)  # drop one hour from the middle
    spot = _market(idx, {"X": [100.0] * 9})
    rep = check_dataset(Dataset(spot=spot, perp=_market(idx, {"X": [100.0] * 9}), funding=pd.DataFrame()))
    miss = [i for i in rep.issues if i.check == "grid" and "missing hours" in i.detail]
    assert miss and miss[0].n == 1 and not rep.ok


def test_bad_ohlc_on_real_bar_flagged():
    idx = _idx(4)
    # high < close on bar 2 -> ordering violation
    spot = _market(idx, {"X": [100.0, 100, 100, 100]},
                   highs={"X": [101.0, 101, 99, 101]}, lows={"X": [99.0] * 4})
    rep = check_dataset(Dataset(spot=spot, perp=_market(idx, {"X": [100.0] * 4}), funding=pd.DataFrame()))
    ohlc = [i for i in rep.issues if i.check == "ohlc" and i.severity == "critical"]
    assert ohlc and sum(i.n for i in ohlc) == 1 and not rep.ok


def test_unflagged_frozen_bar_is_critical():
    idx = _idx(5)
    # bars 2,3 are zero-volume o=h=l=c=prev-close but NOT marked is_filled
    closes = {"X": [1.0, 1.1, 1.1, 1.1, 1.2]}
    vols = {"X": [10.0, 10.0, 0.0, 0.0, 10.0]}
    spot = _market(idx, closes, vols=vols)  # highs/lows default to close => flat
    rep = check_dataset(Dataset(spot=spot, perp=_market(idx, {"X": [1.0] * 5}), funding=pd.DataFrame()))
    fz = [i for i in rep.issues if i.check == "frozen"]
    assert fz and fz[0].n == 2 and fz[0].severity == "critical" and not rep.ok


def test_frozen_bar_marked_filled_is_clean():
    idx = _idx(5)
    closes = {"X": [1.0, 1.1, 1.1, 1.1, 1.2]}
    vols = {"X": [10.0, 10.0, 0.0, 0.0, 10.0]}
    filled = {"X": [False, False, True, True, False]}
    spot = _market(idx, closes, vols=vols, filled=filled)
    rep = check_dataset(Dataset(spot=spot, perp=_market(idx, {"X": [1.0] * 5}), funding=pd.DataFrame()))
    assert not any(i.check == "frozen" for i in rep.issues)
    assert rep.stats["spot_longest_stale_run"]["X"] == 2


def test_large_basis_flagged_medium():
    idx = _idx(6)
    spot = _market(idx, {"X": [100.0] * 6})
    perp = _market(idx, {"X": [100.0, 100, 100, 50, 100, 100]})  # 100% basis on bar 3
    rep = check_dataset(Dataset(spot=spot, perp=perp, funding=pd.DataFrame()), max_basis=0.5)
    basis = [i for i in rep.issues if i.check == "basis"]
    assert basis and basis[0].severity == "medium" and basis[0].n == 1
    assert rep.ok  # medium only -> still ok
    assert rep.stats["worst_basis"]["X"] == pytest.approx(1.0)


def test_funding_misaligned_and_outside_window():
    idx = _idx(10)
    spot = _market(idx, {"X": [100.0] * 10})
    perp = _market(idx, {"X": [100.0] * 10})
    # one event 10min off the hour, one before the listing window
    fidx = pd.DatetimeIndex([idx[4] + pd.Timedelta(minutes=10),
                             idx[0] - pd.Timedelta(hours=5)])
    funding = pd.DataFrame({"X": [0.0001, 0.0001]}, index=fidx)
    rep = check_dataset(Dataset(spot=spot, perp=perp, funding=funding))
    assert any(i.check == "funding" and "off the hour" in i.detail for i in rep.issues)
    assert any(i.check == "funding" and "no live perp bar" in i.detail and i.n == 1
               and i.severity == "high"
               for i in rep.issues)


def test_report_is_deterministic_and_causal():
    data = _clean_dataset(60)
    a = check_dataset(data).to_dict()
    b = check_dataset(data).to_dict()
    assert a == b  # pure
    # truncating never introduces a NEW issue about the earlier window (causality)
    cut = data.truncate(data.spot.close.index[40])
    assert check_dataset(cut).counts()["critical"] == 0
    assert check_dataset(cut).counts()["high"] == 0
