# Crosswake status

Updated 6 October 2026, 18:00 IST. This records engineering delivery and observed evidence separately. See [implementation plan](implementation-plan.md) and [completion checklist](completion-checklist.md).

## Current state

The remaining local MVP engineering is implemented: public Spot ingestion/history, causal research and paper calculations, frozen evaluation/holdout, the approved Mastra research runtime, restart recovery, robustness/cost reports, altFINS cache, operations reporting and the evidence dashboard. Local software verification passes. The system is collecting BTC/ETH/SOL continuously and the dashboard is available at http://127.0.0.1:3000.

Acceptance is not complete. Provider credentials are absent; real altFINS and model/delegation calls remain unverified. Collection has not completed a qualified 24h reliability run. Frozen prospective evaluation, statistically qualified forward paper, incremental context contribution and expanded-universe capacity need actual evidence. No profitable strategy or >55% net OOS win rate has been demonstrated. Futures and exchange orders are Phase 2 and are not implemented or authorized.

## Confirmed decisions and architecture

- Binance Spot; long-only executable paper validation, separate short research observations.
- Public Binance archives plus local trade/BBO and 1-second research history. No institutional tick feed assumed.
- Canonical Markdown in docs; the premium source document remains a reference. User decisions govern implementation.
- Mastra AgentController (formerly Harness) hosts the Research Supervisor, named persistent sessions, investigate/experiment/review modes, permission policies and constrained specialists. Mastra Workflows orchestrates deterministic experiments. Calculations, statistics, costs, walk-forward selection and metrics remain pure TypeScript.
- Provider/model configuration comes from environment variables. Optional project-root .env.local is loaded by collector, context, Supervisor, experiment and API commands; no paid inference occurs automatically.
- SDKs are pinned: core 1.74.0, libsql 1.25.0, memory 1.35.0. AgentController is beta; upgrades require verification.

## Stage tracker

| Area                    | Engineering                                                                                                        | Acceptance still open                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Foundation/docs         | Implemented; 21 workspace projects                                                                                 | Git remote configured (jayasaisrikar/project-crosswake, main); local code committed and pushed 6 Oct |
| Spot collection/history | Journals, Parquet/hash manifests, bounded writes, archive checksums/import/replay                                  | Qualified 24h run and larger-universe capacity                                                       |
| Quant/signals           | Prior-only fits, BTC impulses, transparent candidates/rejects, relationship reports and lag controls               | Stable relationship/strategy edge across unseen periods                                              |
| Paper/costs             | Delayed eligible quote fills, fees/slippage, exposure, gap reporting, fixed horizons and cost/size stress          | Empirical fill/cost calibration; BBO lacks depth/queue data                                          |
| Frozen evaluation       | Chronological selection, unseen blocks, boundary purge and one-use holdout provenance                              | Prospective data and statistical gates; holdout not consumed                                         |
| Forward recovery        | Exact acknowledged-step reconstruction of model, pending entries, positions and event IDs; single-writer lock      | Qualified forward-paper reconciliation against frozen deployment                                     |
| Mastra runtime          | Persistent session/thread/mode/messages, constrained tools/delegation, libSQL snapshots and deterministic Workflow | Real model and specialist invocation with provider credentials                                       |
| Context                 | Documented altFINS screener adapter, validated cache, receipt-time provenance/hash/expiry                          | Real subscription response; incremental OOS contribution before strategy influence                   |
| Evidence UI             | Loopback read-only API and Next.js dashboard rebuilt 7 Oct on Watermelon base plus Cult motion pieces              | Populated prospective strategy evidence                                                              |
| Operations              | Explicit wall-clock interval and universe; downtime stays in denominator; sampled health/disk reports              | Sustained 24h coverage, disk growth and capacity measurements                                        |

## Verification completed

- All 57 tests passed on Node 24.21.0. Subsequent collector-lock verification also passed the transport integration test. Root and dashboard TypeScript checks, production dashboard build, formatting and frozen-lockfile installation passed across 21 workspace projects.
- The actual collector integration forces a WebSocket disconnect/reconnect, compares persisted snapshots with raw recovery, refuses a competing collector, launches again in the same directory and verifies its chained paper replay. A separate synthetic nonempty-position test restores an interrupted paper session exactly and rejects tampering.
- Mastra tests verify session exclusion, persisted thread/mode/messages, explicit interruption, reapplied permissions, constrained delegation, registry path rejection, read-only API behavior and report integrity/non-overwrite. Workflow outputs match the pure evaluator on fixtures. Deterministic execution requires no LLM; fixtures do not establish alpha.
- New research tests cover known lag recovery, deterministic maximum-grid block-shuffle diagnostics, shifted clocks, long/short fixed-horizon separation and gap censoring, prior-only capacity/volatility costs and stress accounting. Position-path gaps fail the evidence gate.
- Context tests cover receipt availability, expiry, integrity, missing credentials and authentication failure without persisting the key. The documented screener page shape is checked; real subscription calls remain pending.
- Operations CLI fixtures verify that one observed second cannot stand in for a 24h run and that counter deltas exclude pre-window totals. Evidence reads reject interior corruption while tolerating an incomplete trailing append.
- Browser inspection verified the live dashboard at desktop and 375px phone width with no horizontal overflow, protocol detail/escape behavior, Ctrl/Cmd+K and arrow navigation, and empty experiment/context states. The initial production browser check had zero errors/warnings. A deliberate API outage then produced the expected 503 responses and visible recovery message; normal refresh recovered after the API restarted. Screenshots are under output/playwright.
- Real restarted-session replay: 121 current-session steps matched exactly after reconstructing its predecessor. SHA256: f9c8ee1eeac82a9e6783790e918716dcc3efe461ab4d013a6e9af447a79bd9d8. Artifact: data/restart-parity-v005/parity.json.
- A real exploratory run processed 22,410 snapshots and produced the new relationship/horizon/cost reports. It had zero candidates/trades and null performance metrics. Artifact: data/backtests/mvp-completion-v005. This is plumbing evidence, not OOS validation.
- Historical ADAUSDT 1 October import previously verified 176,139 trades and 86,400 one-second rows; checksummed cache reruns reproduced the completed import. Archives lack BBO and cannot produce quote-backed executable fills.

## Running processes and operational findings

The 5 October collector session (PID 32337) died around 00:45 IST on 6 October after its health file recorded 152,339 cumulative late events under the seven-second allowance. No process was listening on 3000/4112 at 16:12 IST on 6 October; dashboard and evidence API were down. The stale `data/collector.lock` was inspected (owner PID dead) and cleared, and collection was restarted at ~17:55 IST on 6 October as PID 41418 with a fresh 2026-10-06 journal. At 18:00 IST: connected, 19,761 cumulative shadow steps, zero late/rejected events in the new launch, no candidates/trades. Actual state is in data/collector-health.json and PID in data/collector.pid. Verify PID/command before stopping; normal shutdown releases the lock. After a crash inspect the process before removing a stale lock.

Historical backfill on 6 October added BTC/ETH/SOL spot trade archives for 2–4 October (nine day-imports, checksummed, markers under data/archives). Quality report over the historical source shows 259,200 expected buckets with zero missing; quoteFraction is 0 throughout because archives carry no BBO, so these inputs remain exploratory-only and cannot produce quote-backed executable fills. Exploratory backtest over 777,600 historical snapshots on 7 Oct produced zero candidates and zero trades; btcEventCount counts impulse IDs attached to fills, so archive runs without BBO-backed fills structurally yield null metrics rather than a market verdict.

Latest follow-up at 20:21 IST: the collector remained connected with no storage failure/rejected payloads, but accumulated 324 late events under the seven-second allowance. This is an unresolved reliability finding; the allowance has not passed the operational gate. Current health counters take precedence over the earlier launch snapshot.

The two-second-allowance predecessor PID 21724 ended with 11,765 late events and 3,240 paper steps. Its final health is preserved in data/pre-recovery-final-health.json. Trade receipt jitter reached approximately 5.9 seconds during inspection. The new default closure allowance is seven seconds; it adds processing/decision latency and does not repair earlier snapshots or guarantee future reliability. Migration/rebuild gaps remain in wall-clock coverage. The latest resumed collector is running the final locked build.

The operations report for the restarted session covers 21.1 hours to 09:36 UTC on 7 Oct with passed24HourGate=false: 76,113 of 76,132 expected seconds stored but only ~49% complete buckets, 125 disconnects with a median 135-second reconnect gap and multi-hour overnight gaps consistent with the laptop sleeping, and a 1,039-second maximum closure delay. The 24h gate requires a fresh sustained run with the machine kept awake; the first live Supervisor investigate session ran 7 Oct on the free model and confirmed 96k shadow steps with zero candidates and an unfrozen two-relationship engine.

Dashboard production server: http://127.0.0.1:3000. Evidence API: http://127.0.0.1:4112. Both bind loopback. The laptop must remain awake and connected for ongoing collection. No automatic restart service is installed.

## Open evidence gates

1. Real altFINS snapshot verified 7 Oct with a local key (BTC/ETH/SOL 4h screener, receipt-timestamped, hashed, 15-minute expiry; served as available through the evidence API). OpenCode Go model path verified 7 Oct: RESEARCH_MODEL=opencode/longcat-2.5-preview-free (free tier, chat protocol) resolves to the gateway, live inference smoke-tested, supervisor constructs cleanly. Non-free IDs use the Responses protocol. Never put keys in conversation or Git. The local deterministic paths remain usable without them.
2. Run a fresh sustained 24h observation with the seven-second allowance and sampled health. Report complete coverage, late/rejected events, disconnects, sampled memory and disk growth; do not substitute a shorter interval.
3. Accumulate the frozen v001 clocks: October 6–30 UTC walk-forward periods and October 30–31 UTC holdout. Current data is insufficient; the workflow correctly refuses evaluation. At least 500 closed eligible long trades and the declared confidence/expectancy/asset gates are required; dates alone do not establish sufficient samples.
4. Reconcile statistically qualified frozen-model forward paper. Current live mode is adaptive exploratory shadow, and exact restart parity does not establish equivalence to a frozen-fit deployment policy.
5. Measure context's incremental contribution on a separately specified OOS comparison before enabling context scores. Freeze past-only liquidity/universe metadata and assess capacity before expanding toward 20–30 symbols. BTC/ETH/SOL remains the explicit development seed.

Cost models use sampled BBO and past volume/volatility proxies. They cannot establish actual depth, queue priority or impact. MAE/MFE has no observation between missing quotes; gaps are explicit and disqualify statistical acceptance. Lag diagnostics correct their within-window grid only; cross-window/horizon searches need additional controls. Research reports disclose whether the requested window boundary is actually available. Empty samples remain null, never fabricated metrics.

## Implementation log

- Tranche 1: canonical docs and initial ingestion/history foundations.
- Tranche 2: durable journals/replay, ingestion/archive hardening, quant/candidates and exploratory paper. Changed no-trade reference semantics after real observations.
- Tranche 3: frozen protocols, walk-forward/one-use holdout, risk and clock-faithful shadow ledgers. Froze prospective v001; no performance claim.
- Tranche 4: approved Mastra runtime, persistent Supervisor, constrained specialists, deterministic Workflow and read-only API. Provider calls remained unconfigured.
- Tranche 5: completed research/cost diagnostics, fixed horizons, acknowledged restart recovery, altFINS adapter/cache, operations CLI and dashboard. Verified 57 tests/build/browser; migrated the live collector while preserving legacy late-event evidence. Updated canonical docs and run commands.

- 8 Oct 2026, residual v003: implemented 1–4h BTC-relative residual strategy (kline archive import, aligned minute store, anchored causal fits, shared paper simulator, walk-forward, one-use holdout, filter-free study, live REST signals). 16 new tests; 95 total pass. Real walk-forward over Oct 2025–Jul 2026 for 15 symbols failed: spot produced no qualified selections; hedged OOS −43.3 bps/trade (CI [−84, −4]). All 36 variants lost in-sample. Holdout unconsumed. Record: [residual-strategy-v003.md](residual-strategy-v003.md).

## Update protocol

Update after each verified engineering change or new observed result. Required commands and configuration are documented in README.md. Mark acceptance gates complete only when their specified observed evidence is recorded. Code, test and documentation files are committed and pushed to jayasaisrikar/project-crosswake (main); ignored market data, logs, runtime state and credentials remain outside Git. Re-verified 6 October on Node 25.8.2: root typecheck, dashboard typecheck, production dashboard build, formatting and all 57 tests pass.
