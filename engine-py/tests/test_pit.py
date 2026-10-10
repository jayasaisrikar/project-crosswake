"""PIT store as_of semantics, adapters, PIT universe and data-quality validator."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd

from engine.pit import (
    PITStore,
    bars_to_pit,
    eligible_at,
    funding_to_pit,
    load_cleaned_to_pit,
    universe_at,
    validate_bars,
    validate_funding,
)

UTC = "UTC"


def ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz=UTC)


def rec(event: str, avail: str, value: float, ingest: str = "2026-01-01") -> dict:
    return {"event_time": ts(event), "publication_time": ts(avail), "availability_time": ts(avail),
            "ingestion_time": ts(ingest), "source": "s", "asset": "BTC", "field": "close", "value": value}


def test_as_of_excludes_future_rows_and_future_revisions() -> None:
    store = PITStore(pd.DataFrame([
        rec("2024-01-01 00:00", "2024-01-01 01:00", 1.0),
        rec("2024-01-01 01:00", "2024-01-01 02:00", 2.0),
        rec("2024-01-01 00:00", "2024-01-01 05:00", 1.5),  # revision published later
    ]))
    a = store.as_of(ts("2024-01-01 01:30"))
    assert a["value"].tolist() == [1.0]
    b = store.as_of(ts("2024-01-01 02:00"))
    assert b["value"].tolist() == [1.0, 2.0]
    c = store.as_of(ts("2024-01-01 05:00"))
    assert c["value"].tolist() == [1.5, 2.0]
    assert (store.as_of(ts("2024-01-01 00:59"))).empty
    wide = store.panel(ts("2024-01-01 05:00"), "close", "s")
    assert wide["BTC"].tolist() == [1.5, 2.0]


def test_parquet_roundtrip(tmp_path) -> None:  # type: ignore[no-untyped-def]
    store = PITStore(pd.DataFrame([rec("2024-01-01", "2024-01-01 01:00", 1.0)]))
    store.to_parquet(tmp_path / "pit.parquet")
    back = PITStore.from_parquet(tmp_path / "pit.parquet")
    pd.testing.assert_frame_equal(back.records, store.records)


def test_rejects_naive_and_inconsistent_times() -> None:
    bad = pd.DataFrame([rec("2024-01-01 02:00", "2024-01-01 01:00", 1.0)])
    try:
        PITStore(bad)
    except ValueError:
        pass
    else:
        raise AssertionError("publication before event must be rejected")


def _bars(start: str, n: int) -> pd.DataFrame:
    t = pd.date_range(start, periods=n, freq="h", tz=UTC)
    px = np.linspace(1, 2, n)
    return pd.DataFrame({"ts": t, "open": px, "high": px * 1.01, "low": px * 0.99, "close": px,
                         "volume": 1.0, "quote_volume": px, "trades": 1.0, "is_filled": False})


def test_bar_adapter_availability_is_bar_close() -> None:
    r = bars_to_pit(_bars("2024-01-01", 3), "BTC", "perp", ts("2026-01-01"))
    assert (r["availability_time"] - r["event_time"] == pd.Timedelta(hours=1)).all()
    store = PITStore(r)
    got = store.as_of(ts("2024-01-01 01:00"), fields=["close"])
    assert got["event_time"].tolist() == [ts("2024-01-01 00:00")]


def test_funding_adapter_available_at_settlement() -> None:
    f = pd.DataFrame({"ts": [ts("2024-01-01 08:00:00.001")], "rate": [1e-4]})
    r = funding_to_pit(f, "BTC")
    store = PITStore(r)
    assert store.as_of(ts("2024-01-01 08:00")).empty
    assert len(store.as_of(ts("2024-01-01 08:00:01"))) == 1


def test_eligible_at_listing_and_delisting() -> None:
    opens = {
        "BTC": pd.date_range("2021-01-01", "2023-01-01", freq="h", tz=UTC),
        "LUNA": pd.date_range("2021-01-28", "2022-05-13 06:00", freq="h", tz=UTC),
        "NEW": pd.date_range("2022-06-01", "2023-01-01", freq="h", tz=UTC),
    }
    # before NEW is listed, LUNA live
    assert eligible_at(ts("2022-05-01"), opens) == ["BTC", "LUNA"]
    # LUNA's last bar (open 06:00) is available at 07:00 -> included at 07:00, not at 06:59 + data gone
    assert "LUNA" in eligible_at(ts("2022-05-13 07:00"), opens)
    assert "LUNA" not in eligible_at(ts("2022-05-20"), opens)       # delisted -> dropped
    # first NEW bar (open 00:00) is available only at 01:00
    assert "NEW" not in eligible_at(ts("2022-06-01 00:30"), opens)
    assert "NEW" in eligible_at(ts("2022-06-01 01:00"), opens)
    # listing-month gate
    listed = {"BTC": ts("2021-01-01"), "LUNA": ts("2021-01-01"), "NEW": ts("2022-07-01")}
    assert "NEW" not in eligible_at(ts("2022-06-15"), opens, listed)


def test_universe_at_from_files(tmp_path) -> None:  # type: ignore[no-untyped-def]
    d = tmp_path / "bars" / "perp"
    d.mkdir(parents=True)
    _bars("2022-01-01", 24 * 30).to_parquet(d / "BTC.parquet")
    _bars("2022-01-01", 24 * 10).to_parquet(d / "LUNA.parquet")
    _bars("2022-01-20", 24 * 5).to_parquet(d / "NEW.parquet")
    _bars("2022-01-01", 24 * 30).to_parquet(d / "NOTLISTED.parquet")
    (tmp_path / "listings.json").write_text(json.dumps({"symbols": {
        "BTC": {"first_month": "2022-01"}, "LUNA": {"first_month": "2022-01"},
        "NEW": {"first_month": "2022-01"}}}), encoding="utf-8")
    assert universe_at(ts("2022-01-05"), root=tmp_path) == ["BTC", "LUNA"]
    assert universe_at(ts("2022-01-21"), root=tmp_path) == ["BTC", "NEW"]
    assert universe_at("2022-01-21", root=tmp_path) == ["BTC", "NEW"]
    store = load_cleaned_to_pit(tmp_path, symbols=["NEW"], markets=["perp"], include_funding=False)
    assert set(store.records["asset"]) == {"NEW"}


def test_validator_flags_issues() -> None:
    b = _bars("2024-01-01", 10)
    assert validate_bars(b).ok
    bad = b.copy()
    bad.loc[2, "close"] = -1.0
    bad.loc[3, "high"] = bad.loc[3, "low"] * 0.5
    bad = pd.concat([bad, bad.iloc[[4]]]).reset_index(drop=True)   # duplicate, out of order
    bad = bad.drop(index=6)                                          # missing hour
    bad.loc[7, "close"] = bad.loc[7, "close"] * 10                   # jump
    rep = validate_bars(bad, "X", "perp")
    checks = {i.check for i in rep.issues}
    assert {"ohlc", "dupes", "order", "missing", "jump"} <= checks
    assert not rep.ok
    naive = b.assign(ts=b["ts"].dt.tz_localize(None))
    assert any(i.check == "tz" for i in validate_bars(naive).issues)
    stale = b.copy()
    stale["is_filled"] = True
    assert any(i.check == "stale" for i in validate_bars(stale, max_stale_hours=5).issues)
    f = pd.DataFrame({"ts": [ts("2024-01-01"), ts("2024-01-01")], "rate": [0.0, 0.2]})
    fr = validate_funding(f)
    assert {"dupes", "funding"} <= {i.check for i in fr.issues}
