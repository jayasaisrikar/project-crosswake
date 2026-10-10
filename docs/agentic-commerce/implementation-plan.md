# Agentic Commerce Research Agent — implementation plan

Status: Phase 0 audit complete. Milestones 1-3 and 5 implemented; Milestone 4
(real Base Sepolia settlement) implemented behind a mock-first interface and
**NOT VERIFIED** on-chain (no funded testnet wallet / facilitator credential in
this environment). See `testing.md` and `security.md` for what that means.

## 1. Repository audit (what actually exists)

Crosswake is a pnpm-workspace monorepo on Node 24, strict TypeScript
(`NodeNext`), `noUncheckedIndexedAccess`, Vitest, Prettier. CLIs are `tsx`
entry points under `apps/*`; shared logic lives in `packages/*` and is imported
across packages by **relative path** (`../../quant/src/index.js`), not by
workspace package name.

| Concern                           | Current implementation                                                                                                                                                                                                                                                                                                                | Notes for the commerce agent                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data ingestion                    | `apps/collector` + `packages/market-data` (Binance spot WS → journal → ZSTD Parquet in `data/normalized`)                                                                                                                                                                                                                             | Real 1s research data. No order-book depth in the research path.                                                                                                                            |
| Daily history                     | `data/daily/<SYMBOL>/*.csv` Binance klines, read by `apps/trend`                                                                                                                                                                                                                                                                      | Real multi-year daily bars, usable offline.                                                                                                                                                 |
| Order-book depth                  | `packages/market-data/src/depth.ts` (`fetchBook`, `measureBook`, `sweepBps`) exists but is **only** used by an on-demand CLI, and is **not persisted**                                                                                                                                                                                | This is the honest "missing metric": depth/impact liquidity is not part of stored research evidence.                                                                                        |
| Quant research                    | `packages/quant` (`regress`, `relationship`, `PriceSeries`, `BarStore`)                                                                                                                                                                                                                                                               | Real correlation/regression maths — used by the need detector to compute BTC correlation from daily closes.                                                                                 |
| Signal generation                 | `packages/signals`, `packages/signal-log` (hash-chained append-only log), `apps/residual`, `apps/trend`, `apps/htf`                                                                                                                                                                                                                   | Untouched. The commerce layer never writes signals.                                                                                                                                         |
| Strategy evaluation / backtesting | `packages/backtest` (walk-forward, holdout, evidence gates)                                                                                                                                                                                                                                                                           | Untouched.                                                                                                                                                                                  |
| API                               | read-only Node HTTP server, `packages/research-runtime/src/evidence-api.ts`                                                                                                                                                                                                                                                           | Optional bearer token; POSTs limited to fills, sandbox, jobs. Commerce routes are mounted here.                                                                                             |
| Evidence API process              | `apps/api/src/main.ts` (`pnpm research:api`, `127.0.0.1:4112`)                                                                                                                                                                                                                                                                        | Commerce routes served from the same process/port.                                                                                                                                          |
| Dashboard                         | `apps/dashboard` (Next.js, in-page tabs)                                                                                                                                                                                                                                                                                              | Not extended in this tranche; the API surface is exposed for it.                                                                                                                            |
| Jobs/workers                      | launchd (`scripts/services.sh`) locally, systemd on the OCI box (`deploy/oci/services.sh`)                                                                                                                                                                                                                                            | No new daemon added; commerce runs on demand.                                                                                                                                               |
| Agent/LLM orchestration           | **Mastra is installed** (`@mastra/core` 1.74.0, `@mastra/libsql`, `@mastra/memory`). `packages/research-runtime/src/runtime.ts` builds `Crosswake Research Supervisor` with `AgentController`, modes (`investigate`/`experiment`/`review`), narrow read tools, a deterministic experiment workflow, and explicit per-tool permissions | The commerce agent follows this exact pattern: narrow tools, explicit schemas, deterministic state transitions outside the LLM.                                                             |
| Persistence                       | **No SQL database and no Drizzle.** DuckDB + ZSTD Parquet for numeric data; append-only JSONL ledgers (`packages/research-runtime/src/residual-evidence.ts::readLedger`) + atomic JSON `state.json` for state                                                                                                                         | Phase 10 is therefore implemented as append-only, hash-chained JSONL ledgers under `data/commerce/`, reusing the established conventions instead of introducing a second persistence stack. |
| Auth                              | `RESEARCH_API_TOKEN` bearer on the evidence API; loopback-only otherwise                                                                                                                                                                                                                                                              | Commerce mutating routes **require** the token (never loopback-implicit).                                                                                                                   |
| Secrets                           | `.env.local` (gitignored), `.env.example` documents keys                                                                                                                                                                                                                                                                              | New keys documented, no secrets committed.                                                                                                                                                  |
| Testing                           | Vitest, `tests/*.test.ts`, `tests/fixtures/*`                                                                                                                                                                                                                                                                                         | Commerce tests are offline and deterministic.                                                                                                                                               |

Complete vs partial vs missing: collection, quant, backtest, signals and the
evidence API are complete and live. There is **no** payment, wallet, provider or
commerce code anywhere in the repository, and `Mastra` is used only for the
research supervisor. Nothing in the repo mocks x402, so the entire commerce
subsystem is greenfield behind a single new package.

## 2. Integration points

1. `packages/commerce` — new, portable. Depends only on `zod`, `node:*`, and
   (for live payments only) `viem`. It imports **no** Crosswake signal logic.
2. `packages/commerce/src/agent.ts` — the Mastra `CrosswakeCommerceResearchAgent`,
   built from injected deterministic services so the package stays portable.
3. `packages/commerce/src/crosswake-source.ts` — the one Crosswake-aware adapter:
   reads `data/daily`, `data/normalized`, `data/context` and `packages/quant` to
   answer "what evidence already exists for SOL/BTC". This is the only file that
   knows about Crosswake's data layout.
4. `packages/research-runtime/src/evidence-api.ts` — one small hook
   (`options.commerce`) that delegates `/research/commerce/*` before the existing
   GET router. Existing routes are byte-for-byte unchanged.
5. `apps/commerce/src/main.ts` — CLI for the demo, approvals, and budget.
6. `apps/api/src/main.ts` — passes the commerce router into the evidence server.

## 3. Proposed modules (as built)

| Module                | Responsibility                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `money.ts`            | exact integer USDC minor units (bigint, 6 decimals). No floats anywhere in settlement.                                     |
| `types.ts`            | all zod schemas: need, offer, quote, intent, decision, payment event, purchased data.                                      |
| `config.ts`           | loads + validates `configs/commerce/policy.json`, provider registry path, env.                                             |
| `registry.ts`         | provider registry with allowlist + adapter resolution.                                                                     |
| `adapters/mock.ts`    | deterministic x402 seller: real 402 challenge shapes (v1+v2), fixture data, failure modes.                                 |
| `adapters/http.ts`    | real x402 HTTP client-side transport for live sellers.                                                                     |
| `discovery.ts`        | offers matching a research need (data type + asset + market + network).                                                    |
| `evaluation.ts`       | Stage A deterministic filter, Stage B scored recommendation, reject reasons.                                               |
| `need.ts`             | Research Need Detector: inventory → needs, `NO_PURCHASE_NEEDED`, `NO_PROVIDER`, dedupe.                                    |
| `policy.ts`           | `authorizePurchase(intent, policy, ledger)` — pure, LLM-free, re-run by the executor.                                      |
| `ledger.ts`           | append-only hash-chained JSONL ledger, reservations, budget windows, idempotency, reconciliation.                          |
| `wallet.ts`           | wallet adapter interface: `MockWallet` (deterministic) and `ViemWallet` (EIP-3009 signing + ERC-20 balance).               |
| `x402.ts`             | the 14-step purchase state machine: challenge → validate → budget → approval → sign → retry → settle → deliver.            |
| `validation.ts`       | deterministic purchased-data validation (schema, identity, freshness, numerics, units, duplicates, provenance, injection). |
| `evidence.ts`         | evidence integrator: classification (`measured`/`purchased`/`interpretation`), provenance, no automatic confidence boost.  |
| `observability.ts`    | per-run cost/audit rollup and purchase history.                                                                            |
| `services.ts`         | dependency-injected wiring used by the CLI, the API and tests.                                                             |
| `agent.ts`            | Mastra `CrosswakeCommerceResearchAgent` with narrow tools; no wallet or payment-execution tool.                            |
| `api.ts`              | `/research/commerce/*` router (authenticated; mutating routes always require the bearer token).                            |
| `crosswake-source.ts` | Crosswake evidence source + the audit-facing integration seam.                                                             |

## 4. Required dependencies

- Already present: `zod`, `@mastra/core`, Node 24 built-ins.
- Added: `viem` (^2.57.4) — EIP-712 / EIP-3009 typed-data signing and ERC-20
  `balanceOf` reads for testnet/mainnet. Chosen over `@x402/*` SDK internals
  because the payment _protocol_ surface (headers, JSON shapes, facilitator
  `/verify` + `/settle`) is stable and documented, while the signing primitive is
  what a wallet SDK must supply. No `@x402/*` package API is called, so nothing
  is invented.
- Not added: no new persistence stack, no new HTTP framework, no marketplace.

## 5. Persistence (in place of a SQL migration)

`data/commerce/` (gitignored, like all collected data):

| Path                          | Contents                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| `payments.jsonl`              | append-only hash-chained payment events (state machine transitions)       |
| `reservations.jsonl`          | append-only budget reservation / release / consume events                 |
| `approvals.jsonl`             | append-only human approval / decline records                              |
| `intents/<purchaseId>.json`   | immutable purchase intent (created with `wx`)                             |
| `purchases/<purchaseId>.json` | materialised payment + delivery + validation view                         |
| `purchased/<purchaseId>.json` | validated purchased-data record with content digest                       |
| `runs/<runId>.json`           | research-run report (needs, offers, cost, provenance)                     |
| `evidence/<runId>.json`       | integrated evidence set                                                   |
| `CONTROL.json`                | emergency stop flag, written by `commerce:disable`                        |
| `.lock/`                      | exclusive reservation lock (mkdir), same convention as `research-runtime` |

Every ledger row carries `seq`, `prevHash` and `hash`, verified by
`verifyLedger()` — the same integrity idea as `packages/signal-log`.

Amounts are stored as **decimal strings** in JSON and parsed to bigint minor
units at the boundary, never to `number`.

## 6. Security considerations

- The LLM can never sign, transfer, or increase its own budget. Payment
  execution is not exposed as an agent tool.
- `authorizePurchase` is pure and is re-run by the executor immediately before
  signing; approval is a separate, recorded human action.
- Mainnet is disabled unless `COMMERCE_MODE=mainnet` **and**
  `COMMERCE_MAINNET_ENABLED=true` **and** a separate mainnet key is configured
  **and** each purchase is approved. Tests assert the default is impossible to
  spend.
- Recipients, networks, assets and providers are allowlisted; purchased content
  is untrusted input (schema-bounded, size-bounded, injection-scanned) and can
  never influence wallet behaviour.
- SSRF/redirect/DNS-rebinding controls on the live adapter: host allowlist,
  `redirect: 'error'`, no user-supplied URLs, bounded body, content-type check,
  hard timeout, no retries on the payment leg outside the documented flow.
- A settled payment is never reversed by a validation failure; the loss is
  recorded and surfaced.
- An uncertain settlement result goes to `SETTLEMENT_UNKNOWN` and reconciliation,
  never a blind retry.

## 7. Milestones

| #   | Milestone                                                                          | State                                         |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Audit, architecture, typed interfaces, deterministic mock provider, need detection | done                                          |
| 2   | Mastra commerce agent, provider selection + price evaluation, pipeline seam        | done                                          |
| 3   | Policies, approval workflow, budget ledger, fully mocked x402 lifecycle            | done                                          |
| 4   | Real x402 on Base Sepolia, wallet adapter, validation, settlement reconciliation   | implemented, **live settlement NOT VERIFIED** |
| 5   | Evidence integration, cost analytics, API surface, end-to-end tests                | done                                          |
| 6   | Production hardening, docs, optional seller-side design                            | done (docs) / seller side documented only     |

## 8. Explicit non-goals

No marketplace, no token, no blockchain protocol, no multi-tenant merchant
onboarding, no revenue sharing, no ERC-8004 integration (documented as a future
extension), no change to the existing signal engine, risk rules, paper trading or
backtesting.
