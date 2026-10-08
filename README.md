# Crosswake

**Research engine for BTC-driven altcoin trade signals.** It collects Binance market data, tests trading ideas on data they have never seen, and publishes paper signals to a dashboard.

> Paper research only. Crosswake never places orders, and no strategy has passed validation yet.

## Strategies

Each strategy's rules are committed before testing and are never retuned on the test data.

| | Idea | Holding time | Result on unseen data | Status |
|---|---|---|---|---|
| v001–v002 | Alts follow a BTC move | seconds | Lag is 1–3 s, too fast for a human | ❌ Not viable |
| v003 | Buy alts lagging BTC | 1–4 h | −0.43% per trade | ❌ Failed |
| v004 | Short alts that held up while BTC fell | 4 h | −0.46% per trade | ❌ Failed |
| **v005** | **Daily breakout while BTC is in an uptrend** | **~12 days** | **34% win rate, +1.5% per trade** | 🟡 **Promising, not yet proven** |

**v005** buys an alt when it closes at a 20-day high while BTC is above its 100-day average. It sells when the alt closes at a 10-day low. Its average win is about 2.6× its average loss. The result isn't statistically certain yet, so it is being paper traded live.

## Quick start

```bash
pnpm install
pnpm test
cp .env.example .env.local    # optional keys; never commit this file
pnpm services:install         # macOS: run collector, API and signal engines in the background
pnpm dashboard                # http://127.0.0.1:3000/signals
```

Requires Node 24 and pnpm 10.

## Common commands

| Command | What it does |
|---|---|
| `pnpm trend:history` / `pnpm trend:test` | Download daily data and test v005 |
| `pnpm residual:live` | Run the live signal engine |
| `pnpm collect` | Record live trades and quotes |
| `pnpm services:status` | Check the background services |
| `pnpm costs:report` | Show measured trading costs |

## Hosting

The repo runs on a free Oracle Cloud ARM server. Choose a non-US region, because Binance blocks US IPs.

```bash
bash deploy/oci/setup.sh <repo-url>
bash deploy/oci/services.sh enable
ssh -L 3000:127.0.0.1:3000 ubuntu@<server-ip>   # then open localhost:3000
```

## Project layout

```
apps/       CLIs and the Next.js dashboard
packages/   market data, storage, quant, signals, backtest, notify
configs/    frozen strategy plans
docs/       research records and the full reference
deploy/     server setup
```

## Learn more

- [Full reference](docs/reference.md): every command, data format and research rule
- [Strategy records v003–v005](docs/residual-strategy-v003.md)
- [Current status](docs/status.md)

Telegram alerts are built in but stay off until `TELEGRAM_ENABLED=true` is set.
