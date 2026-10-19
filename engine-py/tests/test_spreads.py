from __future__ import annotations

import io
import zipfile

import numpy as np
import pandas as pd
import pytest

from engine.data.spreads import (
    AR_FLOOR_BPS,
    abdi_ranaldo_half_spread_bps,
    abdi_ranaldo_summary,
    book_ticker_summary,
    read_book_ticker,
)


def _bars_with_spread(half_bps: float, vol_min: float, n_hours: int = 24 * 60, seed: int = 0) -> pd.DataFrame:
    """Efficient price random walk per minute; trades bounce at mid*(1 +/- half spread)."""
    rng = np.random.default_rng(seed)
    n = n_hours * 60
    mid = 100 * np.exp(np.cumsum(rng.normal(0, vol_min, n)))
    px = mid * (1 + rng.choice([-1, 1], n) * half_bps * 1e-4)
    idx = pd.date_range("2024-01-01", periods=n, freq="min", tz="UTC")
    s = pd.Series(px, index=idx)
    return pd.DataFrame({"high": s.resample("1h").max(), "low": s.resample("1h").min(),
                         "close": s.resample("1h").last()})


@pytest.mark.parametrize("half", [2.0, 10.0])
def test_abdi_ranaldo_recovers_known_spread(half: float) -> None:
    b = _bars_with_spread(half, vol_min=1e-6)  # spread-dominated
    est = abdi_ranaldo_half_spread_bps(b["high"], b["low"], b["close"])
    assert len(est) == 2  # two calendar months
    assert est.median() == pytest.approx(half, rel=0.15)


def test_abdi_ranaldo_zero_spread_is_small_and_nonnegative() -> None:
    b = _bars_with_spread(0.0, vol_min=1e-4)
    est = abdi_ranaldo_half_spread_bps(b["high"], b["low"], b["close"])
    assert (est >= 0).all()
    assert est.median() < 1.0  # vs 1h vol ~ 7.7 bps


def test_abdi_ranaldo_summary_skips_filled_bars() -> None:
    b = _bars_with_spread(5.0, vol_min=1e-6)
    b["is_filled"] = False
    b.loc[b.index[:100], ["high", "low", "close"]] = 1e6
    b.loc[b.index[:100], "is_filled"] = True
    out = abdi_ranaldo_summary(b)
    assert out is not None and out["source"].startswith("abdi_ranaldo")
    assert out["median"] == pytest.approx(5.0, rel=0.15)
    assert out["raw"]["median"] == pytest.approx(5.0, rel=0.15)


def test_abdi_ranaldo_summary_floors_uninformative_zero() -> None:
    b = _bars_with_spread(0.0, vol_min=1e-4)
    out = abdi_ranaldo_summary(b)
    assert out is not None
    assert out["p75"] >= AR_FLOOR_BPS and out["raw"]["median"] < 1.0
    assert out["median"] <= out["p75"] <= out["p95"]


def _book_zip(path, bid, ask, t_ms) -> None:
    df = pd.DataFrame({"update_id": range(len(bid)), "best_bid_price": bid, "best_bid_qty": 1.0,
                       "best_ask_price": ask, "best_ask_qty": 1.0, "transaction_time": t_ms,
                       "event_time": t_ms})
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("X-bookTicker.csv", buf.getvalue())


def test_book_ticker_time_weighted(tmp_path) -> None:
    t0 = 1_700_000_000_000
    # 1 s at 10 bps half-spread, then a 1000-update burst within 1 s at 50 bps, then 98 s at 1 bp.
    bid = [99.9] + [99.5] * 1000 + [99.99]
    ask = [100.1] + [100.5] * 1000 + [100.01]
    t = [t0] + [t0 + 1000 + k // 2 for k in range(1000)] + [t0 + 2000]
    bid.append(99.99)
    ask.append(100.01)
    t.append(t0 + 99_000)
    bid.append(101.0)  # crossed quote dropped
    ask.append(100.0)
    t.append(t0 + 99_500)
    p = tmp_path / "X-bookTicker-2023-11-14.zip"
    _book_zip(p, bid, ask, t)
    snap = read_book_ticker(p)
    assert len(snap) == 100
    assert snap["hs_bps"].iloc[0] == pytest.approx(10.0)
    assert snap["hs_bps"].iloc[1] == pytest.approx(50.0)
    assert np.allclose(snap["hs_bps"].iloc[2:], 1.0, rtol=1e-6)
    s = book_ticker_summary([p])
    assert s is not None and s["source"] == "bookTicker"
    assert s["median"] == pytest.approx(1.0)  # bursts do not dominate
