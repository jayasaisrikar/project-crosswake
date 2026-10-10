# 02 — Data layer production-readiness review

Scope: `src/engine/data/**`, `src/engine/pit/**`, `src/engine/features/**`, `src/engine/universe.py`,
`src/engine/events/**`, `config/universe*.yaml`, `data/cleaned`. This review was read-only: no source, config or data was changed.
Every finding below was checked with in-memory scratch scripts against `data/raw` and `data/cleaned`. No data from
2025-10-01 onward was used for any evaluation. Timestamps after that date were only listed while checking that the data was complete.

## Summary

| # | Severity | Finding |
|---|---|---|
| D1 | **BLOCKER** | `data/cleaned` is stale. It was built *before* the frozen-bar fix in `clean.py`. All 365 "critical" issues come from this. FTT/AGIX perp still trade on fake prices. |
| D2 | HIGH | Funding for frozen or dead perps is never cut: 2,845 FTT events after the freeze and 1,492 EOS events after its last perp bar. |
| D3 | HIGH | PIT revisions are backdated: a re-ingested value replaces the original value at *every* past `t` (verified). |
| D4 | MEDIUM | Redenominations and ticker reuse silently delete the rest of a symbol's history (BNX, COCOS spot, KORU). |
| D5 | MEDIUM | Feature cache key ignores the function code. The parquet and meta writes are not atomic, so a crash can leave duplicate rows. There is no lock. |
| D6 | MEDIUM | Events: `novelty` is computed against items that come *later* in the feed. RSS lists newest first, so this is look-ahead. Publication time is taken at face value, with no latency buffer. |
| D7 | MEDIUM | Download: months that fail are never retried and cleaning ignores the manifest, so a failed month becomes a silent `is_filled` gap. Cached files are never re-checked against the remote CHECKSUM. |
| D8 | LOW | On Windows, writing the sidecar or manifest without `encoding=` fails for non-ASCII symbols (33 manifest "errors" for 币安人生). |
| D9 | LOW | Smaller issues: the `universe_at` lru_cache goes stale; `clean_all` overwrites `audit.json` with a subset; `drawdown_30d` uses a partial window; the integrity validator counts issue *records*, not bars. |

---

## D1 — BLOCKER: the 365 critical integrity issues, explained

**What they are.** `reports/data_integrity.json` (written 2026-10-09 22:44 by `python -m engine.data.integrity` over all 283
symbols) contains 365 critical issues and 124 medium ones. **All 365 critical issues come from the same check**, `frozen`
(`integrity.py:371-374`): 201 perp records and 164 spot records. Each record is one (market, symbol) pair, so the
real number of bars is **416,990**.

**Root cause: the data is stale, not the code.** The frozen-contract rule (`clean.py:129-140`) was added in
commit `9d2b489` (2026-10-10), but every `data/cleaned/bars/*/*.parquet` file is dated 2026-10-09 ~22:36. I re-ran
`clean_bars` in memory on the raw zips with the current code:

| series | `is_filled` in current parquet | `is_filled` after re-clean | unflagged frozen bars after re-clean |
|---|---|---|---|
| perp FTT | 0 | **34,003** | 0 |
| perp AGIX | 0 | 19,862 | 0 |
| perp LUNA | 120 | 135 | 0 |
| perp BTC | 0 | 1 | 0 |
| spot BTC | 31 | 34 | 0 |

The bar counts are the same before and after (39,117 / 31,738 / 11,280 / 59,160), and no series is truncated. **So the
code fix is correct, but it has never been applied to the data.** Every backtest, the leaderboard and the paper loop still read the unfixed panels.

**The four categories:**

| Category | Records | Bars | Real data problem? |
|---|---|---|---|
| A. **Dead/halted contracts that Binance kept publishing**: FTT perp (frozen from 2022-11-14 05:00 to 2026-09), AGIX/OCEAN (merged into FET in 2024), WAVES, BLZ, REN, UNFI, KLAY, MKR, OMG, REEF, SRM, LINA, STMX, etc. 52 records have n > 50 | 52 | 416,079 | **Yes, critical.** These are untradeable prices that look executable. This is the README §9 FTT bug, now also known to affect about 50 other symbols. |
| B. **Exchange-wide outage hours**: spot 2020-12-21 14:00, 2021-02-11 03:00 and 2023-03-24 12:00; perp 2024-10-28 20:00. Every listed symbol has a flat, zero-volume bar at these hours | about 276 records with n ≤ 3 | about 600 | Real but harmless. The current rule flags them on re-clean. |
| C. **Quiet early-listing hours** (e.g. FTT spot in 2020, 48 bars; FUN, IOTX, BNT) | handful | low hundreds | Real no-trade hours. Flagging them stale is correct. |
| D. **Validator false positives** | 0 found | 0 | The validator's `_frozen_mask` (`integrity.py:305-309`) applies `shift(1)` to the *forward-filled* close, while `clean.py:138` applies it to the *raw* close. A frozen bar that comes right after a gap is therefore counted by the validator but not by the cleaner. In the sampled series this happened 0 times. Theoretical only. |

**Effect on the 16-coin live universe** (`config/universe.yaml`): 32 critical records covering 34,125 bars. Almost all of
them are **FTT perp (34,003)** and LUNA perp (15, the 2022-05-12 halt hours). Each of the other 14 coins has 1 perp bar
(2024-10-28 20:00) and 3 spot bars (the outage hours). EOS has 2 perp bars, the second on 2025-05-21 09:00, its last
bar. The README calls these "mostly small/delisted coins". That is misleading: the 416k-bar bulk is real, and **FTT is in the live universe**.

**Fix (exact):**
1. `uv run python -m engine.data.listings` (or `engine data clean` for the 16 coins) to rebuild `data/cleaned`
   with the current `clean.py`, then `python -m engine.data.integrity` until critical = 0.
2. Re-run baseline/batch results. The README §9 "+8.9% vs +2.7%" FTT claim, and any result that touches FTT or AGIX, are
   invalid until then. Do **not** overwrite `reports/baseline_v0/`; write the new results next to it.
3. Make the validator match the cleaner exactly, to rule out category D: in `integrity.py:308` use
   `c.where(~fil)` (the raw close) for the `shift(1)` comparison, or better, import one shared `frozen_mask` from `clean.py`.
4. Add a guard: store `clean_version` (a hash of `clean.py`) in `audit.json`, and have `load_dataset` warn or fail when it
   does not match. That would have caught this stale-artifact problem.

## D2 — HIGH: funding is not cut for frozen or dead perps

`clean.py:207-209` only drops funding after a *discontinuity* break. It ignores frozen or delisted periods. Verified:
- FTT: **2,845 funding events after 2022-11-14 05:00**, all non-zero (median 0.0001, min −0.025). A carry
  sleeve would see "earnable" funding on a contract that cannot be traded.
- EOS: real perp bars end 2025-05-21 09:00 (the EOS→A rename), but funding runs to 2026-09-30 (1,492 events, all flagged
  "outside listing window"). This is the rename case: the pair keeps publishing under its old name.
- ADA/SOL/FTT/AVAX/DOT: a few funding events *before* the first perp kline (ADA from 2020-01-19, while its first bar is 2020-01-31).
  These are harmless.

**Fix:** in `clean_all`, after cleaning the perp, drop funding events where the perp has no *real* bar (`is_filled == False`) within the
previous 8 h. Also raise `integrity._check_funding` "outside window" from medium to high for live-universe symbols.

## D3 — HIGH: PIT revisions become visible before they were known

`pit/store.py:255-258` says "revisions that become available after t are never visible at t". However,
`adapters.bars_to_pit` (`adapters.py:55-56`) always sets `availability = bar open + 1h`, whatever the
ingestion time. `as_of` filters only on `availability_time`, then picks the latest revision by ingestion time.
Verified in memory: an `is_filled=0` row ingested on 2022-11-14 06:00, then revised to 1 on 2026-10-10, gives
**value 1.0 at `as_of(2022-11-14 07:00)`**. This is backfill look-ahead whenever cleaned data is re-ingested, which D1 requires.
**Fix:** for any row whose key already exists, set `availability_time = max(publication_time, ingestion_time)`.
Alternatively, give `as_of` a `strict=True` mode that also requires `ingestion_time <= t`.

## D4 — MEDIUM: redenominations and ticker reuse delete history

`truncate_at_discontinuity` (`clean.py:84-99`) cuts **everything** after the first open/previous-close jump of more than 90%.
From `audit.json`: spot LUNA was cut at 2022-05-31 (correct: the pair was reused). But spot COCOS was cut at 2021-01-23, about 5 years of
data lost to what looks like a redenomination. BNX spot and perp were cut at 2023-02-22, and KORU perp at 2026-07-15. Symbol renames
(MATIC→POL, EOS→A, AGIX/OCEAN→FET, FTM→S, RNDR→RENDER) are not linked. The old ticker either stops (and is treated as delisted, which is fine)
or keeps publishing frozen bars (D1/D2).
**Fix:** keep a `config/symbol_events.yaml` that lists each split or redenomination (with its ratio) and each rename. Apply
ratio adjustment before break detection, and only truncate for confirmed ticker reuse. Log every truncation as a warning.

## D5 — MEDIUM: feature store cache

- **Invalidation:** the key is `sha256(feature_id:version + input names + columns + hash_pandas_object)` (`features/store.py:35-43`).
  Revised history, new symbols or a new version each trigger a full recompute (correct). But **the function code is not hashed**.
  If someone edits a feature without bumping `calculation_version`, the stale cache is silently served.
  Fix: add `inspect.getsource(fd.function)` to the hash.
- **Hash collisions:** sha256 over the uint64 row hashes is a negligible risk. The dtype is not part of the hash; that does not matter here, because every
  input is float64.
- **Incremental correctness:** the slice starts at `last_ts - (lookback + 24h)`. Lookbacks are large enough for every registered
  feature (`drawdown_30d` 720 h, `funding_z_90evt` 744 h ≥ 90 × 8 h). The only edge case: if a symbol is missing funding events, the incremental
  result could be NaN where a full recompute gives a value. `drawdown_30d` (`base.py:217`) uses `min_periods=1`, so its first
  720 rows are partial windows, which contradicts the module rule ("no partial windows").
- **Concurrent writes / crashes:** `_save` (`store.py:111-119`) writes the parquet, then the meta file, without a temporary file or lock.
  If a crash happens after the parquet write, the meta still has the old `last_ts`/hash. The next incremental run then appends rows that are
  already in the parquet, creating **duplicate records**. Two processes writing at once can interleave in the same way.
  Fix: write both files to `*.tmp`, then `os.replace`. Write meta last and include the parquet's own sha. Use a file lock (`filelock`) per feature_id.
  Dedupe on `(asset, timestamp)` before saving.
- Note: `data/features/` does not exist yet, so none of these problems has happened in practice.

## D6 — MEDIUM: event look-ahead

- `adapters.parse_rss` (`events/adapters.py:72-90`) computes `novelty` against `seen`, which accumulates in **feed order**.
  RSS and Atom feeds list newest first, so an older event's novelty is scored against newer texts: look-ahead.
  The docstring also claims novelty is per asset, but it is not.
  Fix: sort items by `pub` ascending before scoring. Compare only against priors with `pub < this.pub`, and filter by asset.
- `availability = publication = pubDate`, with no latency buffer. `parse_rss` falls back to Atom `updated`, which is an edit time,
  so revised items get a later timestamp while their text was edited later still. Fix: `availability = max(pub, ingestion)` for
  items ingested live; add a fixed delay (e.g. 5 min) before backtest use; prefer `published` and never use `updated`.
- What is correct: `events_available_at` uses strict `<`. Events without a timezone are marked ineligible. Inferred
  listing/delisting events from `from_listings` are marked ineligible (it uses the hindsight `latest` month, but only for context).
  No model reads events today (no consumers outside the CLI), so the risk is latent.

## D7 — MEDIUM: download/clean robustness

What is correct: `_get` retries with exponential backoff (5 tries; 429/418/5xx). The sha256 is checked against Binance's `.CHECKSUM` file.
Writes are atomic (`.part` file, then `replace`). A cached file is re-verified against its local sidecar. ms/µs epochs are detected per value
(`clean.py:25-31`), so the 2025 spot switch to µs is handled. All times are UTC. Bars that are not on the hour are dropped. Duplicate bars
keep the last copy.
Gaps:
- A month with status `error` (network failure or checksum mismatch) is recorded in the manifest and nothing else happens. `clean_all` never reads the manifest,
  so the missing month is forward-filled as `is_filled` hours with no warning. Fix: have `clean_all` fail (or flag the symbol) when the manifest has
  `error` entries for it; add a `download --retry-errors` option.
- Cached zips are never re-checked against the remote `.CHECKSUM`, so files that Binance republishes are never picked up.
- The daily fallback zips (`raw/<kind>/<sym>/daily/`) stay on disk after the monthly file is published. `rglob` reads both, and the
  `keep="last"` dedupe hides it. That works, but it depends on sort order. Delete daily files once the monthly file exists.
- 1000× perp tickers (1000SHIB, 1000PEPE…) have no spot data under the same name. The pairing is silently "spot missing", which is acceptable.

## D8 — LOW: Windows encoding

`download.py:158` (`sidecar.write_text`), `download.py:248` and `clean.py:216` write without `encoding="utf-8"`.
The 33 manifest "errors" are all `UnicodeEncodeError` for the symbol `币安人生`. The zip was written (`replace` happens
before the sidecar write), but it has no sidecar, so it is re-downloaded on every run and reported as an error.

## D9 — LOW

- `pit/universe.py:448` uses `lru_cache` on `_real_bar_opens(root)`. A re-clean within the same process serves stale bars.
- `clean_all` rewrites `data/cleaned/audit.json` with *only* the symbols passed in. Running `engine data clean` (16 coins) after
  `listings` (283) drops the other symbols' `truncated_at`, which D2's funding cut depends on. Fix: merge into the existing file.
- `pit_universe_mask` ends with `& close.notna()`. Close is forward-filled, so a symbol frozen mid-month stays "in universe" until month end.
  Tradability must also check `is_filled`. Verify that the backtester does this (outside this scope).
- The integrity report's `counts` are issue records per (market, symbol), not bars. Report `n` totals as well.
- The README "365 critical" figure comes from the 283-symbol module run. `engine data validate` checks only `universe.yaml` (16 coins → 32 records).

## What is correct

- **PIT availability:** bar availability = open + 1h (close), and funding availability = settlement time (with ms jitter, so it lands conservatively in the next bar).
  `validate_records` checks that availability ≥ publication ≥ event time. Naive timestamps are rejected.
- **`universe_at`:** causal. A symbol needs its first real bar to be available by `t`, plus a real bar within 72 h. Delisted coins are kept
  up to their delisting. Listing months have *month* granularity (`load_listings` → the first day of the month), but rule 3 (first real bar)
  is always stricter, so this cannot leak. `ranked_universe_at` returns `[]` when the last closed bar is missing.
- **`pit_universe_mask`:** ADV, history and staleness are all taken from the bar strictly before the boundary. The candidate set in
  `universe_pit.yaml` is a causal superset (it includes TradFi perps, as documented).
- **Feature causality:** prices are taken only from real bars, rolling windows use `min_periods = window` (except `drawdown_30d`), and funding is taken as of `ts ≤ t`.
  The research CLI cuts features at `h2_last_bar()`.
- **The cleaner's frozen rule** is correct and causal (it uses only `shift(1)`), as verified by re-cleaning above.
