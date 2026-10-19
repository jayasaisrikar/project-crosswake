# External events (point-in-time)

Package: `engine.events`. Store: `data/events/events.jsonl` (append-only, deduped by `event_id`).

## Schema (`engine.events.schema.Event`)

`event_id, source, publication_timestamp, availability_timestamp, ingestion_timestamp, asset,
event_type, importance (0..1), novelty (0..1), sentiment (-1..1), affected_assets, raw_text,
processed_text, backtest_ineligible, ineligible_reason, meta`. All timestamps are UTC.

## No-look-ahead rule

`events_available_at(events, t)` returns only events where
`publication_timestamp < t` **and** `availability_timestamp < t` (strict). With `live=True`,
`ingestion_timestamp < t` is also required. An article published at 14:03:27 is not visible to a
decision at 14:03:00 (nor at 14:03:27 exactly).

Events without a trustworthy publication timestamp (missing, or no timezone) are flagged
`backtest_ineligible` automatically and are never returned by `events_available_at`.

## Adapters

* `from_listings(data/cleaned/listings.json, now)`: infers delistings from kline archive end months.
  The file is month-granular with no announcement time, so all these events are backtest-ineligible
  (context only, e.g. universe audit).
* `parse_rss(xml_text, source, ingestion_ts, universe, *, ingestion_delay=5min, live=False)`: generic
  RSS 2.0 / Atom parser (no network). Publication = RSS `pubDate` / Atom `published`; Atom `updated`
  is an edit time and is never used (an entry with only `updated` is backtest-ineligible).
  `availability = publication + ingestion_delay` (latency buffer, default 5 min); with `live=True`
  availability is also at least `ingestion_ts`. Events are returned oldest first.
  `fetch_rss(url, ..., fetch=callable)` accepts an injected fetcher; the default uses `requests` and is
  meant for local CLI runs only. Tests never touch the network.

## Classification (`engine.events.classify`)

Deterministic keyword rules (no LLM), first match wins: delisting, hack_exploit, regulatory, listing,
maintenance, token_unlock, partnership, funding_rate, macro, other. Each rule sets importance and a
base sentiment, adjusted by positive/negative keywords. Affected assets = whole-word ticker matches
(optionally with USDT/USDC/USD suffix) against a supplied universe. Novelty = 1 - max Jaccard
similarity to texts published STRICTLY EARLIER that share an affected asset (events without assets
compare with earlier asset-less events), plus any `prior_texts` passed in. Feeds list newest first,
so scoring in feed order would be look-ahead (review D6); removing a later item never changes an
earlier item's novelty (tested).
