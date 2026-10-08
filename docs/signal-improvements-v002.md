# Executable BTC transmission research v002

Requested 8 October 2026. This document records the implementation scope before code changes. The objective is to test whether BTC information predicts profitable altcoin movement after an achievable user entry delay. A 30–50% win rate is acceptable only with positive net expectancy and sufficient payoff; no win rate or profitability is promised.

## Preserve provenance

Keep v001 configuration, frozen research and legacy replay semantics intact. Introduce opt-in v002 settings and a separate research plan. Do not restart the active collector, consume a holdout, place orders, or overwrite recorded evidence. Historical archives without quotes remain research-only.

## Implementation

1. Add cumulative signal funnel diagnostics, including missing/incomplete data, insufficient fitting history, impulse filters and candidate rejection reasons. Make diagnostics visible in research reports and live health. Document reliable collection and latency requirements.
2. Add a causal forward-return model. Features end at the observation clock; labels start after a declared entry delay and finish strictly before fitting. Use chronological inner validation to compare BTC-plus-alt momentum against alt-only and constant-return baselines. Do not use overlapping shifted-return correlation as v002 predictive evidence. Retain legacy relationship diagnostics separately.
3. Add explicit human entry delay, finite signal lifetime, price limits and actual-entry target/stop economics. Test 5/15/30/60/120-second delays with the shared replay engine. Reject entries whose remaining target payoff fails net reward/risk or cost requirements. Signal scores must be labelled heuristic, not win probabilities.
4. Add past-only universe eligibility from observed quote volume, spread and quote completeness. Rank eligible candidates by predicted net opportunity; preserve one fill per BTC event. Require evidence of order-size support and disclose that sampled quotes cannot establish book depth or market impact.
5. Report delayed-entry and cost stress, simple same-event BTC and alt-momentum comparison outcomes, realized net payoff ratios, breakeven win rate, drawdown and event concentration. Baselines and simulated fills must disclose execution limitations.
6. Version acceptance policy: preserve legacy >55% gates; add explicit expectancy-led acceptance for v002 with sample/event/asset requirements, positive event-cluster expectancy confidence bound, profit factor and a declared drawdown limit. Keep win-rate estimates and intervals descriptive unless a minimum is explicitly specified.
7. Add deterministic adversarial tests for simultaneous reactions, true delayed effects, missing data, feature/label causality, delay expiry, target/stop accounting, ranking, universe filters, policy compatibility and frozen provenance. Run all repository tests and type checks, formatting checks and dashboard build where affected.

## Acceptance and limits

Engineering acceptance requires all applicable tests and checks to pass, old frozen files to remain verifiable, and the new path to be runnable with explicit configuration. Statistical acceptance additionally requires new unseen data and reconciled forward paper evidence. Synthetic tests cannot establish alpha. Universe expansion is opt-in and requires prospective quote collection; it must not silently alter the running seed. Live delay measurements, actual depth/impact calibration and sustained collection require observation beyond this implementation session.

## Delivery record

Implementation results, commands, tests and remaining empirical gates will be appended here after verification.

## Implemented contract

- `configs/forward-v002.json` selects the new engine. The original config has no added defaults, so its hash, entry decisions and replay event shapes stay compatible. `research/frozen/v001.json` is untouched; `research/frozen/v002.json` freezes the separate protocol.
- The forward model fits BTC and altcoin trailing returns jointly. Whole observation spans are disjoint and anchored to absolute time. The earliest 75% trains coefficients; the latest 25% estimates prediction error against alt-only, BTC-only and constant baselines. At least 60 training and 20 validation observations are required in the production config. BTC must improve validation MSE over alt-only by at least 5%, beat the constant baseline and have positive fitted loading. These are hypotheses, not calibrated probabilities or significance claims. Coefficients are not refit on the inner validation labels.
- Labels start after the declared data budget, processing delay, user delay and one-second quote-sampling step. Receipt times censor unavailable training labels. The default is 8 seconds data budget + 2 seconds processing + 30 seconds user delay + 1 second sampling = 41 seconds. The eight-second budget accommodates the collector's seven-second allowance plus second-boundary closure jitter. Exceeding the budget rejects the signal; the budget is not an uptime guarantee.
- Entry eligibility uses the declared clock floor even when data arrive early. Entry requires a fresh quote in the following one-second window. Late quotes time out rather than shifting the trained outcome horizon. Signal lifetime is an additional absolute upper bound, not permission to enter at any time before expiry. A five-minute outcome horizon matches the maximum holding period; stops and targets may exit sooner.
- The forward forecast estimates a midpoint return after delayed entry. For conservative execution, the target is anchored to the observed decision price plus 70% of that forecast, never moved upward to chase an entry. Ask-to-target-bid reward embeds spread; fees and modeled slippage are deducted once. Remaining net reward must be at least twice the modeled net stop loss. This target is not a calibrated probability of hitting a barrier.
- Universe eligibility uses only the preceding hour, requiring 99% fresh, complete, narrow-spread quotes and at least 1 million USDT observed quote volume. Missing wall-clock seconds stay in the coverage denominator. Candidate ranking uses predicted net target opportunity; entry then checks the size/volatility proxy at the actual quote. Defaults use 100 USDT notional, at most 0.1% participation in the preceding observed minute, one open position overall, and one fill per BTC event. These provisional capacity numbers require empirical calibration. The seed remains ETH/SOL; use a separately declared prospective universe before evaluating more symbols.
- The old `confidence`, correlation and lag configuration fields are retained for schema compatibility. In forward mode, the score is the clipped incremental validation skill, explicitly marked `HEURISTIC_NOT_WIN_PROBABILITY`; legacy confidence/correlation/lag thresholds do not select v002 trades. The legacy-shaped relationship projection in reports is compatibility metadata; `forecast` contains the actual forward model and its diagnostics. No fitted delay is claimed by that projection.
- Walk-forward test blocks include 5/15/30/60/120-second user-delay reruns, each fitted using labels for that delay. Those outputs are diagnostic only and never feed selection. BTC-buy and alt-positive-momentum controls run on the same selected events, using the same timing, quote fills and cost proxy with fixed holding periods. They are conditional attribution controls, not independent market-wide benchmarks. Their stops/targets, chase and retracement checks are disabled explicitly. Different fill eligibility and exposure can yield different trade counts.
- Cost stress changes costs on existing fills; it does not pretend to model changed liquidity, fills or selection. Both baseline and delayed-run reports retain censored/unfinished states. Additional order-book collection and empirical notification-to-order timing remain necessary.
- The expectancy policy keeps at least 500 closed trades, 500 distinct BTC events in the new plan, two assets, profit factor at least 1.3, a positive event-cluster bootstrap lower bound, no unobserved position paths, and no unfinished positions. It adds equal-notional cumulative drawdown and asset P&L concentration limits. Its win-rate floor is explicitly zero: win rate and Wilson bounds are reported rather than forced toward 55%. This admits a profitable 30–50% strategy without preferring it over a better higher-win-rate strategy. Drawdown is measured in trade-notional basis points, not percentage loss of user capital.

## Running and reviewing

The new frozen protocol begins with prospective training on 9 October 2026 UTC, evaluates two weekly test blocks through 6 November, and reserves 6–20 November as its final holdout. These dates do not guarantee adequate coverage or trade count. No holdout has been consumed.

```sh
# Exploratory analysis; output must be a new directory.
pnpm backtest -- --config configs/forward-v002.json --data-dir ./data --source live --output data/backtests/MY_NEW_V002_RUN

# Optional half-open bounded inspection, not statistical validation.
pnpm backtest -- --config configs/forward-v002.json --data-dir ./data --source live --from 2026-10-08T10:10:00Z --to 2026-10-08T10:20:00Z --output data/backtests/MY_NEW_BOUNDED_RUN

# Once the frozen clock coverage actually exists; includes delay diagnostics.
pnpm research:walk-forward -- --freeze research/frozen/v002.json --data-dir ./data

# Separate v002 forward-paper collection; do not mix it into an existing v001 ledger.
DATA_DIR=./data/v002-forward STRATEGY_CONFIG=configs/forward-v002.json SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT pnpm collect
```

The last command starts a separate collector and is documented, not launched by this implementation. Use an always-on host with reliable connectivity, keep the machine awake, monitor complete coverage/receipt delays, and run the existing 24-hour operations gate against that directory. Do not increase latency budgets to hide outages. Resume v001 only with its original config; migrate by using a separate directory, never deleting recovery locks without checking ownership.

A changed universe, time horizon, cost assumption or tuned threshold requires a new config/protocol version and fresh unseen evaluation. Inspect rejection counts before relaxing filters. All research remains paper-only and long-only; short observations are excluded from executable metrics.

## Verification record — 8 October 2026

- Full suite: 79 tests passed, including 18 new v002 tests. Coverage includes a genuine synthetic delay versus simultaneous movement, future-data invariance, late-label censoring, unidentified fits, universe causality, all five delay scenarios, live clock adjustment, cost/size rejection, price limits, expiry, reward/risk, shared exposure, profitable 40% acceptance, legacy rejection and frozen provenance.
- The actual research CLI ran against temporary persisted quote-backed synthetic data and produced nonempty candidates/trades, comparison outcomes and cost reports. Temporary fixtures were removed. Synthetic profitability is not market evidence.
- Root TypeScript, dashboard TypeScript, and production dashboard build passed.
- Real bounded exploratory smoke processed 1,800 BTC/ETH/SOL snapshots over 600 seconds (10:10–10:20 UTC). It produced zero candidates/trades and null performance estimates. All 600 batches had data delay at most eight seconds; maximum was 7,651 ms. The funnel recorded 121 missing impulse-history checks, 479 small impulses, and two unavailable fits. The short window cannot supply the configured fit sample; this is execution/diagnostic evidence only. Local artifact: `data/backtests/v002-review-smoke-20261008/report.json`.
- Active collector configuration, historical ledgers and v001 frozen artifact were not changed. Its already-running process will not expose the new diagnostics until a normal restart on the updated code. This implementation does not claim a completed 24-hour reliability run, a validated win rate, calibrated impact, or measured end-user entry latency.
- Repository formatting and `git diff --check` passed. The v001 config, plan and frozen file have no changes; the newly frozen v002 hash verifies after formatting.
- Playwright checked the production dashboard at desktop and 375px mobile width: the readiness panel renders filter counts with no horizontal page overflow. Browser fixtures supplied the bounded-smoke counters; they were not written into collector health. The real evidence service was offline, and its 503 state was also observed. Screenshots: `output/playwright/v002-readiness-desktop.png` and `output/playwright/v002-readiness-mobile.png`. The temporary browser and preview server were closed afterward.

## Remaining empirical work

The forward regression is intentionally simple and interpretable. Repeatedly searching assets, windows or thresholds can still overfit; inner validation skill is not a corrected statistical significance test. The untouched prospective protocol is the guard against that selection. Event-cluster intervals group the declared event IDs but cannot guarantee independence between successive market shocks. Evaluate additional time-block sensitivity and multiple market regimes before making a stable-performance claim. Actual user notification and exchange-fill latency, order-book impact, and multi-user capacity are not measured by the present simulator. These require prospective observation; no unit test can certify them.
