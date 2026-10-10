# Future commerce network

The buyer agent is deliberately the whole of this tranche. What follows is the
portable surface it already exposes, and the phases that were explicitly **not**
built.

## What is already portable

These have no Crosswake, BTC or SOL dependency and could be lifted into a shared
package unchanged:

| Service             | Module              | Interface                                            |
| ------------------- | ------------------- | ---------------------------------------------------- |
| provider registry   | `registry.ts`       | `ProviderRegistryIndex`                              |
| offer evaluation    | `evaluation.ts`     | `stageA`, `evaluateOffers`, `PurchaseRecommendation` |
| purchase policy     | `policy.ts`         | `authorizePurchase`, `AuthorizeInput`                |
| payment adapter     | `adapters/index.ts` | `ProviderAdapter`                                    |
| wallet adapter      | `wallet.ts`         | `WalletAdapter`                                      |
| transaction ledger  | `ledger.ts`         | `CommerceLedger`, `LedgerEvent`                      |
| delivery validation | `validation.ts`     | `validatePurchasedData`                              |
| cost accounting     | `observability.ts`  | `runCostReport`                                      |

The only Crosswake-specific file is `crosswake-source.ts`, which implements
`ResearchEvidenceSource` — "what evidence do I already have, and what is
genuinely missing". Any other agent supplies its own implementation of that one
interface and reuses everything else.

## Phase 2 (documented, not built): seller side

Crosswake could expose its own original research through a paid x402 API. The
pieces already exist in the buyer path and would be mirrored, not invented:

- a resource server that answers `402` with a real `PAYMENT-REQUIRED` challenge
  (`adapters/mock.ts` is already a working reference implementation of that
  response shape, in both protocol generations);
- an allowlist of buyers, and a settlement receipt the buyer's client can verify;
- the same validation-on-delivery discipline applied to what Crosswake sells, so
  a buyer's deterministic checks pass.

This was **not** built, and it is not needed for the buyer-agent MVP. A
marketplace, multi-tenant merchant onboarding and revenue sharing were
explicitly out of scope.

## Phase 3 (documented, not built): identity and reputation

ERC-8004 identity or reputation, if adopted, would be an _input_ to Stage B
scoring, never a substitute for it. A registration is not evidence that a
seller's research is accurate, and the evaluation engine already keeps
reliability and historical validation as separate, independently weighted
factors precisely so a reputation score cannot dominate the decision.

## Phase 4 (documented, not built): facilitator-verified reconciliation

Today `reconcile` uses the seller's access-control response, which is a weaker
signal than a facilitator receipt. A facilitator-verified path (POST `/verify`
then `/settle` against a documented facilitator, with the receipt stored on the
payment event) is the natural hardening step, and the settlement record already
has a `source` field that distinguishes mock, facilitator and resource-server
evidence.

## Phase 5 (documented, not built): the research-quality experiment

`pnpm commerce:evaluate` currently reports `INSUFFICIENT_EVIDENCE`, because
point-in-time paid history cannot be reconstructed from a mock seller. A real
baseline-versus-enhanced comparison needs purchased data that is reproducible at
the historical decision time, identical evaluation windows, walk-forward
splits, and the existing `packages/backtest` evidence gates. Until then, no
claim is made that buying data improves anything.
