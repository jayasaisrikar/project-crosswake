# Crosswake implementation plan

Updated 5 October 2026. Canonical engineering specification derived from the supplied BTC Transmission Signal Engine v0.3 design and the user's confirmed decisions. User decisions override reference recommendations. No profitability is assumed.

## Objective and scope

Build a local TypeScript system that collects synchronized Binance Spot trades and quotes, measures BTC transmission, and evaluates catch-up signals with chronological replay and realistic costs. Executable MVP validation is long-only paper trading. Store short candidates separately as research observations; never include them in executable win-rate denominators. altFINS is available as timestamped higher-timeframe context. Public Binance archives and locally collected data are the initial history sources.

USDT perpetual futures belong to a subsequent product phase after a stable edge and strictly greater than 55% out-of-sample win rate after costs. Actual execution requires a separate execution and risk design; passing the research gate does not itself authorize orders.

## Architecture and contracts

Use Node 24 LTS, strict TypeScript, pnpm workspaces, Zod, ws, Pino, DuckDB and ZSTD Parquet. Collector and historical CLI share validated domain events and a 1-second aggregator. Later quant and replay modules share the same chronological update rules. A read-only loopback Node HTTP API and Next.js evidence dashboard follow the research pipeline. The implemented API uses Node HTTP instead of Fastify because its small, GET-only surface does not need a framework.

Each trade retains exchange time, local receipt time, venue, market, symbol and trade ID. For live quant returns, use fresh BBO midpoints; a connected, fresh quote can cover a second with no trade while OHLC remains null and volume remains zero. Historical research uses trade close prices and preserves missing seconds. Keep these sources separate. Record bucket closure as availableAt and never simulate a decision before the data was available. Spot bookTicker has no exchange timestamp: mark its clock as receipt time instead of inventing exchange latency. Bucket timestamps represent exclusive UTC close boundaries. Close buckets after a configurable lateness allowance; reject and count late trades. Never forward-fill gaps as complete data. Quotes carried across buckets must pass a freshness limit. Partial startup/shutdown buckets and reconnect intervals remain incomplete.

Persist raw event journals before normalized Parquet. Use bounded, serialized writes, atomic final filenames, manifests and checksums. Partition by venue, market, UTC date and symbol. Keep datasets, secrets and local environments outside Git. A journal is a recovery source; only closed, committed Parquet files are research inputs. Fail collection on storage failure rather than silently dropping data.

Historical trade archives have no contemporaneous BBO. Preserve missing quote/cost evidence as null, use explicit conservative modeled costs for exploration, and label these results separately from quote-backed validation. Candles cannot establish second-scale lag. Timestamp units vary across archive periods; normalize milliseconds and microseconds explicitly. Verify published SHA256 before import, retain source metadata, stream ZIP CSV rows and reject invalid records. A present-day asset universe must not be represented as historically unbiased: freeze eligible symbols per fold from past-only metadata.

## Build stages and acceptance

| Stage                 | Deliverable                                                                                      | Dependencies          | Acceptance evidence                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------- |
| 0 Foundation          | Workspace, domain/config schemas, commands, fixture tests                                        | None                  | Typecheck and deterministic tests pass; no execution keys                                             |
| 1 Collection          | Spot trade/BBO collector, raw journals, 1s Parquet, diagnostics                                  | 0                     | Reconnect, duplicate, stale quote, late event and gap fixtures; 24h run with measured gaps            |
| 2 Historical pipeline | Daily archive download/checksum/import, manifests and replay inputs                              | 0, 1                  | Known timestamp-unit fixture, corrupt checksum rejection, reproducible import, bounded memory         |
| 3 Quant core          | Log returns, rolling covariance/correlation, lagged OLS, residual volatility, lag grid           | 1, 2                  | Synthetic known beta/lag recovered; timestamp shift and shuffled-event controls                       |
| 4 Events and signals  | BTC impulses, frozen pre-event features, reaction gap, liquidity/cost filters, transparent score | 3                     | Repeat replay gives identical events, candidates and rejection reasons                                |
| 5 Backtest            | Delayed BBO fills, exits, costs, exposure constraints, walk-forward and locked holdout           | 4                     | Reproducible frozen runs; no future context/quotes; clustered confidence statistics                   |
| 6 Context             | altFINS adapter and timestamped cache                                                            | 4                     | Freshness/provenance visible; unavailable context does not invent a score; incremental OOS evaluation |
| 7 Evidence UI         | Read-only health/state/research API and Next.js dashboard                                        | 4, 5                  | Inspect every signal, cost, rejection and outcome; UI smoke tests                                     |
| 8 Forward paper       | Persistent signal/outcome ledger and live/replay comparison                                      | 5–7                   | Feed/decision latency measured and paper behavior reconciled                                          |
| Later futures         | Separate perpetual data and execution/risk design                                                | Research gates passed | Explicit approval of execution scope and venue-specific costs/funding                                 |

The first implementation tranche covered stages 0–2. The approved second tranche hardens these pipelines and adds an initial quant, candidate and exploratory paper-backtest implementation. Full walk-forward/holdout validation remains a separate stage. Finish the documents first, then start these stages. Delivery of initial runnable commands is not completion of the 24h collection gate or a claim that alpha exists.

## Research conventions

Start with BTC plus a small configurable Spot universe; expand toward 20–30 liquid USDT assets only after capacity and data quality checks. Exclude stablecoins and duplicates. Keep selection snapshots and inclusion reasons. Estimate returns at 15/30/60/180/300 seconds and correlations at fast/medium/slow windows. Lag grid begins at 1/5/15/30/60/120/180/300 seconds. Features used in a decision must precede its timestamp; event-triggering price may be current, fitted relationship parameters may not.

Define expected asset return and actual return over the same horizon. Regression alpha must use the matching return horizon rather than applying one-second alpha to a 60-second impulse. Freeze event origin and decision time separately. Standardize gaps by residual volatility; penalize unstable relationships and multiple lag searches. Starting thresholds are hypotheses, recorded in versioned configs before tuning.

Store all candidates including rejects, with BTC event ID, feature provenance, model/config versions, long/short direction and executable eligibility. Initially only long catch-up trades enter executable metrics. Model next eligible quote after decision latency, taker fees, spread, slippage on both legs and conservative stress costs. Do not charge spread twice when bid/ask fills already include it. Missing/stale quotes invalidate quote-backed fills. Bound simultaneous exposure per BTC event, not just per asset.

## Validation and go decision

Use chronological exploration, rolling training (initial hypothesis 21–60 days), validation, next unseen test block, a locked final holdout used once, and forward paper observation. Freeze universe, thresholds and lag choices for each unseen block. Define splits before running selection. Public-history exploration is distinct from locally collected quote-backed validation.

Require strictly >55% net OOS win rate, positive net expectancy, profit factor >=1.30, at least 500 closed eligible long trades, acceptable drawdown and consistency across periods/assets. Report wins/losses/flat outcomes, N, Wilson 95% interval, event-cluster bootstrap, MAE/MFE, losing streaks, concentration and precision versus coverage. A weak confidence interval remains inconclusive despite a passing point estimate. Research shorts have their own report. Threshold-sensitive or concentrated results trigger iteration/redesign; never tune the locked holdout.

## Operational gates and testing

Before claiming stage 1 complete, record a 24h run, bucket gap/duplicate/late-event counts, quote freshness, reconnect duration, disk growth and peak memory. Initial proposed completeness target is >=99.5% of expected symbol-seconds during connected operation, reported alongside total wall-clock coverage so outages cannot disappear from the denominator. This operational target is configurable and provisional.

Unit tests cover parsing, clock units, OHLC/flow, deduplication, boundary closure and invalid prices. Integration tests cover archive checksum, Parquet round-trip, storage failure, connection interruption and deterministic replay. Quant/backtest stages add leakage and cost tests before performance claims. Typecheck and tests are required per meaningful code change.

## Sources and implementation notes

Reference: BTC Transmission Signal Engine Technical Design v0.3 supplied DOCX. The source's derivatives WebSocket citation is not the Spot collector contract. Consult Spot documentation instead.

- https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md
- https://github.com/binance/binance-public-data
- https://duckdb.org/docs/stable/clients/node_neo/overview

No premium historical feed, cloud deployment, ML or automated execution in the current tranche. altFINS secrets remain local; the timestamped adapter/cache now follows the base research pipeline. Timing depends on accumulating history and events, so engineering completion and statistical validation have separate status.

## Tranche 3 implementation contract

Frozen research protocols declare variants and chronological folds before evaluation. Validation alone selects variants; relationships refit from past prices at each block start and remain frozen within that block. Boundary purging prevents positions crossing evaluation windows. A qualified walk-forward selection pins pre-holdout provenance; one-use reservations cover overlapping holdout periods and remain consumed after failure.

Live collection runs the same signal/fill primitives in an adaptive exploratory shadow mode with recorded wall-clock decisions. Session replay verifies this mode exactly; it does not establish parity with the frozen-fit evaluation policy. Session endings preserve unresolved position evidence without artificial closing trades. Acknowledged-step replay now restores model and paper state across launches. Synthetic nonempty-position and real restarted-session parity are verified; statistically qualified forward reconciliation remains an acceptance gate.

## Interactive research runtime: Mastra (approved)

Use Mastra AgentController (formerly Harness) as Crosswake's interactive research host. It owns the Research Supervisor, isolated research sessions, conversation threads, research modes, tool permission policies and constrained subagent delegation. Use Mastra Workflows to orchestrate deterministic experiments. Quant estimation, backtest fills, transaction costs, statistics, strategy metrics, evidence gates and walk-forward selection stay in pure TypeScript modules with no model or Mastra dependency. The Supervisor proposes and explains research; computed artifacts remain the numerical authority.

The runtime will expose investigate, experiment and review modes. Investigate/review can read approved local evidence; experiment can invoke the registered deterministic workflow. Specialist delegation is limited to data-quality and evidence review tools. No shell, arbitrary file editing, exchange execution, credentials, or strategy-code generation is exposed to research agents. Holdout consumption remains an explicit human command and retains one-use reservations; agent delegation cannot bypass it.

Persist threads and workflow snapshots in local libSQL under the ignored data directory. Persist host session bindings and research state separately: AgentController's live state, approval grants, pending approvals and active runs do not automatically survive restart. Reapply declared permission policies on session creation; do not silently resume paid model calls or consumed holdouts. Store experiment input/provenance and completed artifacts by run ID, and reconcile interruption explicitly.

Initial implementation: configurable provider/model, local interactive CLI, persistent named sessions, constrained research tools and a deterministic workflow wrapping the existing verified evaluator. Verify session/mode restoration, permissions, subagent allowlists, workflow numerical parity, insufficient-data failure and no-model experiment operation. Then connect the read-only evidence API/dashboard and add remaining statistical/cost robustness work. Model inference requires separately configured credentials; collection and deterministic research remain available without them.

API references checked 5 October 2026: [AgentController](https://mastra.ai/docs/harness/agent-controller), [Workflows](https://mastra.ai/docs/workflows/overview). AgentController is beta; pin exact versions and test upgrades before adopting them.

## Tranche 5 completion contract

Remaining MVP engineering adds 1h/4h/12h relationship reports across 15/30/60/180/300-second return horizons; deterministic block-shuffle maximum-grid and clock-shift diagnostics; separate long/short fixed-horizon labels with incomplete-path/boundary censoring; same-fill cost sensitivity and unseen-fold size stress. Diagnostics are research outputs, not silently tuned entry filters. Within-window lag correction does not control all cross-window/horizon searches or prove independent-event significance.

Optional execution-cost settings use past-only 60-second volume/return histories, a declared notional/participation bound, square-root participation and volatility proxies. Unsupported fills are refused. Bid/ask already embed spread; fees/slippage remain separate. Position-path gaps are reported and fail the evidence gate. These models cannot claim full-depth, queue or actual-market-impact accuracy from BBO data.

Forward paper restores the acknowledged session chain exactly and preserves unresolved positions and decision clocks. Configuration mismatch, malformed records and parity mismatch fail closed. A single-writer lock guards collection. Health records enable wall-clock operations reporting; the requested interval and declared universe define the coverage denominator, including outages. Sampled memory is not an instantaneous peak, and current disk size needs multiple observations for growth.

altFINS snapshots are validated, timestamped at receipt, hashed and expired. Present-day API responses cannot become historical point-in-time features. Context contribution remains disabled until an independently specified OOS comparison supports it. The Next.js workbench consumes the loopback evidence API, exposes signal evidence/rejections and completed experiment costs/metrics/gates, and handles unavailable or empty data.

Engineering checks and browser inspection can complete now. Real provider calls require environment credentials; 24h reliability, prospective folds/holdout, incremental context contribution, expanded-universe capacity and statistically qualified forward paper require observed evidence. These are open acceptance gates and cannot be replaced by fixture tests. Futures and real execution remain Phase 2.

altFINS contract sources: [public API authentication](https://altfins.com/crypto-market-and-analytical-data-api/documentation/api/public-api/), [official CLI and screener examples](https://altfins.com/crypto-market-and-analytical-data-api/documentation/altfins-cli/). Provider response-shape assumptions require verification with the user's subscription.
