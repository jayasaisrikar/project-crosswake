from __future__ import annotations

import pandas as pd
import pytest

from engine.validation.metrics import monthly_returns
from engine.validation.walkforward import walk_forward_splits


def test_month_boundary_utc() -> None:
    # 23:00 UTC on Jan 31 belongs to January even though it is Feb 1 in UTC+1 zones
    idx = pd.date_range("2023-01-31 22:00", "2023-02-01 01:00", freq="h", tz="UTC")
    r = pd.Series([0.0, 0.10, 0.20, 0.0], index=idx)
    t = monthly_returns(r)
    assert t.loc[2023, 1] == pytest.approx(0.10)
    assert t.loc[2023, 2] == pytest.approx(0.20)


def test_dst_irrelevant() -> None:
    # spanning EU/US DST transitions: UTC hourly index stays uniform, every hour counted once
    idx = pd.date_range("2023-03-01", "2023-11-30 23:00", freq="h", tz="UTC")
    assert (idx[1:] - idx[:-1] == pd.Timedelta(hours=1)).all()
    r = pd.Series(0.0001, index=idx)
    t = monthly_returns(r)
    for m, days in {3: 31, 4: 30, 10: 31, 11: 30}.items():
        assert t.loc[2023, m] == pytest.approx(1.0001 ** (24 * days) - 1)


def test_walk_forward_tz_aware_and_naive_end() -> None:
    idx = pd.date_range("2020-01-01", "2022-12-31 23:00", freq="h", tz="UTC")
    a = walk_forward_splits(idx, 12, 3, 24, end="2022-06-30 23:00")
    b = walk_forward_splits(idx, 12, 3, 24, end=pd.Timestamp("2022-06-30 23:00", tz="UTC"))
    assert len(a) == len(b) == 6
    for (tra, tea), (trb, teb) in zip(a, b, strict=True):
        assert (tra == trb).all() and (tea == teb).all()
    for _, te in a:
        start, stop = idx[te[0]], idx[te[-1]]
        assert start.day == 1 and start.hour == 0
        assert (stop + pd.Timedelta(hours=1)).day == 1
        assert str(start.tz) == "UTC"


def test_walk_forward_calendar_month_lengths() -> None:
    idx_utc = pd.date_range("2020-01-01", "2021-12-31 23:00", freq="h", tz="UTC")
    s = walk_forward_splits(idx_utc, 12, 6, 0)
    h1, h2 = (31 + 28 + 31 + 30 + 31 + 30) * 24, (31 + 31 + 30 + 31 + 30 + 31) * 24
    assert [len(te) for _, te in s] == [h1, h2]
