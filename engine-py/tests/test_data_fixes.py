"""Regression tests for the data-layer review findings D1-D9 (reports/review/02_data.md)."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from engine.contracts import Dataset, MarketData
from engine.data import clean as clean_mod
from engine.data import download as dl
from engine.data import symbol_events
from engine.data.clean import (
    clean_all,
    clean_bars,
    clean_bars_segments,
    cut_dead_funding,
    failed_months,
    frozen_mask,
    parse_kline_csv,
    stale_symbols,
)
from engine.data.integrity import IntegrityReport, check_dataset
from engine.data.load import load_dataset

H = 3_600_000
T0 = 1_577_836_800_000  # 2020-01-01 ms


def _row(t_ms: int, price: float, open_: float | None = None, vol: float = 10.0, flat: bool = False) -> str:
    o = price if open_ is None else open_
    hi, lo = (price, price) if flat else (max(o, price) * 1.01, min(o, price) * 0.99)
    return f"{t_ms},{o},{hi},{lo},{price},{vol},{t_ms + H - 1},{price * vol},5,1,1,0"


def _csv(rows: list[str]) -> str:
    return "\n".join(rows) + "\n"


def _write_zip(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(path.with_suffix(".csv").name, text)
    path.write_bytes(buf.getvalue())


def _frozen_series(n_live: int = 10, n_frozen: int = 30) -> list[str]:
    rows = [_row(T0 + i * H, 100.0 + i) for i in range(n_live)]
    last = 100.0 + n_live - 1
    rows += [_row(T0 + (n_live + k) * H, last, vol=0.0, flat=True) for k in range(n_frozen)]
    return rows


# ---- D1: one shared frozen rule -------------------------------------------------------------
def test_frozen_mask_shared_and_gap_case() -> None:
    idx = pd.date_range("2020-01-01", periods=5, freq="h", tz="UTC")
    c = pd.Series([1.0, np.nan, 1.0, 1.0, 1.0], index=idx)   # bar 1 absent
    o = h = lo = c.fillna(1.0)
    v = pd.Series([5.0, 0.0, 0.0, 0.0, 3.0], index=idx)
    m = frozen_mask(o, h, lo, c, v)
    # bar 2 follows a gap -> not frozen; bar 3 frozen; bar 4 has volume
    assert list(m) == [False, False, False, True, False]


def test_validator_matches_cleaner_after_gap() -> None:
    """Category D: a flat zero-volume bar right after a gap is NOT frozen for either side."""
    rows = [_row(T0, 100.0), _row(T0 + 2 * H, 100.0, vol=0.0, flat=True), _row(T0 + 3 * H, 101.0)]
    bars, _ = clean_bars(parse_kline_csv(_csv(rows)))
    assert list(bars["is_filled"]) == [False, True, False, False]
    md = _md_from_bars(bars)
    rep = check_dataset(Dataset(spot=md, perp=md, funding=pd.DataFrame()))
    assert not [i for i in rep.issues if i.check == "frozen"]


def _md_from_bars(bars: pd.DataFrame, sym: str = "X") -> MarketData:
    b = bars.set_index("ts")
    f = {k: b[[k]].rename(columns={k: sym}).astype(float)
         for k in ("open", "high", "low", "close", "volume", "quote_volume")}
    return MarketData(**f, is_filled=b[["is_filled"]].rename(columns={"is_filled": sym}).astype(bool))


def test_report_bar_counts() -> None:
    rep = IntegrityReport()
    rep.add("frozen", "critical", "x", n=7)
    rep.add("frozen", "critical", "y", n=3)
    assert rep.counts()["critical"] == 2 and rep.bar_counts()["critical"] == 10
    assert rep.to_dict()["bar_counts"]["critical"] == 10


# ---- D2: funding on frozen / dead perps ----------------------------------------------------
def test_cut_dead_funding_rule() -> None:
    ts = pd.date_range("2020-01-01", periods=48, freq="h", tz="UTC")
    filled = np.zeros(48, dtype=bool)
    filled[10:] = True                     # last real bar opens 09:00
    bars = pd.DataFrame({"ts": ts, "is_filled": filled})
    f_ts = pd.DatetimeIndex(["2019-12-31 20:00", "2020-01-01 08:00:00.001", "2020-01-01 16:00:00.001",
                             "2020-01-01 17:00:00.001", "2020-01-02 00:00:00.001"], tz="UTC")
    fund = pd.DataFrame({"ts": f_ts, "rate": [1e-4] * 5})
    kept, n = cut_dead_funding(fund, bars)
    # before first bar: dropped; 08:00 ok; 16:00 within 8h of 09:00 ok; 17:00 and later dropped
    assert list(kept["ts"]) == [f_ts[1], f_ts[2]] and n == 3
    assert cut_dead_funding(fund, None)[1] == 5


def test_clean_all_drops_funding_on_frozen_perp(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    _write_zip(raw / "perp" / "FTT" / "FTTUSDT-1h-2020-01.zip", _csv(_frozen_series(10, 40)))
    ev = "\n".join(f"{T0 + k * 8 * H + 1},8,0.0001" for k in range(6))   # 00,08,16,24,32,40h
    _write_zip(raw / "funding" / "FTT" / "FTTUSDT-fundingRate-2020-01.zip", ev + "\n")
    audit = clean_all(["FTT"], markets=["perp"], raw_root=raw, out_root=tmp_path / "c")
    fund = pd.read_parquet(tmp_path / "c" / "funding" / "FTT.parquet")
    assert len(fund) == 3            # 00h, 08h, 16h (last real bar opens 09h)
    assert audit["funding"]["FTT"]["removed_no_live_perp"] == 3
    bars = pd.read_parquet(tmp_path / "c" / "bars" / "perp" / "FTT.parquet")
    assert bars["is_filled"].sum() == 40


# ---- D4: redenominations / ticker reuse / renames -------------------------------------------
def test_unconfirmed_break_is_split_not_deleted(tmp_path: Path) -> None:
    rows = [_row(T0 + i * H, 10.0) for i in range(5)] + [_row(T0 + (5 + i) * H, 0.05) for i in range(5)]
    raw = tmp_path / "raw"
    _write_zip(raw / "spot" / "ZZZ" / "ZZZUSDT-1h-2020-01.zip", _csv(rows))
    audit = clean_all(["ZZZ"], markets=["spot"], raw_root=raw, out_root=tmp_path / "c")
    e = audit["bars"]["spot"]["ZZZ"]
    assert e["n_bars"] == 5 and e["discontinuities"][0]["kind"] == "unconfirmed"
    seg = pd.read_parquet(tmp_path / "c" / "segments" / "spot" / "ZZZ.1.parquet")
    assert len(seg) == 5 and seg["close"].iloc[0] == 0.05


def test_verified_redenomination_rescaled(monkeypatch: pytest.MonkeyPatch) -> None:
    t_ev = pd.Timestamp(T0 + 5 * H, unit="ms", tz="UTC")
    monkeypatch.setattr(symbol_events, "REDENOMINATIONS",
                        (symbol_events.Redenomination("spot", "RRR", t_ev, 1000.0),))
    rows = [_row(T0 + i * H, 0.01) for i in range(5)] + [_row(T0 + (5 + i) * H, 10.0) for i in range(5)]
    out, info, later = clean_bars_segments(parse_kline_csv(_csv(rows)), market="spot", symbol="RRR")
    assert len(out) == 10 and not later and info["discontinuities"] == []
    assert out["close"].iloc[0] == pytest.approx(10.0) and info["redenominations"][0]["ratio"] == 1000.0
    assert out["volume"].iloc[0] == pytest.approx(0.01)


def test_symbol_events_verified_from_local_data() -> None:
    assert symbol_events.successor("MATIC") == "POL" and symbol_events.successor("BTC") is None
    p = Path("data/cleaned/listings.json")
    if not p.exists():
        pytest.skip("no local listings.json")
    lst = json.loads(p.read_text(encoding="utf-8"))["symbols"]
    for r in symbol_events.RENAMES:
        assert lst[r.old]["last_month"] == r.month == lst[r.new]["first_month"], r
    assert symbol_events.is_ticker_reuse("spot", "LUNA", pd.Timestamp("2022-05-31 06:00", tz="UTC"))


# ---- D7: manifest failures and daily fallbacks ----------------------------------------------
def test_failed_months_flagged_and_daily_superseded(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    _write_zip(raw / "spot" / "AAA" / "AAAUSDT-1h-2020-01.zip",
               _csv([_row(T0 + i * H, 1.0) for i in range(3)]))
    # a daily file of the same month must be ignored once the monthly exists
    _write_zip(raw / "spot" / "AAA" / "daily" / "AAAUSDT-1h-2020-01-01.zip", _csv([_row(T0, 999.0)]))
    man = {"files": [{"kind": "spot", "symbol": "AAA", "period": "2020-02", "status": "error", "url": "u"},
                     {"kind": "spot", "symbol": "AAA", "period": "2020-01", "status": "error", "url": "u"}]}
    (raw / "manifest.json").write_text(json.dumps(man), encoding="utf-8")
    assert failed_months(raw, "spot", "AAA") == ["2020-02"]
    assert len(clean_mod._raw_zips(raw, "spot", "AAA")) == 1
    audit = clean_all(["AAA"], markets=["spot"], raw_root=raw, out_root=tmp_path / "c")
    assert audit["bars"]["spot"]["AAA"]["failed_months"] == ["2020-02"]
    rep = check_dataset(load_dataset(tmp_path / "c"))
    assert any(i.check == "download" and i.severity == "high" for i in rep.issues) and not rep.ok


# ---- D8: utf-8 sidecar / manifest ----------------------------------------------------------
def test_unicode_symbol_manifest_roundtrip(tmp_path: Path) -> None:
    r = dl.FileResult(kind="spot", symbol="币安人生", period="2025-10", url="u", path=None, status="error")
    dl.write_manifest([r], tmp_path / "manifest.json")
    back = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert "spot/币安人生" in back["summary"]


# ---- D9 + D1 guard: audit merge and code version -------------------------------------------
def test_audit_merges_and_detects_stale_code(tmp_path: Path) -> None:
    raw = tmp_path / "raw"
    for s in ("AAA", "BBB"):
        _write_zip(raw / "spot" / s / f"{s}USDT-1h-2020-01.zip",
                   _csv([_row(T0 + i * H, 1.0 + i) for i in range(3)]))
    out = tmp_path / "c"
    clean_all(["AAA", "BBB"], markets=["spot"], raw_root=raw, out_root=out)
    audit = clean_all(["AAA"], markets=["spot"], raw_root=raw, out_root=out)
    assert set(audit["bars"]["spot"]) == {"AAA", "BBB"}            # merged, not overwritten
    assert audit["meta"]["clean_sha256"] == clean_mod.clean_code_hash()
    assert stale_symbols(out) == []
    assert check_dataset(load_dataset(out)).ok
    # simulate data built by an older cleaner
    a = json.loads((out / "audit.json").read_text(encoding="utf-8"))
    a["bars"]["spot"]["BBB"]["clean_sha256"] = "old"
    (out / "audit.json").write_text(json.dumps(a), encoding="utf-8")
    assert stale_symbols(out) == ["BBB"]
    rep = check_dataset(load_dataset(out))
    assert not rep.ok and any(i.check == "clean_version" and i.severity == "critical" for i in rep.issues)
