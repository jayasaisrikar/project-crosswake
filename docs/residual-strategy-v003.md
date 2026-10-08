# BTC-relative residual strategy v003

Requested 8 October 2026 after the v002 lead-lag review. Second-scale BTC→alt lag is about 1–3 seconds on ETH/SOL, which is too fast for users acting on signals. v003 tests the version a person can act on: over 1–4 hours, an alt that lagged its BTC-implied move catches up.

## Hypothesis

For each alt, a trailing 14-day regression of 15-minute returns gives `alt = alpha + beta × BTC`. At each five-minute evaluation, the strategy measures the alt's lookback residual, `alt move − beta × BTC move`, and scales it by the fitted residual volatility (z).

- **LONG:** BTC rallied (BTC z ≥ `btcMoveZMin`) and the alt lagged by at least `entryZ`. The bet is that the alt catches up within `holdMs`.
- **SHORT** (mirror case): the alt held up while BTC fell. In spot mode these trades are research-only; in hedged mode they are executable.

A trade must also pass these filters:

- The alt's own recent residuals actually closed over the hold horizon. This "catch-up evidence" is measured causally on the fit window.
- Expected catch-up net of round-trip costs is positive.
- Reward/risk, liquidity (24h quote volume) and bar completeness clear their thresholds.

## Two instruments

- `configs/residual-spot-v003.json`: buy the alt outright on spot. Long-only executable, 10bps fee per side. The trader carries the alt's full BTC beta risk.
- `configs/residual-hedged-v003.json`: long or short the alt against `beta × BTC`, a pair trade that needs a short leg (e.g. USDⓈ-M perps). 5bps fee per side, charged on both legs. Spot prices stand in for both legs; funding and borrow are ignored.

## Execution model

- Decisions use closed 1-minute bars only.
- The entry fills at the close of the bar ending `entryDelayMs` (default 60s) after the decision.
- An entry is rejected if the price already moved more than `maxEntryDriftBps` in the trade's favour. If the price drifted in the trade's favour, the target shrinks by that drift; it never grows.
- Stops fill at the observed one-minute close, keeping adverse slippage. Targets fill exactly at the target.
- Max hold is `holdMs`. Each symbol and side can hold one position, total positions per side are capped, and a cooldown applies after each exit.
- Costs are the fee, slippage and an assumed spread on every leg. Kline data carries no bid/ask or depth.

The same `ResidualSimulator` drives backtests, walk-forward, the holdout and live paper. Fits refresh on an absolute hourly clock, so a fit depends only on its as-of bar, never on where a run started. Tests check both causality and this anchoring.

## Commands

```sh
# Verified 1m kline archives → data/bars (checksums, Parquet + manifest per period)
pnpm residual:history -- --from 2025-10 --to 2026-09 --days 2026-10-01:2026-10-07

# Filter-free edge study: forward outcomes bucketed by residual z for lookback × hold
pnpm residual:study -- --from 2025-10-16T00:00:00Z --to 2026-08-01T00:00:00Z

# Exploratory backtest of one config (in-sample; not validation)
pnpm residual:backtest -- --config configs/residual-spot-v003.json --from 2025-10-16T00:00:00Z --to 2026-08-01T00:00:00Z

# Pre-declared walk-forward: 18-variant grid, 60-day selection, 30-day unseen tests
pnpm residual:walk-forward -- --plan configs/residual-plan-spot-v003.json
pnpm residual:walk-forward -- --plan configs/residual-plan-hedged-v003.json

# One-use holdout (1 Aug – 1 Oct 2026); refuses unless the walk-forward gate passed
pnpm residual:holdout -- --plan configs/residual-plan-spot-v003.json --walk-forward PATH/report.json

# Live signals + paper tracking from Binance REST; --once bootstraps, evaluates and exits
pnpm residual:live -- --config configs/residual-spot-v003.json
```

`residual:live` prints signals readable by users: entry window, skip-above price, target, stop, exit time and the reason. It appends `signals.jsonl` and `trades.jsonl`, keeps restartable `state.json` and `health.json`, and drops signals older than 90 seconds when it is catching up. The score shown is a heuristic, not a win probability.

## Results, 8 October 2026

The data covers 1-minute Binance Spot klines for BTC plus 14 alts (ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, DOT, LTC, BCH, NEAR, UNI, SUI) from October 2025 to 7 October 2026. All 285 periods are checksum-verified with no missing periods. Evaluation runs from 16 October 2025 to 1 August 2026, after a 15-day warm-up.

**Walk-forward (pre-declared, unseen test months):**

| Plan          | OOS trades | Win rate | Net expectancy | 95% event-cluster CI | Gate                                                       |
| ------------- | ---------- | -------- | -------------- | -------------------- | ---------------------------------------------------------- |
| Spot outright | 0          | –        | –              | –                    | failed: no variant reached 30 trades in a selection window |
| Hedged pair   | 56         | 37.5%    | −43.3 bps      | [−84, −4] bps        | failed                                                     |

**In-sample, full 9.5 months, all 36 variants:** every variant loses money. The best spot variant made −18.5 bps per trade (43 trades, 40% win rate) and the best hedged variant −23.0 bps (116 trades, 38% win rate). Win rates of 26–46% fall in the targeted 30–50% band, but the average win is too small relative to the average loss. Breakeven win rates were around 58–62%.

**Filter-free study** (non-overlapping anchors, gross of costs, positive meaning the lag closed):

- Alts that lagged a BTC rally kept lagging in outright terms. Typical forward returns were −10 to −30 bps (t −2 to −3), not catch-up.
- Hedged returns for lagging alts were near zero and mostly well below the 35–45 bps pair round-trip cost. A few cells reached +13–18 bps.
- The mirror case, alts that held up while BTC fell, did tend to fall afterwards. One example: 4h lookback, 4h hold, z 1.5–2.5, BTC-confirmed, gave +32 to +50 bps outright with t ≈ 3.
- About 300 cells were inspected, and alt returns are cross-correlated. This is a hypothesis generated in-sample, not evidence.

**Conclusion:** buying alts that lag BTC over 1–4 hours has had negative expectancy in this period, after realistic costs and before costs alike. The holdout was not consumed, because no gate passed. The engine, data pipeline and live path work. The strategy hypothesis does not.

## If continuing

1. Do not tune v003 further on these months. Every rerun on the same data spends its out-of-sample value.
2. The "catch-down" short (alt held up while BTC fell, 4h horizon, executed on perps) can be frozen now as a new plan version. Test it only on data it was not discovered on: the sealed 1 Aug – 1 Oct 2026 window and prospective live paper via `residual:live` with a hedged or short-enabled config.
3. Use perp klines and funding for any short or hedged evaluation. Spot prices understate perp basis and funding costs.
4. Keep the expectancy gate. A 30–50% win rate is only useful when the net payoff ratio clears `1/winRate − 1`.

## Follow-up, 8 October 2026: catch-down short (v004), delivery and operations

**Catch-down short.** `configs/catchdown-perp-v004.json` and `configs/catchdown-plan-v004.json` were committed as a pre-registration (`f42bc39`) before any perp data or Aug–Oct outcomes were loaded. The configuration is a short on USDⓈ-M perps when an alt held up while BTC fell, with a 4h lookback, a 4h hold, z ≥ 1.5 and settled funding charged. Tested on unseen data from 1 Aug to 8 Oct 2026, it produced 349 trades with a 40.7% win rate and **−45.9 bps per trade**. The 95% event-cluster interval was [−71, −18] bps, and the gate failed. The in-sample pattern did not survive. The prospective holdout (8 Oct – 8 Nov) stays sealed.

**Measured costs.** `pnpm costs:sample` / `costs:report` sample REST order books for spot and perps. At $1k–$10k per order, round-trip impact is about 0–9 bps for most coins; ADA's spread is 4 bps and DOT spot's is 9 bps. The assumed backtest costs were realistic. Fees dominate, and the strategies failed on gross edge, not on costs.

**Delivery.** Live signals feed the dashboard at `/signals`, with a live feed and a strategy lab. Telegram (`packages/notify`) is implemented and tested against mocks, but stays off unless `TELEGRAM_ENABLED=true` and both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. Users can report their own fill for a signal from the dashboard, which measures real reaction time and slippage. This is the evidence API's only write route and it validates input strictly.

**Operations.** `pnpm services:install|status|logs|restart|uninstall` manages launchd agents for keep-awake, the evidence API, both live signal engines, cost sampling and altFINS context. The market collector is not managed this way, because its restart replays the full journal chain. Late-event bursts were traced upstream: during a burst, exchange-to-receipt latency rises to 2–8 seconds and trade counts collapse, while local bucket closing stays on time. Disk has 34 GB free, and the raw journal grows about 1.7 GB/day.
