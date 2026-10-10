# Setup and operation

Everything below runs offline in `mock` mode with no credentials, no keys and no
funded wallet.

## Requirements

- Node 24, pnpm 10 (`pnpm install` in the repo root).
- `viem` is a dependency, but it is only loaded in testnet/mainnet mode.

## Run the demonstration

```bash
pnpm commerce:demo
```

That single command, against the data already in `data/`:

1. reads SOL's local daily history and computes the real SOL/BTC log-return
   correlation with `packages/quant`;
2. lists the metrics the pipeline cannot produce locally;
3. compares two registered mock sellers and explains the rejection of the
   cheaper, unverified one;
4. gets a fresh x402 quote (a real HTTP 402 challenge, in mock form);
5. authorises it through the deterministic policy engine;
6. records an approval and settles a mock x402 payment;
7. validates the payload and attaches it to the research run;
8. prints the cost and the audit trail, and writes
   `data/commerce/runs/<runId>.json`.

Deterministic fixtures are seeded from the asset, so repeated runs produce the
same numbers. Use `--asset ETHUSDT` (or any symbol with `data/daily/<SYMBOL>`)
to research a different asset, `--variant stale|invalid-schema|oversized|
prompt-injection|redirect|reject-payment|timeout|timeout-after-payment` to
exercise a failure path, and `--no-auto-approve` to see the approval gate.

### Live liquidity measurement (`--live-depth`)

```bash
pnpm commerce:demo -- --live-depth
```

Without the flag the run is fully offline: depth and market impact stay on the
declared-gap list and a mock provider is bought. With it, the run reads
Hyperliquid's public level-2 book (no key, no payment) and measures its own
liquidity, so both liquidity gaps disappear and the purchase moves to the metric
it genuinely cannot measure (`holder_concentration`). Real output:

```
- order_book_depth: spread 0.91 bps, bid depth 5,896,520 USDT, ask depth 6,337,896 USDT.
  Cross-venue proxy: this is a perpetuals book, so it indicates rather than measures SOLUSDT spot depth.
- market_impact_liquidity: 10,000 USDT 0.91 bps round trip, 50,000 USDT 1.67 bps round trip,
  250,000 USDT 3.15 bps round trip.
declared gaps: holder_concentration, token_flow_metrics
```

The book is for perpetuals, so it is recorded as a cross-venue proxy, never as a
spot measurement. If Hyperliquid is unreachable the gaps stay open and the demo
says so; it does not silently substitute a number. The flag exists rather than
being the default because the offline path is what the tests and CI rely on.

## Commands

| Command                                                 | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm commerce:demo`                                    | full mock demonstration                                     |
| `pnpm commerce:run -- --asset SOLUSDT [--auto-approve]` | one research run, JSON output                               |
| `pnpm commerce:offers`                                  | declared gaps, needs and matching providers                 |
| `pnpm commerce:providers`                               | the whole registry                                          |
| `pnpm commerce:budget`                                  | mode, caps, committed spend, emergency-stop state           |
| `pnpm commerce:purchases`                               | purchase history (payment/delivery/validation)              |
| `pnpm commerce:purchase -- <id>`                        | one purchase: record, intent, purchased data                |
| `pnpm commerce:audit -- <id>`                           | the hash-chained events for one purchase                    |
| `pnpm commerce:approve -- <id> [--actor NAME]`          | record a human approval                                     |
| `pnpm commerce:decline -- <id> [--actor NAME]`          | record a decline                                            |
| `pnpm commerce:execute -- <id>`                         | pay an approved purchase                                    |
| `pnpm commerce:reconcile -- <id>`                       | resolve an uncertain settlement                             |
| `pnpm commerce:disable [--reason TEXT]`                 | emergency stop, immediately                                 |
| `pnpm commerce:enable`                                  | clear the emergency stop                                    |
| `pnpm commerce:evaluate`                                | baseline vs enhanced comparison, or `INSUFFICIENT_EVIDENCE` |
| `pnpm commerce:agent -- --asset SOLUSDT`                | the Mastra agent (needs `RESEARCH_MODEL`)                   |

## Configuration

`configs/commerce/policy.json` holds the caps and allowlists:

```json
{
  "maxPerPaymentUsdc": "0.25",
  "maxPerResearchRunUsdc": "1",
  "maxDailyUsdc": "3",
  "emergencyDisabled": false,
  "allowProviders": ["mock-liquidity-analytics", "mock-market-intel"],
  "allowRecipients": ["0x1111...1111", "0x2222...2222"],
  "networks": {
    "mock": ["eip155:84532"],
    "testnet": ["eip155:84532"],
    "mainnet": ["eip155:8453"]
  },
  "assets": {
    "eip155:84532": "0x036CbD...CF7e",
    "eip155:8453": "0x833589...2913"
  }
}
```

These are illustrative development caps, not permission to spend.

`configs/commerce/providers.json` is the manually verified service registry.
Every entry needs a documented endpoint and payment terms; the prices in it are
evaluation metadata, and a purchase always uses the seller's own 402 challenge.

Environment variables (see `.env.example`):

```
COMMERCE_MODE=mock                 # mock | testnet | mainnet
COMMERCE_MAINNET_ENABLED=false     # must also be true for mainnet
COMMERCE_ASSET=SOLUSDT
COMMERCE_POLICY=configs/commerce/policy.json
COMMERCE_REGISTRY=configs/commerce/providers.json
# COMMERCE_TESTNET_WALLET_PRIVATE_KEY=
# COMMERCE_MAINNET_WALLET_PRIVATE_KEY=
# COMMERCE_RPC_URL=https://sepolia.base.org
```

## Testnet mode (Base Sepolia)

Testnet mode is implemented and wired, but **no live settlement has been
performed or verified in this environment** — there is no funded testnet wallet
and no x402 seller configured here. To enable it:

1. Create a dedicated test wallet. Never reuse a mainnet key:
   `COMMERCE_TESTNET_WALLET_PRIVATE_KEY=0x...`
2. Fund it with Base Sepolia USDC
   (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, chain `eip155:84532`) and a
   little Sepolia ETH is not needed: the facilitator sponsors gas.
3. Register a seller that really accepts x402 on Base Sepolia and add it to
   `configs/commerce/providers.json` with its recipient in `allowRecipients`.
4. `COMMERCE_MODE=testnet pnpm commerce:demo`.

The facilitator is contacted by the seller, not by this client; the client only
reads the settlement receipt the seller returns. Set `COMMERCE_RPC_URL` if the
default public RPC is unsuitable.

## Mainnet mode

Mainnet requires all of: `COMMERCE_MODE=mainnet`, `COMMERCE_MAINNET_ENABLED=true`,
`COMMERCE_MAINNET_WALLET_PRIVATE_KEY` set to a **separate** mainnet wallet, a
registered seller on `eip155:8453`, and a recorded human approval per purchase.
Without every one of those, no mainnet payment is possible; the test suite
asserts it.

## Approvals and the API

The evidence API serves commerce routes on the same port (`pnpm research:api`):

```
GET  /research/commerce/providers
GET  /research/commerce/budget
GET  /research/commerce/purchases
GET  /research/commerce/purchases/:id
GET  /research/commerce/purchases/:id/audit
GET  /research/commerce/runs        /runs/:id
GET  /research/commerce/offers
POST /research/commerce/analyze
POST /research/commerce/purchases/:id/approve     {"actor":"..."}
POST /research/commerce/purchases/:id/decline     {"actor":"..."}
POST /research/commerce/purchases/:id/execute
POST /research/commerce/purchases/:id/reconcile
POST /research/commerce/disable                   {"disabled":true,"reason":"..."}
```

Every mutating route requires `RESEARCH_API_TOKEN` as a bearer token. With no
token configured, mutations are refused with
`commerce_mutations_require_research_api_token` — an unconfigured deployment
cannot spend. The API never auto-approves, and an approval must name the person
who gave it.

## Stopping spending immediately

```bash
pnpm commerce:disable --reason "operator stop"
```

or `POST /research/commerce/disable`. The flag is written to
`data/commerce/CONTROL.json` and is checked on every authorisation, including
the re-check immediately before signing. It is independent of the committed
policy file, so it cannot be undone by a deploy.
