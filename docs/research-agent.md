# Automated record: live frontend and the research writer

Two automated workers keep the public site current. Neither touches a signal engine, and
neither writes anything but its own output directory.

| Piece                | Location                                           | Unit                           | Writes                  |
| -------------------- | -------------------------------------------------- | ------------------------------ | ----------------------- |
| Live record contract | `packages/research-runtime/src/public-snapshot.ts` | served by `api` at `/public`   | nothing                 |
| Research writer      | `apps/strategy-research/src/main.ts`               | `crosswake@research-writer`    | `data/public/research/` |
| Article store        | `packages/research-runtime/src/articles.ts`        | served by `api` at `/articles` | nothing                 |

## The live record contract

`publicSnapshot(dataDir)` reads only the engines' own small state files — `collector-health.json`,
`trend/live/*/state.json`, `residual/live/*/health.json`, `momentum/live/*/state.json` and the last
line of `digest/posts.jsonl` — and projects one compact payload (~7 KB) with every time field as an
ISO string. It never reads a journal, never opens a socket and never writes.

Ledger tails are bounded: `tailLedger` reads at most the last 256 KB of a file and tolerates a
stalled final append, so the cost of the endpoint does not grow with the size of `signals.jsonl`.
The endpoint itself sits behind the evidence API's 30-second cache.

`executionEnabled` is projected as `false` from a literal, not from the state files: this record has
no order path anywhere, and the public payload should not be able to drift from that.

## The research writer

`apps/strategy-research` turns the frozen research record into public articles. The fact sheet is
built from `configs/research-topics.json` (curated from the changelog and the on-disk test reports)
plus, for topics that name `engines`, a live block projected from the same snapshot the site reads.

The model is `RESEARCH_WRITER_MODEL`, falling back to `RESEARCH_MODEL` — the Go subscription's free
ids by default. Three rules keep an article honest:

1. **The prompt carries an explicit list of allowed numbers**, extracted from the fact sheet.
2. **`checkArticle` rejects any draft that uses a number outside that list**, along with advice
   language, a body under 900 characters, or fewer than three `##` sections. One retry is allowed,
   with the rejection reason fed back.
3. **Anything that still fails falls back to `templateBody`** — the facts themselves, which passes
   the gate by construction. A templated article is visibly duller, and that is the intended
   failure mode: the record may be terse, but it may not be wrong.

Each pass hashes the fact sheet. A topic is skipped unless its hash or the configured model changed,
so a steady state costs zero model calls. `generator` on every article records the model, the gate
that produced it (`model` or `template`) and the fact-sheet hash, and the article page prints them.

The whole pass is bounded: one model call per changed topic, a 90 s timeout per call, and
`nice -n 10` in `run.sh` keeps it below the engines.

## The frontend

`apps/landing/lib/live.ts` and `lib/articles.ts` are the only places the site talks to the box, and
both degrade to `null` — an unreachable record produces an explanatory panel, never a crash or a
fabricated figure. Two ISR windows control freshness:

- `/research`, `/research/[slug]` and the live snapshot: `revalidate = 600` / 300 s.
- `/sitemap.xml`: `revalidate = 3600`, so new articles enter the sitemap without a redeploy.

`generateStaticParams` returns an empty array on purpose. Prerendering the article list at build
time would make every Vercel build depend on the box being up; instead each page renders on first
request and is then cached. New articles therefore appear without a deploy.

The landing page needs `RESEARCH_API_BASE` and `RESEARCH_API_TOKEN` (server-side only). Without
both, the live panels say the record could not be read and `/ask` answers 503.

## Deploy wiring

A new unit has four touches, and skipping any of them is silent:

- `deploy/oci/services.sh` `ALL` — so status/restart/limits see it.
- `deploy/oci/run.sh` — the command, with `RESEARCH_TOPICS=` named inline so that a change to
  `configs/research-topics.json` restarts the unit. The app reads that file once at startup.
- `deploy/oci/update.sh` `units_for_app` — `strategy-research) echo research-writer`. Without it a
  commit touching only `apps/strategy-research/` derives an empty restart set.
- `bash deploy/oci/limits.sh` after the first deploy; a fresh unit reports `infinity` limits until
  it runs.

`update.sh` maps packages to apps generically, so a change to `packages/research-runtime/` reaches
`research-writer` without further wiring.

The first deploy of this unit needs `bash deploy/oci/services.sh enable research-writer`: the unit
does not exist yet, and `update.sh` only restarts units it can already reach.

## Configuration, cost and rate limits

Nothing about the writer is fixed in code. Every operational value is an environment variable with a
documented default, and the model is never defaulted to anything:

| Variable                                                    | Default         | Effect                                                                    |
| ----------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| `RESEARCH_WRITER_MODEL`                                     | none            | Model id. Unset means template-only articles, never an inherited paid id. |
| `RESEARCH_WRITER_INTERVAL_MS`                               | 6 h             | Minimum time between passes, enforced from the state file.                |
| `RESEARCH_WRITER_MAX_CALLS_PER_PASS`                        | 3               | Hard cap on model calls in one pass.                                      |
| `RESEARCH_WRITER_COOLDOWN_MS`                               | 1 h             | Cool-down after a throttle, auth or quota error.                          |
| `RESEARCH_WRITER_TIMEOUT_MS`                                | 90 s            | Per-call abort.                                                           |
| `RESEARCH_WRITER_ATTEMPTS`                                  | 2               | Model calls per topic, at most.                                           |
| `RESEARCH_WRITER_MIN_BODY` / `_MAX_BODY` / `_SECTION_FLOOR` | 900 / 14000 / 3 | Draft gate.                                                               |
| `RESEARCH_TOPICS`, `CROSSWAKE_DATA`                         | repo defaults   | Topic file and data root.                                                 |

The model can also be named in `defaults.model` inside the topic file. It deliberately does **not**
inherit `RESEARCH_MODEL`: that variable is shared with the record agent, so inheriting it would let a
paid id start spending on article generation without anyone choosing it.

Four mechanisms keep model calls down, in order of how often they fire:

1. **The fact-sheet hash.** A topic is skipped unless its facts or the configured model changed, so a
   steady state makes no calls at all. Running marks are deliberately excluded from the live facts:
   they drift with the market, so quoting them would both date the prose and force a call on every
   pass for no new information.
2. **The pass interval and cool-down**, read from `data/public/writer-state.json`. A restart, a crash
   loop or a manual `--once` inside the interval skips the pass instead of paying for it again.
3. **The per-pass call cap.** Topics are visited in file order and the pass stops at the cap, so a
   cold start with every topic changed spreads across passes rather than firing all of them at once.
4. **Throttle detection.** A 429, quota, auth or payment error aborts the whole pass and parks the
   unit for the cool-down window, instead of marching through the remaining topics collecting more
   failures. The error is stored so `pass_skipped` says why.

## Running it locally

```bash
# a copy of the box's small state files, not the journals
CROSSWAKE_DATA=/tmp/cw-live/data RESEARCH_WRITER_MODEL=opencode/longcat-2.5-preview-free \
  npx tsx apps/strategy-research/src/main.ts --once
CROSSWAKE_DATA=/tmp/cw-live/data RESEARCH_WRITER_MODEL=... \
  npx tsx apps/strategy-research/src/main.ts --once --slug what-the-live-record-shows
CROSSWAKE_DATA=/tmp/cw-live/data npx tsx apps/strategy-research/src/main.ts --once --dry-run --force
```

`--force` bypasses the interval skip and the hash check; `--dry-run` never writes.

Then serve the API against the same directory
(`RESEARCH_API_TOKEN=local-dev-token DATA_DIR=/tmp/cw-live/data npx tsx apps/api/src/main.ts`) and
run the landing app with `RESEARCH_API_BASE=http://127.0.0.1:4112` and the matching token.

`tests/strategy-research.test.ts` covers the corpus, the number gate, the fallback, the article
store's failure modes and the snapshot projection. It asserts the invariant that matters most: the
deterministic fallback always passes its own gate, with live lines and without them.

## Not verified

- No article has been published from the box yet; the writer has only been exercised locally against
  a copy of the live record.
- The gate rejected roughly one draft in three in local runs, so templated articles are expected in
  practice rather than exceptional. The rate has not been measured over weeks.
- The throttle path has not been triggered against a real 429 — only the detector is tested.
- Nothing here has been checked against a search console: the structured data, canonicals and
  sitemap are correct by construction but not yet observed crawled.
