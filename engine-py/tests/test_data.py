from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pandas as pd

from engine.data.clean import clean_all, clean_bars, parse_funding_csv, parse_kline_csv
from engine.data.load import load_dataset

H = 3_600_000  # ms per hour
T0 = 1_577_836_800_000  # 2020-01-01 ms


def _row(t_ms: int, price: float, unit: str = "ms", open_: float | None = None) -> str:
    t = t_ms * 1000 if unit == "us" else t_ms
    c = (t_ms + H - 1) * (1000 if unit == "us" else 1)
    o = price if open_ is None else open_
    hi, lo = max(o, price) * 1.01, min(o, price) * 0.99
    return f"{t},{o},{hi},{lo},{price},10,{c},{price * 10},5,1,1,0"


def _csv(rows: list[str], header: bool = False) -> str:
    h = "open_time,open,high,low,close,volume,close_time,quote_volume,count,tbv,tbqv,ignore\n"
    return (h if header else "") + "\n".join(rows) + "\n"


def test_ms_vs_us_detection_and_header():
    ms = parse_kline_csv(_csv([_row(T0, 1.0)], header=True))
    us = parse_kline_csv(_csv([_row(T0, 1.0, unit="us")]))
    assert ms["ts"].iloc[0] == us["ts"].iloc[0] == pd.Timestamp("2020-01-01", tz="UTC")
    assert len(ms) == 1


def test_dedupe_and_sort():
    raw = parse_kline_csv(_csv([_row(T0 + H, 2.0), _row(T0, 1.0), _row(T0 + H, 2.0)]))
    bars, info = clean_bars(raw)
    assert list(bars["close"]) == [1.0, 2.0]
    assert info["duplicates"] == 1


def test_gap_fill_flags_and_no_fill_after_last_bar():
    raw = parse_kline_csv(_csv([_row(T0, 1.0), _row(T0 + 3 * H, 1.5)]))
    bars, info = clean_bars(raw)
    assert len(bars) == 4  # ends at last real bar
    assert list(bars["is_filled"]) == [False, True, True, False]
    filled = bars[bars["is_filled"]]
    assert (filled[["open", "high", "low", "close"]] == 1.0).all().all()
    assert (filled["volume"] == 0).all()
    assert info["max_gap_hours"] == 2 and info["n_filled"] == 2
    assert bars["ts"].iloc[-1] == pd.Timestamp("2020-01-01 03:00", tz="UTC")


def _frozen_row(t_ms: int, p: float) -> str:
    """A halted-contract bar: o=h=l=c=p, zero volume (what Binance published for FTT after FTX)."""
    c = t_ms + H - 1
    return f"{t_ms},{p},{p},{p},{p},0,{c},0,0,1,1,0"


def test_frozen_zero_volume_flat_bars_marked_stale():
    rows = [_row(T0, 1.0), _frozen_row(T0 + H, 1.0), _frozen_row(T0 + 2 * H, 1.0), _row(T0 + 3 * H, 1.2)]
    bars, info = clean_bars(parse_kline_csv(_csv(rows)))
    assert list(bars["is_filled"]) == [False, True, True, False]
    assert info["n_filled"] == 2


def test_quiet_zero_volume_bar_with_range_stays_tradable():
    # Zero volume but a real intrabar range (h>l) is a quiet quote, NOT a frozen contract: keep it tradable.
    quiet = f"{T0 + H},1.0,1.02,0.98,1.0,0,{T0 + 2 * H - 1},0,0,1,1,0"
    bars, _ = clean_bars(parse_kline_csv(_csv([_row(T0, 1.0), quiet, _row(T0 + 2 * H, 1.0)])))
    assert not bool(bars["is_filled"].iloc[1])


def test_bad_ohlc_rows_dropped():
    bad = f"{T0 + H},1,0.5,0.9,1,10,0,10,1,1,1,0"  # high < open
    bars, info = clean_bars(parse_kline_csv(_csv([_row(T0, 1.0), bad, _row(T0 + 2 * H, 1.0)])))
    assert info["bad_rows"] == 1
    assert bool(bars["is_filled"].iloc[1])


def test_luna_style_discontinuity_truncated():
    # genuine crash: each bar opens at the previous close (no discontinuity), falls >90% intra-bar
    prices = [80.0, 40.0, 0.001, 0.0001]
    rows = [_row(T0 + i * H, p, open_=prices[i - 1] if i else p) for i, p in enumerate(prices)]
    rows += [_row(T0 + 100 * H + i * H, 6.0) for i in range(3)]  # new coin reusing the ticker
    bars, info = clean_bars(parse_kline_csv(_csv(rows)))
    assert bars["close"].iloc[-1] == 0.0001
    assert len(bars) == 4
    assert info["truncated_at"] is not None


def test_funding_parse_with_and_without_header():
    a = parse_funding_csv(f"calc_time,funding_interval_hours,last_funding_rate\n{T0},8,0.0001\n")
    b = parse_funding_csv(f"{T0 * 1000},8,0.0002\n")
    assert a["ts"].iloc[0] == b["ts"].iloc[0]
    assert a["rate"].iloc[0] == 0.0001


def _write_zip(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(path.with_suffix(".csv").name, text)
    path.write_bytes(buf.getvalue())


def test_clean_all_and_load_dataset_alignment(tmp_path: Path):
    raw = tmp_path / "raw"
    _write_zip(raw / "spot" / "AAA" / "a.zip", _csv([_row(T0 + i * H, 1.0 + i) for i in range(5)]))
    _write_zip(raw / "spot" / "BBB" / "b.zip", _csv([_row(T0 + i * H, 2.0) for i in range(2, 8)]))
    _write_zip(raw / "perp" / "AAA" / "a.zip", _csv([_row(T0 + i * H, 1.0) for i in range(3)], header=True))
    _write_zip(raw / "funding" / "AAA" / "f.zip", f"{T0},8,0.0001\n{T0 + 8 * H},8,-0.0002\n")
    audit = clean_all(["AAA", "BBB"], raw_root=raw, out_root=tmp_path / "cleaned")
    assert audit["bars"]["perp"]["BBB"]["status"] == "missing"
    assert (tmp_path / "cleaned" / "audit.json").exists()

    ds = load_dataset(tmp_path / "cleaned")
    c = ds.spot.close
    assert list(c.columns) == ["AAA", "BBB"]
    assert len(c) == 8 and str(c.index.tz) == "UTC"
    assert c["BBB"].iloc[:2].isna().all() and c["AAA"].iloc[5:].isna().all()
    assert c["AAA"].iloc[4] == 5.0
    assert ds.spot.is_filled["BBB"].iloc[0]
    assert ds.perp.close["BBB"].isna().all()
    assert list(ds.funding["AAA"]) == [0.0001, -0.0002]

    sub = load_dataset(tmp_path / "cleaned", symbols=["BBB"],
                       start="2020-01-01 03:00", end="2020-01-01 05:00")
    assert list(sub.spot.close.index.hour) == [3, 4, 5]
