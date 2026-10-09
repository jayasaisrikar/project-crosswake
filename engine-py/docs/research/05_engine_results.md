# 05 — Engine results from the 2026-10-09 build (development period only)

All numbers come from the DEVELOPMENT period (2020-01-01 → 2024-06-30). The holdout was not read or used
for tuning. Costs use the fallback half-spreads in config (there is no `data/cleaned/spreads.json`).

**Caveat:** a second session (`crypto-f0`) edited `trend.py`, `engine.py`, `costs.py` and `pipeline.py` while
these evaluations ran. Re-run every strategy on one frozen, committed code version before relying on these figures.

## New signals (Donchian breakout, cross-sectional momentum, vol-managed trend)

| Strategy | Sharpe 1x | Sharpe 2x | CAGR 1x | Max DD 1x | Turnover (x equity / yr) |
|---|---|---|---|---|---|
| trend (existing) | 1.06 | 0.78 | 22.1% | -24.6% | 74 |
| breakout (Donchian 20/55/100) | 1.27 | 1.18 | 28.4% | -28.3% | 21 |
| xsmom (30d skip 1d, terciles) | 1.30 | 1.12 | 29.9% | -24.4% | 39 |
| trend_regime (Moreira-Muir) | 0.89 | 0.60 | 18.1% | -32.3% | 76 |
| equal-risk blend trend+breakout+xsmom | 1.53 | 1.30 | 27.8% | -20.5% | ~45 |

How the blend is built: weights are the inverse of each sleeve's volatility over the whole development
period, so the blend is slightly in-sample.

Correlation of daily returns:
- trend vs breakout: 0.74
- trend vs xsmom: 0.26
- breakout vs xsmom: 0.35
- trend vs trend_regime: 0.95

## Rebuilt carry

Changes:
- a fixed weight per coin, with at most 5 coins
- rebalances every 24 hours
- a no-trade band of 0.25 × the target weight
- enters only if 14 days of funding exceed 2× the round-trip cost (38 bps)

| Variant | Sharpe | CAGR | Total costs | Funding received |
|---|---|---|---|---|
| V1 (chosen) | 4.13 | 7.2% | ~$7.1k | $43.4k |
| V2 max_positions 3 | 3.40 | 7.2% | ~$8.3k | $45.1k |
| V3 entry margin 1.0 | 3.17 | 7.0% | ~$17.1k | $52.6k |
| V4 lookback 168h | 3.99 | 7.6% | ~$6.0k | $45.1k |

The development period includes the very high funding of 2021. Published research (see 01_signals.md)
shows carry decaying from 2024 and turning negative in 2025, so do not expect a Sharpe of about 4 live.

## Trials count (needed for the deflated Sharpe)

New trials in this build:
- carry: 4 variants
- new signals: 4 strategies + 1 blend

Add these to the experiment registry before any final selection.

## Recommended next configuration (to be confirmed by paper trading, not by more backtests)

- Core: trend alone. The blend of trend, breakout and xsmom was the dev-period pick, but it decayed on the holdout (see below). Leave trend_regime switched off.
- Carry: a small sleeve that trades only when the cost gate passes.
- Expected live Sharpe is about half of the development figures (about 0.6–0.8), with drawdowns of 20–30%.

## Holdout evaluation (frozen, run once, logged in experiments/holdout_log.jsonl)

| Strategy | Dev Sharpe | Holdout Sharpe (Jul 2024–Sep 2026) | Holdout return | Holdout max DD |
|---|---|---|---|---|
| trend | 1.08 | 0.92 | +46.5% | -18.8% |
| breakout | 1.27 | 0.26 | +7.4% | -25.6% |
| xsmom | 1.30 | 0.20 | +4.7% | -31.6% |
| carry (rebuilt) | 3.96 | 1.31 | +0.7% | -0.2% |
| blend (frozen weights) | 1.54 | 0.57 | +20.6% | -18.0% |
| BTC buy & hold | 1.06 | 0.51 | +33.2% | -53.7% |

Over Crosswake's window (Jan 2025 – Sep 2026): trend returned +33.0% (Sharpe 0.90, max DD -16.1%),
the blend +12.7% (Sharpe 0.49, max DD -11.7%) and BTC -10.6% (max DD -53.7%). Breakout and xsmom
decayed as the research predicted, so trend alone remains the recommended signal.
Full comparison: reports/comparison_crosswake.html.
