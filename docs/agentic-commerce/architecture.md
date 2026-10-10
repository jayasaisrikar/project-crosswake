# Agentic commerce architecture

The commerce subsystem answers one question for the research pipeline: **is a
missing piece of information worth money, and can it be bought safely?**

It lives in `packages/commerce` and is portable: apart from
`crosswake-source.ts`, nothing in it knows about Bitcoin, SOL, signals or the
Crosswake data layout. That is deliberate — the buyer agent is the first
consumer of a commerce layer that other agents could use later, not a
marketplace.

## Layers

```
  Mastra agent            CrosswakeCommerceResearchAgent   (reasoning, narrow tools)
        |                 cannot sign, cannot pay, cannot change policy
        v
  orchestration           orchestrator.ts                  (deterministic steps)
        v
  commerce core           need / discovery / evaluation / policy / ledger
                          validation / evidence / observability
        v
  payment                 x402.ts  ->  adapters (mock seller | live HTTP seller)
        v
  wallet                  wallet.ts (mock | viem EIP-3009)
```

The LLM only ever occupies the top layer. Every layer below it is ordinary,
tested TypeScript with no model in the path.

## The pieces

| Module                | Responsibility                                                                   | Key entry point                                                          |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `money.ts`            | exact integer USDC minor units                                                   | `parseUsdc`, `formatUsdc`                                                |
| `types.ts`            | runtime schemas for every boundary                                               | `researchNeedSchema`, `purchaseIntentSchema`, `paymentRequirementSchema` |
| `config.ts`           | env + policy + registry loading                                                  | `commerceEnv`, `loadPolicy`                                              |
| `registry.ts`         | allowlisted, verified providers                                                  | `ProviderRegistryIndex.from`                                             |
| `need.ts`             | what is missing, and is it worth buying                                          | `detectResearchNeeds`                                                    |
| `discovery.ts`        | which registered services can supply it                                          | `discoverProviders`                                                      |
| `evaluation.ts`       | Stage A filter, Stage B score, recommendation                                    | `stageA`, `evaluateOffers`                                               |
| `policy.ts`           | the deterministic spend decision                                                 | `authorizePurchase`, `authorizeWithLedger`                               |
| `ledger.ts`           | append-only hash-chained audit + budgets                                         | `CommerceLedger`                                                         |
| `wallet.ts`           | signing and balance, mock or viem                                                | `createMockWallet`, `createViemWallet`                                   |
| `x402.ts`             | the purchase state machine and x402 client                                       | `X402PurchaseClient`, `parseChallenge`                                   |
| `validation.ts`       | is the purchased payload usable                                                  | `validatePurchasedData`                                                  |
| `evidence.ts`         | attach paid data with provenance                                                 | `integrateEvidence`                                                      |
| `observability.ts`    | per-run cost and counters                                                        | `runCostReport`                                                          |
| `services.ts`         | dependency injection / wiring                                                    | `createCommerceServices`                                                 |
| `orchestrator.ts`     | the end-to-end deterministic run                                                 | `runResearchCommerce`                                                    |
| `agent.ts`            | the Mastra agent and its tools                                                   | `createCommerceAgent`                                                    |
| `api.ts`              | `/research/commerce/*` router                                                    | `createCommerceRouter`                                                   |
| `crosswake-source.ts` | the Crosswake evidence adapter, including the free Hyperliquid depth measurement | `crosswakeEvidenceSource`, `hyperliquidDepth`                            |

## Decision flow

1. **Inspect.** `crosswakeEvidenceSource` reads local daily klines, the 1s
   research dataset and the altFINS snapshot, and computes the BTC-relative
   correlation with `packages/quant`. It also declares the metrics the pipeline
   genuinely cannot produce (`order_book_depth`, `market_impact_liquidity`,
   `holder_concentration`, `token_flow_metrics`).
   With `depth` injected it also measures liquidity itself from Hyperliquid's
   public level-2 book (`hyperliquidDepth`, no key, no cost) and drops the two
   liquidity gaps, so a metric the pipeline can obtain free is never bought.
   The book is a perpetuals book, so the evidence records it as a cross-venue
   proxy for spot. Retries are bounded to two attempts: a venue outage leaves
   the gap open rather than stalling a research run.
2. **Detect.** `detectResearchNeeds` drops any gap already covered by fresh
   evidence, drops gaps no registered provider serves (into a missing-data
   report), drops gaps already bought in this run, and returns the rest as
   `ResearchNeed`s — or `NO_PURCHASE_NEEDED`.
3. **Discover.** Only registered, verified providers that cover both the data
   type and the asset become candidates. Nothing is scraped or invented.
4. **Evaluate.** Stage A eliminates unverified providers, non-allowlisted
   providers and recipients, unapproved networks, wrong payment assets,
   over-budget prices and over-cap prices. Stage B scores the survivors on
   relevance, reliability, historical validation, coverage, freshness and cost,
   and returns a recommendation with per-alternative rejection reasons.
5. **Quote.** The client requests the protected resource, receives HTTP 402, and
   normalises the challenge (v2 header or v1 body) into one requirement shape.
   The price used is always the seller's own quote, never registry metadata and
   never a model.
6. **Authorise.** `authorizePurchase` runs ~20 deterministic checks and records
   the decision. A human approval is always required.
7. **Pay.** After a recorded approval, the executor reserves budget, re-runs
   authorisation (so concurrency cannot widen the limit), signs an EIP-3009
   authorisation, retries with the payment header, and reads the settlement
   receipt.
8. **Validate.** Deterministic validation of the payload: content type, size,
   JSON, schema, asset/market identity, provenance, freshness, numeric sanity,
   duplicates, injection.
9. **Attach.** Validated data enters the run as `purchased` evidence with its
   payment reference and digest. Invalid data is recorded as an exclusion.
10. **Account.** The run report carries needs, offers, recommendation, payment,
    validation, cost and provenance; the ledger keeps the full event history.

## State model

Payment, delivery and validation are tracked on separate axes, because they can
disagree:

- payment: `CREATED` → `QUOTED` → `AWAITING_APPROVAL` → `AUTHORIZED` →
  `PAYMENT_PENDING` → `SETTLED`, with `SETTLEMENT_UNKNOWN`, `FAILED`,
  `DECLINED`, `EXPIRED` as explicit alternatives.
- delivery: `PENDING` → `DELIVERED` | `DELIVERY_FAILED`.
- validation: `PENDING` → `VALIDATED` | `VALIDATION_FAILED`.

`SETTLED` + `VALIDATION_FAILED` is a real, expected outcome: the money is gone
and the research is unusable. The record keeps the payment, marks the research
unusable and surfaces the loss. Nothing in the system claims a failed validation
reverses an on-chain transfer.

## Persistence

Crosswake has no SQL database: research state is DuckDB/Parquet for numerics and
append-only JSONL ledgers plus atomic JSON snapshots for state. Commerce follows
the same convention under `data/commerce/` (see `implementation-plan.md` for the
full layout). Every event carries `seq`, `prevHash` and `hash`, verified by
`verifyLedger()`; the `signal-log` package uses the same integrity idea.

Amounts are decimal USDC strings in JSON and integer minor units in arithmetic;
`PaymentRequirement.amount` is atomic minor units, matching the x402 wire format.

## What the agent can and cannot do

`createCommerceAgent` exposes exactly nine tools: `inspectExistingResearch`,
`identifyResearchNeeds`, `discoverResearchServices`, `evaluateServiceOffers`,
`getPurchaseQuote`, `requestPurchaseAuthorization`, `getPurchaseStatus`,
`validatePurchasedResearch`, `attachResearchEvidence`. There is no wallet tool,
no policy tool, no execution tool, no trading tool and no provider-code tool.
`requestPurchaseAuthorization` records a request and returns the deterministic
decision; it cannot pay. `COMMERCE_AGENT_TOOLS` is asserted by the test suite.
