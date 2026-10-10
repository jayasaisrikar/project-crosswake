# Agentic commerce

A buying agent inside Crosswake: it works out when the research pipeline is
missing information worth paying for, checks the seller, and completes the
purchase through x402 without ever letting a language model touch a wallet.

Start with the plan, then the architecture:

| Document                                         | Contents                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| [implementation-plan.md](implementation-plan.md) | repository audit, integration points, modules, milestones                 |
| [architecture.md](architecture.md)               | layers, decision flow, state model, persistence                           |
| [setup.md](setup.md)                             | running the demo, every command, mock/testnet/mainnet, approvals, the API |
| [security.md](security.md)                       | authorisation, approvals, mainnet gate, untrusted content, limitations    |
| [testing.md](testing.md)                         | the required test cases, what is verified, what is not                    |
| [future-network.md](future-network.md)           | what is already portable, and what was deliberately not built             |

## The result it aims for

```
Research SOL/BTC correlation            existing price and volume data
Identify missing liquidity information   additional research recommended
Request purchase authorization           0.05 USDC quoted via x402
Validate data and update research        evidence attached, original risk checks intact
```

```bash
pnpm commerce:demo
```

The innovation is not giving Crosswake a wallet. It is the repeatable decision
system around it: whether buying information is worth the money, whether the
seller can be trusted, and whether the purchase completes safely. That system is
what would become a standalone on-chain agent-commerce product later; Crosswake
is its first working demonstration, not another speculative agent marketplace.
