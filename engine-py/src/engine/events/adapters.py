"""Ingestion adapters.

* ``from_listings``: data/cleaned/listings.json only carries first/last *month* of kline archives,
  i.e. no trustworthy announcement time. Inferred listing/delisting events are therefore emitted
  with ``publication_timestamp=None`` -> backtest_ineligible (context/universe use only).
* ``parse_rss``: generic RSS 2.0 / Atom parser from text (no network); causal novelty and an
  ingestion-delay buffer on availability (see its docstring). ``fetch_rss`` takes an injected
  ``fetch`` callable so tests never touch the network; the default uses requests (local CLI only).
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from email.utils import parsedate_to_datetime
from pathlib import Path

import pandas as pd

from engine.events.classify import classify, novelty
from engine.events.schema import Event, make_event_id

INGESTION_DELAY = pd.Timedelta(minutes=5)  # latency buffer between publication and usable availability


def _parse_ts(s: str | None) -> pd.Timestamp | None:
    if not s or not s.strip():
        return None
    s = s.strip()
    try:
        return pd.Timestamp(parsedate_to_datetime(s)).tz_convert("UTC")
    except (TypeError, ValueError, IndexError):
        pass
    try:
        ts = pd.Timestamp(s)
    except (TypeError, ValueError):
        return None
    if ts.tzinfo is None:  # timezone unknown -> not trustworthy
        return None
    return ts.tz_convert("UTC")


def from_listings(path: Path, now: pd.Timestamp) -> list[Event]:
    data = json.loads(path.read_text(encoding="utf-8"))
    syms: dict[str, dict[str, object]] = data.get("symbols", {})
    if not syms:
        return []
    latest = max(str(v.get("last_month", "")) for v in syms.values())
    out: list[Event] = []
    for asset, v in sorted(syms.items()):
        last = str(v.get("last_month", ""))
        if last and last < latest:
            text = f"{v.get('pair', asset)} perpetual archive ends {last} (inferred delisting)"
            c = classify("delist " + text, [asset])
            out.append(Event(make_event_id("binance_listings", f"delist|{asset}|{last}"), "binance_listings",
                             None, None, now, asset, "delisting_inferred", c.importance, 1.0, c.sentiment,
                             (asset,), text, c.processed_text,
                             ineligible_reason="month-granular archive dates, no announcement time",
                             meta={"last_month": last, "first_month": v.get("first_month")}))
    return out


def parse_rss(xml_text: str, source: str, ingestion_ts: pd.Timestamp, universe: Iterable[str] = (),
              prior_texts: Iterable[str] = (), *, ingestion_delay: pd.Timedelta = INGESTION_DELAY,
              live: bool = False) -> list[Event]:
    """Parse an RSS 2.0 / Atom feed into Events, returned in publication order (oldest first).

    * publication = RSS ``pubDate`` / Atom ``published`` (never Atom ``updated``: that is an edit time
      and the text we hold is the edited one). No trustworthy time -> backtest_ineligible.
    * availability = publication + ``ingestion_delay`` (default 5 min latency buffer); with
      ``live=True`` also >= ``ingestion_ts`` (we cannot act on what we had not fetched).
    * novelty is scored only against items published STRICTLY earlier that share an affected asset
      (items without assets compare against earlier items without assets), plus ``prior_texts``
      (texts already known before this feed). Feeds list newest first, so scoring in feed order
      would be look-ahead (D6).
    """
    root = ET.fromstring(xml_text)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    uni = list(universe)
    priors = list(prior_texts)
    a = "{http://www.w3.org/2005/Atom}"
    parsed = []
    for k, it in enumerate(items):
        def g(*tags: str, _it: ET.Element = it) -> str:
            for t in tags:
                el = _it.find(t)
                if el is not None and el.text:
                    return el.text
            return ""

        title = g("title", f"{a}title")
        desc = g("description", f"{a}summary", f"{a}content")
        link = _it_link(it, a)
        guid = g("guid", f"{a}id") or link or title
        pub = _parse_ts(g("pubDate", f"{a}published"))
        raw = f"{title}\n{desc}".strip()
        parsed.append((pub, k, guid, raw, classify(raw, uni)))
    # oldest first; undated items last (they are ineligible anyway), feed order as tie-break
    parsed.sort(key=lambda x: (x[0] is None, x[0] if x[0] is not None else pd.Timestamp(0, tz="UTC"), -x[1]))
    out: list[Event] = []
    history: list[tuple[pd.Timestamp | None, frozenset[str], str]] = []
    for pub, _k, guid, raw, c in parsed:
        assets = frozenset(c.affected_assets)
        earlier = [txt for (p, aa, txt) in history
                   if pub is not None and p is not None and p < pub and (aa & assets if assets else not aa)]
        nov = novelty(raw, [*priors, *earlier])
        history.append((pub, assets, raw))
        avail = None
        if pub is not None:
            avail = pub + ingestion_delay
            if live and ingestion_ts > avail:
                avail = ingestion_ts
        out.append(Event(make_event_id(source, guid), source, pub, avail, ingestion_ts,
                         c.affected_assets[0] if c.affected_assets else "", c.event_type, c.importance, nov,
                         c.sentiment, c.affected_assets, raw, c.processed_text,
                         meta={"guid": guid}))
    return out


def _it_link(it: ET.Element, a: str) -> str:
    el = it.find("link")
    if el is not None and el.text:
        return el.text
    el = it.find(f"{a}link")
    return (el.get("href") or "") if el is not None else ""


def fetch_rss(url: str, source: str, now: pd.Timestamp, universe: Iterable[str] = (),
              fetch: Callable[[str], str] | None = None, *, ingestion_delay: pd.Timedelta = INGESTION_DELAY,
              live: bool = False) -> list[Event]:
    if fetch is None:
        import requests

        def fetch(u: str) -> str:
            r = requests.get(u, timeout=15)
            r.raise_for_status()
            return r.text

    return parse_rss(fetch(url), source, now, universe, ingestion_delay=ingestion_delay, live=live)
