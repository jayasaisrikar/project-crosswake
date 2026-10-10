# Testing

`pnpm test` runs the whole suite, including the commerce tests, offline and
deterministically. Nothing in the commerce suite touches the network, needs a
credential or needs a funded wallet.

```bash
pnpm test                                     # everything
npx vitest run tests/commerce-needs.test.ts       # need detection, discovery, evaluation, policy
npx vitest run tests/commerce-payments.test.ts    # payment lifecycle, validation, security
npx vitest run tests/commerce-hardening.test.ts   # money, EIP-3009, live transport, real data, reconcile
npx vitest run tests/commerce-api.test.ts         # the HTTP surface end to end
```

80 offline commerce tests in four files. `pnpm test` runs them with the rest of
the repository's 239.

## Determinism

Fixtures live in `tests/fixtures/commerce.ts`. Each test gets its own temp data
directory, its own policy/registry JSON (so caps can be changed without touching
`configs/`), a frozen clock (`T0`) and the deterministic mock seller, whose
numbers are seeded from the asset. Repeated runs produce identical values.

## Coverage of the required cases

| #   | Case                                        | Test                                                                         |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | existing data sufficient, no purchase       | `commerce-needs` → "existing data that is fresh enough produces no purchase" |
| 2   | missing evidence asks for discovery         | "missing important evidence asks for a paid provider"                        |
| 3   | no suitable provider                        | "a missing metric with no reliable provider yields a report and no purchase" |
| 4   | cost exceeds budget                         | "rejects a provider whose price exceeds the per-payment cap"                 |
| 5   | unauthorized recipient                      | "rejects an unauthorized payment recipient"                                  |
| 6   | unsupported payment token                   | "rejects a provider that requires an unsupported payment token"              |
| 7   | wrong blockchain network                    | "rejects a provider on an unapproved blockchain network"                     |
| 8   | expired quote                               | "refuses a quote whose freshness window has passed"                          |
| 9   | valid mock payment succeeds                 | `commerce-payments` → "completes a valid mock payment end to end"            |
| 10  | testnet settlement evidence                 | "keeps testnet a wired interface with no live transaction performed"         |
| 11  | invalid provider JSON                       | "fails safely on invalid provider JSON"                                      |
| 12  | stale data rejected                         | "rejects stale purchased data"                                               |
| 13  | concurrent requests keep caps               | "keeps spending caps enforced under concurrent requests"                     |
| 14  | duplicate request, no duplicate charge      | "refuses a duplicate purchase instead of charging twice"                     |
| 15  | payment timeout → reconciliation            | "enters a reconciliation state when the payment outcome is unknown"          |
| 16  | prompt injection cannot spend               | "cannot be made to spend by instructions inside a provider payload"          |
| 17  | declined approval, no payment               | "makes no payment when the operator declines"                                |
| 18  | mainnet disabled                            | "cannot spend on mainnet while it is disabled"                               |
| 19  | wallet unavailable                          | "fails safely when the wallet is unavailable"                                |
| 20  | pipeline survives optional research failure | "keeps the research run working when optional paid research fails"           |
| 21  | signal logic and risk rules unchanged       | "does not touch the existing signal, risk or backtest code"                  |
| 22  | provenance preserved                        | "preserves provenance for measured and purchased evidence"                   |
| 23  | no future-data leakage                      | "rejects a payload timestamped in the future, so no look-ahead enters a run" |
| 24  | token and transaction fees recorded         | "records paid, fee and token costs exactly"                                  |

Additional cases, in `commerce-hardening.test.ts` and `commerce-api.test.ts`:
allowlist and unverified-provider rejection, deterministic scoring,
cheapest-is-not-always-best, v1 and v2 wire formats, oversized payload,
wrong-asset and wrong-market payloads, missing provenance, inconsistent impact
figures, duplicate payload digest, redirect instead of a payload,
non-allowlisted and non-https provider hosts, hash-chain verification and tamper
detection, ledger durability and lock contention, emergency stop, per-run cap
across needs, wallet/network mismatch, the observability counters, EIP-3009
signature recovery, real-data correlation, all three reconciliation outcomes,
and the authenticated HTTP surface.

## Coverage: what is tested, and what is not

**Verified by tests.**

- The mock x402 lifecycle end to end, in both protocol generations (v2 header
  challenge and v1 body challenge).
- Every refusal path: unverified provider, non-allowlisted provider, recipient
  and network, wrong payment asset, wrong scheme, price over the per-payment,
  per-run and daily caps, expired quote, used idempotency key, duplicate
  purchase, insufficient balance, payer equal to recipient, emergency stop,
  missing approval, declined approval, disabled mainnet.
- Exact money arithmetic, including the `0.1 + 0.2` case, and the rejection of
  every malformed amount form.
- **EIP-712 / EIP-3009 signing**: the derived address for a published test key,
  the domain (`USDC`/`2`/chainId/token), the field list, and that the signature
  recovers to the payer via `recoverTypedDataAddress`. This validates the typed
  data structure, not a chain.
- The live HTTP adapter's request shape (GET, `redirect: 'error'`, timeout
  signal, payment header on the retry), challenge normalisation, settlement
  header parsing, content-type and size refusals, and the host/https allowlist.
- `crosswakeEvidenceSource` against real files on disk: a computed correlation
  of exactly 1 for a constructed series, freshness, provenance, gap
  declaration, and microsecond archive timestamps normalised rather than read
  as the future.
- Hyperliquid depth: `fetchHlBook` parses the live `l2Book` shape (string
  prices, `{px, sz, n}` rows) into a numeric book, reuses `parseBook` so a
  crossed or empty book is rejected, bounds its retries so a venue outage cannot
  stall a run, and the evidence source drops both liquidity gaps when the
  measurement succeeds while leaving them open when it fails.
- Reconciliation: `settled` when the seller grants access, `not_settled` when it
  still demands payment, `still_unknown` with no record.
- Ledger integrity: hash chain, tamper detection, durability across a reopen,
  and concurrent appends serialised by the lock (including refusing to proceed
  when the lock is held).
- The whole HTTP surface, including the auth gate, the never-auto-approve rule,
  the approval-then-execute flow, the emergency switch, and 400/401/404/413/415.

**NOT VERIFIED.**

- **An actual Base Sepolia settlement.** No funded testnet wallet, no x402
  seller, no facilitator credential here, so no live payment was made. Test 10
  asserts the interface, the refusal without a key, and the parsing of a
  facilitator-shaped receipt — it does not claim a transaction happened.
- **Real HTTPS transport to a live seller.** The adapter's logic is tested
  against an injected `fetch`; Node's own HTTPS stack is not, because there is
  no seller to talk to. A self-signed local server was not used, since that
  would test a configuration the production path forbids.
- **`balanceUsdc()` against a live RPC.** Signing is tested offline (it is pure
  cryptography); the balance read needs a node.

**Not attempted.** Any claim that paid data improves trading performance. There
is no experiment, so `pnpm commerce:evaluate` reports `INSUFFICIENT_EVIDENCE`
rather than inventing baseline-versus-enhanced numbers.

## Deliberately not covered

- **No coverage percentage.** No coverage provider is installed in this repo, so
  no figure is quoted rather than quoting an unmeasured one.
- **The CLI is not unit-tested.** `apps/commerce/src/main.ts` is a thin
  argument parser over the tested services, exercised by `pnpm commerce:demo`
  and the manual checks below. A failure there shows up immediately as a broken
  demo, not as a silent money bug.
- **The Mastra agent's reasoning is not asserted.** Its tool surface, tool count
  and the absence of any payment tool are asserted; its prose is not. The agent
  has been run once against a real model, which correctly refused to pay and
  reported `AWAITING_APPROVAL`.

## Manual checks

```bash
pnpm typecheck && pnpm typecheck:dashboard && pnpm format:check
pnpm commerce:demo
pnpm commerce:budget
pnpm commerce:audit -- <purchaseId>
COMMERCE_MODE=testnet pnpm commerce:budget   # fails cleanly without a test key
```

`COMMERCE_MODE=mainnet pnpm commerce:budget` must fail unless both the enable
flag and a separate mainnet key are present.
