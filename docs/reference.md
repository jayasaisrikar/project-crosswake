# Crosswake reference

Local BTC-to-altcoin transmission research. Binance Spot is the first market; executable paper validation is long-only. Short candidates are stored as research observations. No order execution is implemented.

Read [the implementation plan](docs/implementation-plan.md) and [current status](docs/status.md) for scope and evidence gates.

## Strategy scoreboard

Every strategy rule set is committed before it sees its test data and is never retuned on that data. Signals are paper research only.

| Version | Idea | Horizon | Unseen-data result | Status |
|---|---|---|---|---|
| v001 / v002 | Alts follow a BTC impulse | seconds–minutes | Lag is ~1–3 s, too fast for a human; filters reject everything | Not viable for manual signals |
| v003 | Buy alts lagging their BTC beta (spot, hedged) | 1–4 h | Spot: 0 trades; hedged: −43 bps/trade | Falsified |
| v004 | Short alts that held up while BTC fell (perp) | 4 h | 349 trades, 40.7% win, −45.9 bps/trade | Falsified |
| **v005** | **Daily 20-day breakout, only while BTC > 100-day SMA** | **days–weeks** | **243 trades, 33.7% win, +153 bps/trade, CI [−287, +629]** | **Inconclusive; next is live paper from 1 Oct 2026** |

Full records: [v003–v005](docs/residual-strategy-v003.md), [v002](docs/signal-improvements-v002.md).

## Run locally

Use Node 24 LTS and pnpm 10.32.1. Install with `pnpm install`, then run `pnpm typecheck` and `pnpm test`. `pnpm format:check` checks formatting.

- `pnpm collect` collects BTCUSDT, ETHUSDT and SOLUSDT trades and BBO until interrupted.
- `SYMBOLS=BTCUSDT,ADAUSDT pnpm collect` changes the development seed. BTC must be included.
- `COLLECT_SECONDS=30 DATA_DIR=./data/smoke pnpm collect` runs a bounded smoke test.
- `pnpm history ADAUSDT 2026-10-01` imports a daily Spot trade archive after published SHA256 verification.
- `pnpm history BTCUSDT 2026-10-01 2026-10-03` imports an inclusive UTC date range.
- `pnpm replay data/raw/SESSION.jsonl data/recovered-session` recovers recorded closed buckets into a separate, new directory. Substitute an actual session filename. Never query recovery output together with overlapping originals.
- `pnpm data:quality -- --data-dir ./data --source live` reports stored coverage, quote/trade availability and latency.
- `pnpm backtest -- --data-dir ./data --source live` runs chronological exploratory signal and paper-fill research.
- `pnpm backtest -- --data-dir ./data/history-smoke --source historical` explores archive inputs; absent BBO prevents executable entries.

Configuration comes from environment variables. Collector, context, Supervisor, experiment and API commands also load an optional `.env.local` in the project root; existing environment values take precedence. Copy `.env.example` to `.env.local` and fill only the settings you need. Keep keys out of Git. Public collection requires no API key.

## Data and recovery

Each collector launch creates a separate raw journal with session, connection, trade, quote, health and bucket-closure records. The default closure allowance is seven seconds; this delays decisions and reduces losses from observed source jitter. Counts from earlier two-second sessions remain recorded. Batched serialized writes retain receipt order. Queue or storage failure stops collection. `data/collector-health.json` reports freshness, queue counts, rejection counts and memory. A directory lock permits one collector per data directory. Normal shutdown releases it. After a crash, inspect `collector.lock/owner.json` and the actual process before removing a stale lock. `collector.pid` is refreshed at launch.

Normalized ZSTD Parquet files have SHA256 manifests and explicit field types. Raw trade OHLC and volume remain trade-only. Live quant returns use fresh BBO midpoints, including seconds with no trade, when the connection and bucket are healthy. This is a reference price, not an executable fill. Missing/stale quote buckets and reconnect intervals remain incomplete; no trades or volume are invented. Historical returns use trade prices and preserve gaps. Each recovered bucket records its actual closure time as `availableAt`, so paper decisions cannot precede data availability.

Historical imports have no BBO and reside in each symbol/date partition's `historical/` folder. Downloads use timeouts and bounded retries, reuse checksum-matching cache files, and publish completed imports from staging. A per-symbol/day lock prevents competing importers. After a crashed importer, inspect whether it still runs before removing its stale `.zip.lock` directory.

Research explicitly selects `live` or `historical` sources, verifies file manifests and rejects overlapping symbol-seconds. Completed archive markers prevent reimporting unchanged files. Replay output directories must be new. Journals created before the durable-session upgrade cannot be faithfully replayed because they lack closure and disconnect metadata; retain their existing normalized data.

## Research behavior

`configs/catch-up-v001.json` defines an exploratory strategy, not tuned or validated parameters. The engine fits non-overlapping, horizon-matched returns from prior snapshots, scans a declared lag grid, freezes candidate features and saves accepted/rejected candidate reasons. Fitted relationships refresh once a minute by default; price and impulse checks run per second. The default window is four hours with a minimum of 60 paired samples. Short candidates never enter executable metrics.

The paper simulator requires a quote received after the signal decision, checks whether the BTC impulse retraced or the asset gap already closed, and allows at most one entry per BTC event. Entry uses ask, exit uses bid; spread is embedded once in fills. Fees and configured slippage are charged separately. Missing entry quotes expire; unclosed positions are reported and excluded from closed-trade metrics. Outputs contain candidates, trades, entry rejection reasons, Wilson intervals and an event-cluster bootstrap.

Walk-forward selection, one-use holdout, fixed-horizon research outcomes, multi-window relationship diagnostics and cost stress are implemented. Lag reports include block-shuffle maximum-grid and shifted-clock controls; these diagnostics do not change strategy selection. Optional size/volatility costs use only prior observed volume and returns, reject unsupported participation, and remain proxies for unavailable order-book depth. No win-rate or edge claim is made by these commands. Empty samples report null performance values rather than zero or a fabricated estimate.

Collection grows the raw journal by about 1.7 GB/day; monitor disk usage. Long-running processes are supervised by launchd locally or systemd on a server (see Services and hosting).

## Walk-forward and live paper workflow

The collector defaults to `PAPER_MODE=shadow`. Each closed bucket feeds the shared signal/paper engine immediately. Session ledgers under `data/paper/` record processing clocks, candidate evidence, entries, closed trades, rejects and open state. `PAPER_MODE=off` disables this analysis. Live mode is adaptive and exploratory; it is not a deployment of a statistically validated frozen model. Restarts read `data/paper/active.json` and reconstruct quant history, pending entries, open positions and used event IDs from acknowledged journal/ledger steps. Exact parity and unchanged configuration are required; corruption or incompatible configuration stops startup. Session footers preserve open state without inventing fills. Old nonempty ledgers from incompatible versions may require a separate research directory. Recovery replays the session chain and currently grows in startup IO with collected history.

- `pnpm paper:replay -- --journal data/raw/SESSION.jsonl --ledger data/paper/SESSION.jsonl --output data/NEW_PARITY_DIRECTORY` verifies the recorded session against the same market journal and actual decision clocks.
- `pnpm research:freeze -- --plan configs/research-plan-v001.json --output research/frozen/NEW_VERSION.json` embeds declared configurations and clocks into a hashed, exclusive file.
- `pnpm research:walk-forward -- --freeze research/frozen/v001.json --data-dir ./data` selects parameters on validation and evaluates them on subsequent unseen blocks.
- `pnpm research:holdout -- --freeze research/frozen/v001.json --selection PATH_TO_SELECTION_JSON --data-dir ./data` requires qualified validation and passing walk-forward evidence before consuming the holdout once.

The initial frozen protocol uses BTC/ETH/SOL, baseline and strict variants, October 2026 folds and a final 30–31 October UTC holdout. These dates and thresholds are initial hypotheses, not a promise of sufficient samples. All ranges are half-open UTC. Each evaluation block refits relationships using only past prices, including earlier validation prices at test start, then freezes them within that block. Signals that cannot finish before the block boundary are purged. No holdout prices enter walk-forward evaluation.

Dataset snapshots verify manifests and can be replayed repeatedly with range filters. Holdout selection pins pre-holdout provenance. Persistent reservations reject overlapping reused holdout periods even under another plan name; a failed evaluation still consumes its reservation. Inspect stale research locks after a crash rather than deleting them automatically.

Reports include per-asset/month outcomes, equal-notional drawdown, concentration and losing streaks. The conservative statistical gate checks sample count, win-rate confidence bounds, event-cluster expectancy, profit factor and unfinished positions. These summaries are not portfolio capital simulation. Passing statistical gates still requires forward paper reconciliation and never authorizes real execution.

## BTC-relative residual strategy (v003)

`configs/residual-spot-v003.json` and `configs/residual-hedged-v003.json` define a 1–4 hour strategy that tests whether alts catch up after lagging their BTC beta. It runs on verified 1-minute kline Parquet under `data/bars`. `pnpm residual:history`, `residual:study`, `residual:backtest`, `residual:walk-forward`, `residual:holdout` and `residual:live` share one causal engine and paper simulator. Live mode prints signals for users and records paper outcomes from Binance REST. The October 2025–July 2026 walk-forward failed both plans. See [the v003 record](docs/residual-strategy-v003.md) before using any signal.

Version v004, the catch-down short (`configs/catchdown-perp-v004.json`), uses USDⓈ-M perp klines and funding (`residual:history -- --market usdm`); funding is charged in the simulator. `pnpm costs:sample` and `costs:report` measure order-book spread and depth into `data/costs/summary.json`.

## Daily trend breakout (v005)

`configs/trend-plan-v005.json` is the frozen plan: buy at the next daily open when an alt closes above its prior 20-day high while BTC closes above its 100-day SMA. Exit when the alt closes below its prior 10-day low or the BTC regime turns off. The plan covers 29 alts plus BTC, including pairs that were later delisted, and charges 30 bps per round trip. `pnpm trend:history` downloads checksummed daily klines from 2020 into `data/daily`, and `pnpm trend:test` writes `data/research/trend-daily-v005.json`. The engine is `packages/backtest/src/trend.ts`. The plan requires at least 200 test trades, a 30–50% win rate, a profit factor of at least 1.2 and a 95% expectancy interval above zero. The 2025–2026 test met every criterion except the interval.

## Signal delivery

The dashboard's `/signals` page shows live signals, paper outcomes and the strategy lab. The banner "This strategy failed its out-of-sample validation" is intentional and remains until a strategy passes its gate. You can record a manual fill with `POST /signals/<id>/fills`, the API's only write route. Telegram delivery (`packages/notify`) stays off unless `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set in `.env.local`.

## Services and hosting

- **macOS:** `pnpm services:install|uninstall|status|restart|logs` manages launchd agents for keep-awake, the API, both signal engines, cost sampling and context.
- **Server (Oracle Cloud Always Free, Ubuntu arm64):** `bash deploy/oci/setup.sh <repo-url>` installs Node 24 and pnpm, clones into `/opt/crosswake`, then runs tests and builds the dashboard. Then `bash deploy/oci/services.sh enable|status|logs` runs the collector, API, dashboard, engines, costs and context as `crosswake@<name>` systemd units that restart automatically.
- **Region:** use a non-US region, because Binance blocks US IPs.
- **Access:** services bind to loopback only. Reach the dashboard with `ssh -L 3000:127.0.0.1:3000 ubuntu@<ip>`.
- **Secrets:** copy `.env.local` with `scp`. Never commit it.

## Interactive research with Mastra

Mastra AgentController hosts the Research Supervisor. Set `RESEARCH_MODEL` to your chosen `provider/model` ID and set that provider's API-key environment variable. No model is selected implicitly. Collection and deterministic experiments do not need a model key. The optional project-root `.env.local` is loaded by these commands; `.env.example` remains a template.

- `pnpm research:supervisor -- --session MY_SESSION` opens or restores a named research conversation. `/mode investigate`, `/mode experiment`, `/mode review`, `/status`, `/run v001` and `/quit` are available. Plain text invokes your configured model.
- `pnpm research:supervisor -- --session MY_SESSION --status` inspects the session without inference; a model ID is still required to construct the controller.
- `pnpm research:experiment -- --protocol v001` runs the deterministic Mastra Workflow without any model or API key. It fails explicitly until frozen clock coverage exists.
- `pnpm research:api` serves a read-only local evidence API at `http://127.0.0.1:4112`. Routes: `/health`, `/live`, `/context`, `/protocols`, `/protocols/ID`, `/experiments`, `/experiments/ID`. It does not start automatically or expose conversation/credential data.

Investigate and review expose evidence tools; experiment additionally allows registered walk-forward runs. The controller delegates data and evidence reviews to constrained specialists. A pre-execution processor rejects forked delegation and child model overrides so declared tool constraints remain effective. No shell, arbitrary file access, holdout-consumption or execution tool is registered. Holdout evaluation remains the explicit human CLI command above.

Research conversations and workflow snapshots use local libSQL in `data/research-runtime/mastra.db`. Host bindings under `data/research-runtime/sessions/` preserve explicit research state. Permissions are reapplied when a session opens. A crashed running experiment becomes interrupted; workflows do not restart automatically. Inspect session `.lock/owner.json` and the actual process before removing a stale lock. Completed reports under `data/experiments/ID` have integrity receipts; failed/incomplete directories are not research evidence and cannot be overwritten.

The workflow verifies protocol and dataset, calls the existing pure TypeScript evaluator, then publishes reports and selection provenance. Those numerical modules have no Mastra or model imports. Live model/tool invocation still needs provider configuration and an end-to-end provider smoke test; the verified deterministic path works without inference.

## Evidence dashboard, context and operations

- `pnpm dashboard` starts the local workbench at http://127.0.0.1:3000; start `pnpm research:api` alongside it. Overview, signals, frozen protocols, completed experiments and context read verified local evidence. The app displays unavailable/empty states explicitly. Use Ctrl/Cmd+K to find a view, arrow keys to select and Escape to close dialogs.
- `pnpm dashboard:build` builds production assets. `pnpm --filter @crosswake/dashboard start` serves that build on loopback. `pnpm typecheck:dashboard` checks its separate TypeScript project.
- `pnpm context:collect` retrieves an altFINS screener snapshot with `ALTFINS_API_KEY`; `pnpm context:collect -- --watch` refreshes it every five minutes. Requests use the documented paged screener contract and a validated response shape. Cache files retain payload hashes, receipt-time availability and a 15-minute expiry, never the API key. Context remains supplementary evidence and is not enabled as a strategy score.
- `pnpm ops:report -- --from 2026-10-06T00:00:00Z --to 2026-10-07T00:00:00Z --symbols BTCUSDT,ETHUSDT,SOLUSDT` measures an explicit whole-second interval. Every requested wall-clock second is in the coverage denominator, including downtime. Reports contain health-sampled late/rejected deltas, reconnects, sampled peak memory and current disk bytes. A run shorter than 24 hours cannot pass the gate; compare disk reports for growth. Legacy journals without health samples cannot establish historical late-event totals.

The available dashboard does not establish a profitable strategy. Configure provider credentials for real Supervisor/delegation checks, then accumulate the frozen prospective periods and forward evidence. The current BTC/ETH/SOL seed is explicitly declared; expansion to a past-only liquidity-selected universe needs its own recorded metadata and capacity assessment.

## Forward-entry strategy v002

See [the v002 implementation and validation record](docs/signal-improvements-v002.md) for the causal forward-return model, human entry timing, cost-aware reward/risk checks, liquidity filters, diagnostics, same-event controls and expectancy-led acceptance. `configs/forward-v002.json` and `research/frozen/v002.json` are opt-in; existing v001 collection and replay retain their original configuration. V002 remains unvalidated paper research. Walk-forward reports include diagnostic user delays of 5, 15, 30, 60 and 120 seconds without selecting from unseen outcomes.
