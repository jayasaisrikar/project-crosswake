from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from engine.events import Event, events_available_at
from engine.events.adapters import fetch_rss, from_listings, parse_rss
from engine.events.classify import classify, novelty
from engine.events.schema import EventStore

NOW = pd.Timestamp("2026-10-10 15:00", tz="UTC")
RSS = """<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Binance Will Delist FOO (FOOUSDT) Perpetual Contract</title><guid>a1</guid>
<pubDate>Sat, 10 Oct 2026 14:03:27 +0000</pubDate><description>Binance will delist FOO.</description></item>
<item><title>Binance Will List BAR (BAR) with Seed Tag</title><guid>a2</guid>
<pubDate>Sat, 10 Oct 2026 13:00:00 +0000</pubDate></item>
<item><title>Undated rumour about BTC</title><guid>a3</guid></item>
</channel></rss>"""


def _events() -> list[Event]:
    return parse_rss(RSS, "binance_rss", NOW, universe=["FOO", "BAR", "BTC"])


def _by(ev: list[Event], guid: str) -> Event:
    return next(e for e in ev if e.meta["guid"] == guid)


def test_no_lookahead_seconds() -> None:
    ev = _events()
    delist = _by(ev, "a1")
    assert delist.publication_timestamp == pd.Timestamp("2026-10-10 14:03:27", tz="UTC")
    # availability = publication + 5 min ingestion delay
    assert delist.availability_timestamp == pd.Timestamp("2026-10-10 14:08:27", tz="UTC")
    at_1403 = events_available_at(ev, pd.Timestamp("2026-10-10 14:03:00", tz="UTC"))
    assert delist not in at_1403 and [e.event_type for e in at_1403] == ["listing"]
    # strict: not visible at exactly its availability time, visible one second later
    assert delist not in events_available_at(ev, pd.Timestamp("2026-10-10 14:08:27", tz="UTC"))
    assert delist in events_available_at(ev, pd.Timestamp("2026-10-10 14:08:28", tz="UTC"))
    # live mode additionally requires ingestion before t
    assert events_available_at(ev, pd.Timestamp("2026-10-10 14:30", tz="UTC"), live=True) == []


def test_untimestamped_is_ineligible() -> None:
    undated = _by(_events(), "a3")
    assert undated.backtest_ineligible and undated.publication_timestamp is None
    assert undated not in events_available_at(_events(), NOW + pd.Timedelta(days=365))


def test_classifier_rules() -> None:
    ev = _events()
    d, li = _by(ev, "a1"), _by(ev, "a2")
    assert d.event_type == "delisting" and d.sentiment < 0 and d.affected_assets == ("FOO",)
    assert li.event_type == "listing" and li.sentiment > 0
    assert classify("Protocol exploit: $10m drained from ETH bridge", ["ETH"]).event_type == "hack_exploit"
    assert novelty("Binance will list BAR", ["Binance will list BAR"]) == 0.0
    assert novelty("totally new text", ["Binance will list BAR"]) == 1.0


def test_listings_adapter_ineligible(tmp_path: Path) -> None:
    p = tmp_path / "listings.json"
    p.write_text(json.dumps({"symbols": {"OLD": {"pair": "OLDUSDT", "first_month": "2021-01",
                                                 "last_month": "2024-03"},
                                         "BTC": {"pair": "BTCUSDT", "first_month": "2019-09",
                                                 "last_month": "2026-09"}}}))
    ev = from_listings(p, NOW)
    assert [e.asset for e in ev] == ["OLD"] and ev[0].backtest_ineligible
    assert events_available_at(ev, NOW) == []


def test_store_roundtrip_and_fetch_injected(tmp_path: Path) -> None:
    store = EventStore(tmp_path / "events.jsonl")
    ev = fetch_rss("local://x", "binance_rss", NOW, ["FOO", "BAR"], fetch=lambda _u: RSS)
    assert store.add(ev) == 3 and store.add(ev) == 0
    back = store.load()
    assert back[0].publication_timestamp == ev[0].publication_timestamp and back[2].backtest_ineligible


def test_events_in_publication_order_and_causal_novelty() -> None:
    feed = """<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>Binance will list FOO perpetual again</title><guid>new</guid>
<pubDate>Sat, 10 Oct 2026 14:00:00 +0000</pubDate></item>
<item><title>Binance will list FOO perpetual</title><guid>old</guid>
<pubDate>Sat, 10 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>Binance will list BAR perpetual</title><guid>other</guid>
<pubDate>Sat, 10 Oct 2026 09:00:00 +0000</pubDate></item>
</channel></rss>"""
    ev = parse_rss(feed, "x", NOW, universe=["FOO", "BAR"])
    assert [e.meta["guid"] for e in ev] == ["other", "old", "new"]
    # the oldest FOO item is NOT scored against the newer FOO item (feed lists it first), nor against BAR
    assert _by(ev, "old").novelty == 1.0
    assert _by(ev, "new").novelty < 1.0
    # removing the later item never changes an earlier item's novelty
    trimmed = feed.replace(feed[feed.index("<item>"):feed.index("</item>") + 7], "")
    assert _by(parse_rss(trimmed, "x", NOW, universe=["FOO", "BAR"]), "old").novelty == 1.0


def test_atom_uses_published_not_updated_and_live_availability() -> None:
    atom = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>Binance will delist FOO</title><id>e1</id>
<published>2026-10-10T10:00:00Z</published><updated>2026-10-10T12:00:00Z</updated></entry>
<entry><title>Only updated BAR</title><id>e2</id><updated>2026-10-10T12:00:00Z</updated></entry>
</feed>"""
    ev = parse_rss(atom, "atom", NOW, universe=["FOO", "BAR"])
    e1, e2 = _by(ev, "e1"), _by(ev, "e2")
    assert e1.publication_timestamp == pd.Timestamp("2026-10-10 10:00", tz="UTC")
    assert e2.publication_timestamp is None and e2.backtest_ineligible
    live = _by(parse_rss(atom, "atom", NOW, universe=["FOO"], live=True), "e1")
    assert live.availability_timestamp == NOW
