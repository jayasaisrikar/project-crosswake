# v009 · Kalman-hedged residual pairs (alt vs BTC) on USD-M perps

**Status:** research engine built 17 Oct 2026. Not live and not wired to Telegram or a service. Results are below.

**Prior expectation, stated before any run: probably a null.** The hedged round trip costs 16 × (1 + |β|), about 35–45 bps, and the v004 hedged replay lost 872 bps over 35 trades. v009 exists to give a clean, one-shot answer, not to rescue the idea.

## Why

v003/v004 measured an alt − β·BTC **return** residual over a fixed lookback, with β from a static 14-day OLS on 15-minute returns. Live and in replay, gross per trade ≈ cost (~17 vs 16 bps).

v009 tests the standard stat-arb formulation instead:
- a **time-varying hedge ratio** (Kalman filter) on **log price levels**;
- a rolling z-score of that spread;
- gated by **cointegration and half-life**;
- traded as a **true hedged pair** on perps in both directions;
- exiting on **reversion of the spread** rather than a fixed clock.

A **static-OLS control** with otherwise identical rules runs alongside, so the Kalman hedge's effect is measured, not assumed.

## Ground rules

1. v003/v004 behaviour does not change. v009 is a separate engine with its own schema. The v003/v004 config hashes are pinned in tests, and a v004 fixture run's trade digest was recorded before the simulator change and is checked byte for byte.
2. Everything is causal, with truncation tests on every new function.
3. The parameters below are the pre-registration. They are not tuned after any run on real data. Code-correctness fixes go under **Amendments**.
4. There is no live service, systemd unit or Telegram delivery. Live paper is a separate task, and only after a holdout PASS.
5. The holdout is spent once. The control never spends one.

## Model

**Kalman hedge** (`packages/quant/src/kalman.ts`, ported from stat-arb `src/stats/kalman.ts` and checked against it to 1e-12 on a committed fixture):
- The state `[β, α]` is a random walk, with observation `ln alt = β·ln btc + α + ε`.
- Each step exposes the **prior** `betaPrior/alphaPrior` (t|t−1). The spread is built only from these.
- `delta` sets the process noise.
- `initBars` sets an OLS warm start.
- `scaleObsVar` sets the observation variance to the warm-up residual variance.
- A missing sample gives no update. The covariance still grows once.

**Spread and z** (`packages/quant/src/spread.ts`):
- `spread_t = ln alt_t − betaPrior_t·ln btc_t − alphaPrior_t`. The OLS control uses one OLS fit per refit instead.
- `z_t` is the spread at t against the mean and sample sd of the last `zWindowBars` 15-minute samples, including t.
- `innovationZ` (error/errorStd) is logged only and never traded.

**Fit (hourly, absolute clock)**, using samples in `(fitClock − 14 d, fitClock]`:
- At least 90% of the sample pairs must be present.
- Engle-Granger p-value, from `stationarity.ts`.
- A fresh Kalman run over the window. Its final state is carried forward one step per new sample until the next refit.
- The half-life of the spread.
- Benjamini-Hochberg FDR across symbols at `fdrQ`.
- A symbol passes a refit if it survives BH, has p ≤ 0.05, a half-life within [4, min(96, 1344/10)] samples and 0.2 ≤ β ≤ 3.0. It is **eligible** if it passed the last `persistenceRefits` refits.

**Signal** (`packages/signals/src/kalman-residual.ts`):
- z > 0 means the alt is rich, so **SHORT** the spread (short alt, long β·BTC). z < 0 means **LONG** the spread.
- In hedged log-return units:
  - target = |spread − mean| − exitZ·sd;
  - stop = (stopZ − |z|)·sd;
  - hold = min(3 × half-life, 24 h);
  - cost = 16 × (1 + |β|) bps.
- The mean and sd are frozen at entry.
- Rejection reasons: `insufficient_liquidity`, `incomplete_bars`, `edge_below_cost` (target < 2 × cost), and `beyond_stop_z` (see amendments).
- Events use 4-hour buckets. At most 2 positions per event and side, 3 concurrent positions per side, and a 4-hour cooldown.

## Pre-registered values

`configs/residual-kalman-perp-v009.json`:
- **Universe:** 15 perps.
- **Sampling:** evaluate every 15 m, refit every 1 h, 14-day window.
- **Kalman:** δ = 1e-5, initBars 672, scaleObsVar.
- **Signal:** zWindow 96, entry z 2, exit z 0, stop z 4.
- **Eligibility gate:** p ≤ 0.05, FDR q 0.10, persistence 3 refits, half-life 4–96 samples with ≥ 10 cycles in the window, β from 0.2 to 3.
- **Costs:** 5 + 2 bps per side plus a 2 bps spread.
- **Execution:** entry delay 1 m, drift ≤ 25 bps, 24 h volume ≥ $20M, missing bars ≤ 2%.

The control, `-ols.json`, is identical except for `version` and `hedgeModel: "ols"`.

The plan is `configs/residual-kalman-plan-v009.json`:
- **Grid:** entryZ {2, 2.5} × zWindowBars {48, 96}, 4 variants.
- **Data and walk-forward:** data from 2025-01-01, first test 2025-05-01, walk-forward ends 2026-06-01. Selection windows are 60 days and test windows 30.
- **Holdout:** **2026-06-01 → 2026-10-01**.
- **Acceptance:** 500 trades, 30% win rate, profit factor 1.3, 200 events, 5 assets, max drawdown 3000 bps, ≤ 30% of P&L from one asset.

The control plan, `residual-kalman-plan-v009-ols.json`, is the same plan on the control config. It runs walk-forward only.

## Decision procedure

- **A.** Walk-forward for Kalman and for the control.
- **B.** The holdout is opened only if **all** of these hold on the Kalman walk-forward's out-of-sample trades:
  1. net expectancy > 0 and its cluster-bootstrap 95% lower bound > 0;
  2. gross per trade ≥ 1.5 × cost;
  3. net still > 0 at 2× fee, slippage and spread;
  4. at least 5 trades a day;
  5. Kalman net > OLS-control net.

  Otherwise the result is **NULL at walk-forward** and the holdout stays sealed. The check is `pnpm residual:step-b`, and `residual:holdout` refuses to run unless it passes.
- **C.** The holdout runs once. It PASSes only if the evidence gate and B1–B3 hold on the holdout trades.
- **D.** On PASS, live paper becomes a separate task: at least 90 days, at least 200 trades, and a hash-chained ledger.

## How to run

```bash
pnpm residual:history -- --config configs/residual-kalman-perp-v009.json --from 2024-12 --to 2026-05
pnpm residual:walk-forward -- --plan configs/residual-kalman-plan-v009.json
pnpm residual:walk-forward -- --plan configs/residual-kalman-plan-v009-ols.json
pnpm residual:step-b -- --walk-forward <KALMAN>/report.json --control <OLS>/report.json
# Only if step-b says go, and once:
pnpm residual:holdout -- --plan configs/residual-kalman-plan-v009.json --walk-forward <KALMAN>/report.json --control <OLS>/report.json
```

Walk-forward writes `report.json`, which includes `outOfSampleTrades` and `testDays`, and `diagnostics.json`, which holds the dispersion ratio of every fit, eligible evaluations per symbol and the funnel, for each variant.

## Implementation notes

These don't change any rule, but they are recorded here so the code can be checked against the spec.

- **Persistence is recomputed from bars.** It does not use a process-lifetime counter: the engine fits the previous refit clocks when it hasn't seen them. A run started at any bar after warm-up gives the same signals as one started earlier, and a test checks this.
- **Funnel reconciliation.** A z that can't be computed (missing samples in the window) is counted as `fit_unavailable`. That keeps evaluations × (symbols − 1) = not_cointegrated + fit_unavailable + spread_inside_band + side_not_generated + residual_triggers.
- **Simulator changes are behind an engine interface.**
  - Evaluation near the window end is gated by `engine.minHoldMs` (= `holdMs` for v003/v004).
  - Each signal's own hold is then checked, with `hold_past_window`.
  - Time exits use `signal.holdMs`.
  - `maxPositionsPerEvent` is optional, so v003/v004 have no cap.
- **Holdout lock.** It uses the residual harness's existing one-shot lock in `data/research-locks/` (`residualHoldout`), the same mechanism v003/v004 use.
- **The control has its own plan file,** because the CLI takes a plan path.
- **`history` accepts a v009 config.** It needs only `symbols` and `market`.
- **`study` isn't available for `--engine kalman`.** It replays fixed lookback/hold residuals, which v009 doesn't have, so use `backtest --engine kalman`.

## Amendments

- **2026-10-17, `beyond_stop_z`.** A trigger with |z| ≥ stopZ has a stop distance ≤ 0, which would stop out instantly. These triggers are now rejected with `beyond_stop_z` instead of being entered. This is code correctness, and it was made before any run on real data.

## Findings before any real-data run

On the synthetic test pair (OU spread with a 16-sample half-life, β = 1.5, 6-day window), the frozen δ = 1e-5 Kalman spread absorbed most of the deviation: dispersion ratio ≈ 0.29, half-life ≈ 0.8 samples.

| δ | Dispersion ratio | Half-life (samples) |
|---|---|---|
| 1e-5 | 0.29 | 0.8 |
| 1e-7 | 0.47 | 3.5 |
| 1e-9 | 0.92 | 14 |

At 1e-5 the half-life falls below `halfLifeMinBars` = 4, so the Kalman variant may rarely become eligible on real data. That is the "Kalman absorbs the spread" failure mode in spec §3.4. The values are **not** changed. The engine tests use δ = 1e-9, marked test-only, to exercise the mechanics.

## Results

```
Pre-flight (§8.1): locks checked [workstation: none; OCI box: NOT CHECKED], v004 reports [none on workstation], coverage [pending]
Walk-forward Kalman: pending
Walk-forward OLS control: pending
Dispersion ratio (median, IQR): pending
Step B verdict: pending
Holdout (if run): not run
Final verdict: pending
Post-hoc (labelled, not used for any decision): not run
```
