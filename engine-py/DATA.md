# DATA — point-in-time layer (`engine.pit`)

All timestamps are tz-aware UTC. Cleaned inputs follow the layout in `src/engine/contracts.py`
(`data/cleaned/bars/{spot,perp}/{SYM}.parquet`, `data/cleaned/funding/{SYM}.parquet`). Nothing in
this layer synthesizes data: adapters convert only rows that exist in `data/cleaned`.

## PIT record schema (`engine.pit.store`)

| column | meaning |
|---|---|
| `event_time` | time the fact refers to (bar OPEN; funding settlement ts) |
| `publication_time` | when the source published it (>= event_time) |
| `availability_time` | when a decision may use it (>= publication_time) |
| `ingestion_time` | when it was written to the store (audit only) |
| `source` | `binance_perp`, `binance_spot`, `binance_funding` |
| `asset` | base symbol (`BTC`) |
| `field` | `open/high/low/close/volume/quote_volume/is_filled` or `funding_rate` |
| `value` | float64 (`is_filled` stored as 0/1) |

Key = (`source`, `asset`, `field`, `event_time`). A key may carry several revisions.

`PITStore.as_of(t)` returns only rows with `availability_time <= t` and, per key, the latest revision
known at t (ordered by availability, then publication, then ingestion time). Revisions available
after t are invisible at t. By default `ingestion_time` is NOT used as a filter: a first-time
historical backfill is ingested today but was available at `availability_time`.

**Revisions (review D3).** `PITStore.append` treats a row whose key already exists with a different
value as a revision and sets its `availability_time = max(availability_time, ingestion_time)`, so a
re-clean (e.g. FTT bars re-flagged `is_filled` in 2026) never becomes visible at a 2022 `t`.
Re-ingesting an unchanged value is a no-op. `as_of(t, strict=True)` (and `panel(..., strict=True)`)
additionally requires `ingestion_time <= t`: use it to replay what a live process actually held.

## Availability rules

| data | event_time | availability_time |
|---|---|---|
| hourly bar | bar open ts | open + 1h (bar close) |
| funding | settlement ts as stamped (ms jitter kept) | settlement ts |
| revision of an existing key | as above | max(rule above, ingestion_time) |

## Cleaning rules (`engine.data.clean`) — rebuilt 2026-10-10 after review 02 (D1-D9)

* **Frozen bars.** One function, `clean.frozen_mask`, defines a frozen-contract bar: present in the
  archive, zero volume, o=h=l=c equal to the previous *present* close. The cleaner flags these
  `is_filled`; `engine.data.integrity` calls the same function on the panel (raw close = close of
  real bars), so the validator and the cleaner cannot disagree (review D1, category D).
* **Funding on dead perps (D2).** `clean.cut_dead_funding` keeps a funding event only if a REAL perp
  bar opened in `[ts - 8h, ts]`. This removes funding on frozen/halted contracts (FTT after
  2022-11-14), after a perp's last real bar (EOS after the EOS->A rename), before its first bar, and
  after a discontinuity split. The validator reports any remaining such event as `high`.
* **Discontinuities (D4).** A >90% open-vs-previous-close jump no longer deletes history:
  - verified redenominations (`engine.data.symbol_events.REDENOMINATIONS`: COCOS spot 2021-01-23
    x1000, BNX spot 2023-02-22 x0.01, BNX perp 2023-02-22 x0.01) are rescaled into new units
    before break detection (prices x ratio, base volume / ratio) and the series stays whole;
  - any other break splits the series: segment 0 stays the symbol's main series, later segments
    are written to `data/cleaned/segments/{market}/{SYM}.{k}.parquet` (not loaded by
    `load_dataset`) and listed in `audit.json` (`discontinuities`, `segments_kept_aside`). Confirmed
    ticker reuse (LUNA spot 2022-05-31) is tagged `ticker_reuse`, the rest `unconfirmed` (warning).
  - renames (`symbol_events.RENAMES`) are listed only where `listings.json` shows the old archive
    ending in the same month the new one starts: MATIC->POL (2024-09), EOS->A (2025-05),
    RNDR->RENDER (2024-07). AGIX/OCEAN->FET, FTM->S, MKR->SKY are NOT listed: their old archives keep
    publishing frozen bars, so the hand-over is not verifiable from the archive; the frozen rule
    handles their dead tails. Renamed tickers stay separate symbols (no price splicing).
* **Download gaps (D7).** `download_all` retries failed files (`retry_rounds`, default 2);
  `download.retry_manifest_errors()` re-fetches every `error` entry of `data/raw/manifest.json`;
  `verify_remote=True` re-checks cached zips against the remote `.CHECKSUM`. `clean_all` reads the
  manifest and records months that failed and are missing on disk as `failed_months` (warning +
  validator `high`) instead of silently forward-filling them. Daily fallback zips are ignored for
  months that have a monthly zip.
* **Encoding (D8).** Every text file is read/written as UTF-8 (manifest, sidecars, audit).
* **audit.json (D9 + D1 guard).** `clean_all` merges its per-symbol entries into the existing
  `audit.json` instead of overwriting it. Every entry carries `clean_sha256` = sha256 of `clean.py` +
  `symbol_events.py` (`clean.clean_code_hash()`); `meta` adds `code_version` (git short sha) and
  `built_at`. `load_dataset` warns and `engine data validate` / `python -m engine.data.integrity`
  report a **critical** `clean_version` issue when any requested symbol was built by different
  cleaner code. Rebuild with `engine data clean` (16 coins) or
  `python -m engine.data.listings --skip-discovery` (all candidates).
* Integrity reports now carry `bar_counts` (sum of affected bars/events per severity) next to
  `counts` (issue records).

## PIT universe (`engine.pit.universe`)

`universe_at(t)` — asset eligible iff: in listings.json candidates with cleaned bars; listing month
started by t; first real bar available by t; and a real bar available within the last
`stale_hours` (72) before t. Delisted assets (e.g. LUNA, last real bar 2022-05-13 06:00) stay
eligible up to delisting and drop out after the stale window. The rule never consults today's
survivor list. FTT perp: after the 2026-10-10 rebuild its post-2022-11-14 bars are frozen
(`is_filled`), so it drops out 72h after its last real bar (data-driven, not overridden). The bar
cache is keyed on the files' (name, mtime, size), so a re-clean in the same process is picked up.

`ranked_universe_at(md, t, **rules)` applies `engine.universe.pit_universe_mask` (top-N by trailing
ADV) to data truncated at the last bar closed by t.

## Data quality (`engine.pit.quality`)

Extends `engine.data.integrity` (same `Issue` / `IntegrityReport`; `ok` = no critical/high issue).

* `validate_bars(df)` — tz (naive / non-UTC), null ts, non-monotonic, duplicates, hour alignment,
  missing hours, missing prices, non-finite or <= 0 prices, high < low, high/low not bracketing
  open/close, negative volume, longest stale (`is_filled`) run, outlier jumps (|log ret| > ln 3
  between real bars).
* `validate_funding(df)` — tz, order, duplicates, null/non-finite rates, |rate| > 5%.
* `validate_dataset(data)` — `check_dataset` + stale-run and jump checks on the wide panels.

## Research boundary

H2 (>= 2025-10-01) is sealed (`engine.research.contract`). This layer only stores and serves data;
any research evaluation must stay on data < H2_START.
