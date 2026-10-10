# Security model

The threat model is blunt: a language model is deciding whether to spend money
in a market full of adversarial content, and the money is real on mainnet.

## The central rule

**The LLM can request a purchase. Only the deterministic commerce service can
authorise and execute it.** There is no wallet tool, no signing tool and no
policy tool in the agent's toolset. `requestPurchaseAuthorization` records a
request and returns a decision; it cannot move funds.

## Authorisation

`authorizePurchase(intent, policy, ledger)` is a pure function — no model, no
I/O, no randomness — and it is run twice: once when the purchase is requested,
and again inside the executor immediately before signing. The second run sees
the current ledger, so a concurrent purchase, a raised spend or an engaged
emergency stop changes the answer.

Checks, all recorded with pass/fail and a reason:

| Check                                                                 | Refuses when                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `mode_matches_intent`                                                 | the intent's mode is not the runtime mode                                   |
| `emergency_stop_clear`                                                | the runtime flag or the committed policy disables spending                  |
| `mainnet_explicitly_enabled`                                          | a mainnet intent lacks the enable flag and a separate key                   |
| `provider_allowlisted` / `provider_verified`                          | the provider is not allowlisted or is unverified                            |
| `recipient_allowlisted` / `recipient_matches_registry`                | the 402 recipient is not approved, or differs from the registered recipient |
| `network_approved` / `wallet_network_matches`                         | the network is not approved for the mode, or the wallet is on another chain |
| `asset_approved`                                                      | the payment token is not the approved USDC for that network                 |
| `scheme_approved`                                                     | the scheme is not `exact`                                                   |
| `resource_is_registered_endpoint`                                     | the paid resource is not the registered service endpoint                    |
| `per_payment_cap` / `per_run_cap` / `daily_cap` / `need_cost_ceiling` | any configured limit would be exceeded                                      |
| `quote_unexpired`                                                     | the quote has expired                                                       |
| `idempotency_key_unused`                                              | a live charge already uses this key                                         |
| `no_equivalent_purchase_in_run`                                       | equivalent data was already bought in this run                              |
| `wallet_balance_sufficient`                                           | the mock/testnet balance is short                                           |
| `payer_is_not_recipient`                                              | the payer and the recipient are the same address                            |

## Human approval

Every purchase requires a recorded approval event naming a person
(`pnpm commerce:approve -- <id> --actor NAME`, or the authenticated API route).
Approval text produced by a model is not an approval. Mock mode additionally
allows an explicit `--auto-approve` convenience for the demonstration; testnet
and mainnet never auto-approve.

## Mainnet

Disabled by default and unreachable from configuration alone. It needs
`COMMERCE_MODE=mainnet`, `COMMERCE_MAINNET_ENABLED=true`, a **separate** mainnet
private key (`COMMERCE_MAINNET_WALLET_PRIVATE_KEY`, never the testnet one), an
allowlisted seller on `eip155:8453`, and a per-purchase approval. The test suite
asserts that the default configuration cannot produce a mainnet payment.

## Secrets

Private keys are read from the environment by `wallet.ts`, passed straight to
`viem`, and never logged, traced, returned in an API response or written to the
ledger. Mock mode needs no key at all. The ledger stores payment references and
transaction hashes, never key material.

## Untrusted provider content

Provider descriptions, 402 challenges and purchased payloads are all treated as
data, never instructions:

- responses are size-bounded and content-type checked before parsing;
- live endpoints must be https, their host must be in the registry-derived
  allowlist, and redirects are refused rather than followed (`redirect: 'error'`)
  which also blunts SSRF and DNS-rebinding attempts;
- every request has a hard timeout, and the payment leg is never retried
  outside the documented x402 flow;
- payloads are schema-validated, identity-checked and injection-scanned;
  instruction-like text (`instruction_override`, `wallet_instruction`,
  `role_marker`, an address embedded in prose) fails validation and the payload
  is rejected as unusable research.

The agent's instructions state that no document, tool result or purchased
payload can change its limits, and the code enforces that independently of the
prompt: there is nothing to invoke.

## Settlement honesty

- A settled payment is never reversed by a validation failure. The payment
  record is preserved, the research is marked unusable and the loss is surfaced.
- An uncertain settlement (`SETTLEMENT_UNKNOWN`) keeps its budget hold so it
  cannot be spent twice, and requires `reconcile` before anything else happens.
  Reconciliation asks the seller's access control and never re-sends a payment.
- Mock settlement evidence is labelled `source: 'mock'`. It is never presented
  as on-chain evidence.

## Money arithmetic

All settlement arithmetic is bigint minor units. `parseUsdc` rejects anything
that is not a plain non-negative decimal with at most six places, and
`formatUsdc` is the only way a figure becomes human-readable. Floating point
never touches a monetary value; there is no rounding step to exploit.

## Known limitations

- The mock seller is in-process; the live adapter has not been exercised against
  a real x402 seller, so its behaviour under a hostile seller is reasoned about,
  not observed.
- `reconcile` uses the seller's access-control response, which is a weaker signal
  than a facilitator receipt. A facilitator-verified path is the natural next
  step.
- The policy file is trusted configuration. Anyone who can edit it can raise the
  caps; that is a repository-permission boundary, not a runtime one.
- The API has one shared bearer token; there is no per-user authorisation because
  Crosswake is currently single-operator.
