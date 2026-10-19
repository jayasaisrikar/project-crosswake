# BTC -> altcoin lead-lag experiment (1h perps)

This experiment is separate from the trend, carry and engine sleeves. The code is in `src/engine/leadlag/`, the config is in `config/leadlag.yaml` (pre-registered), and the outputs are in `reports/leadlag/`.
To reproduce: `uv run python -m engine.leadlag.study`.

## Hypothesis
After a sharp BTC move (an "impulse"), altcoins respond with a delay that can be traded on hourly bars after costs.

## Method (pre-registered before looking at results)
- **Data:** Binance USDT-M perp 1h bars (`data/cleaned`), from 2020 to 2026. The leader is BTC. The followers are ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK, LTC, BCH, TRX and EOS. FTT and LUNA are excluded because they collapsed. The analysis uses log returns, and synthesized (`is_filled`) bars are masked.
- **Impulse at bar t:** `|r_BTC[t]| > k * sigma[t]`, where `sigma` is the std of the previous 720 bars (30d). The current bar is excluded, so the rule is causal. k is 2 or 3.
- **Beta:** a trailing 720-bar OLS beta of alt on BTC. It is shifted by 1, so it is causal, and it stays fixed over the horizon.
- **Outcomes:** all are signed by the impulse direction, so a value above 0 means the alt keeps moving in BTC's direction.
  - `gap` = beta·r_BTC[t] − r_alt[t]. This is the alt's under-reaction *within* the impulse hour.
  - `raw_h` = the alt's return over bars t+1..t+h, i.e. from the impulse bar close. h is 1, 2, 4, 8 or 24.
  - `abn_h` = raw_h − beta·(BTC return over t+1..t+h).
- **Inference:** results are clustered by event: the outcome is first averaged across alts at each event, then the mean is tested over events with a Newey-West HAC t-stat (maxlags = h). The hit rate is the share of events above 0. Results are split into dev (≤ 2024-06-30) and holdout, and also shown by year.
- **Gate for building a strategy:** in dev, the tradable outcome (`raw_h`/`abn_h`) had to be positive with t > 2. `gap` cannot be traded: it is realized inside the bar that defines the event.

## Results — event study (mean in bps, HAC t, hit rate)

k = 2 (dev: 2071 events, holdout: 1072 events)

| metric | dev mean | dev t | dev hit | holdout mean | holdout t | holdout hit |
|---|---|---|---|---|---|---|
| gap (in-bar) | **+14.2** | **5.01** | 0.60 | +3.1 | 1.08 | 0.56 |
| raw_1 | −4.4 | −1.39 | 0.45 | +0.2 | 0.05 | 0.46 |
| raw_2 | −8.0 | −1.82 | 0.46 | −0.7 | −0.15 | 0.49 |
| raw_4 | −11.1 | −1.75 | 0.48 | +2.7 | 0.44 | 0.50 |
| raw_24 | −14.7 | −1.06 | 0.49 | −2.9 | −0.25 | 0.49 |
| abn_1 | −1.9 | −1.07 | 0.49 | −0.2 | −0.11 | 0.48 |
| abn_2 | −5.2 | −2.21 | 0.49 | −1.9 | −0.71 | 0.49 |
| abn_4 | −5.4 | −1.72 | 0.48 | −1.5 | −0.47 | 0.50 |
| abn_8 | −6.7 | −1.73 | 0.48 | +2.1 | 0.41 | 0.50 |
| abn_24 | −24.4 | −2.92 | 0.48 | +7.2 | 0.92 | 0.50 |

k = 3 (dev: 775 events, holdout: 399 events)

| metric | dev mean | dev t | holdout mean | holdout t |
|---|---|---|---|---|
| gap (in-bar) | **+31.6** | **5.18** | +6.9 | 1.32 |
| raw_1 | −3.0 | −0.47 | +0.8 | 0.12 |
| abn_1 | −1.3 | −0.35 | −3.9 | −0.95 |
| abn_4 | −6.8 | −1.15 | −6.8 | −1.14 |
| abn_24 | −23.5 | −1.60 | −9.3 | −0.76 |

In-bar `gap` by year (k = 2, bps / t): 2020 +27.1/3.85, 2021 +14.7/1.86, 2022 +12.5/2.82, 2023 +10.6/2.56, 2024 +0.5/0.10, 2025 +8.7/1.75, 2026 −2.6/−0.79. The gap shrinks over time. `abn_1` is never significant in any year: |t| < 1.5 at k = 2. At k = 3 it reaches |t| ≈ 1.6–2.0 in single years, with signs that alternate across years.

Full tables: `reports/leadlag/event_study.csv`. Per-event, per-alt rows: `events_k2.csv` and `events_k3.csv`.

## Results — lagged cross-correlation, corr(r_BTC[t−L], r_alt[t]), averaged over alts

| year | L=0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| 2020 | 0.641 | −0.052 | −0.020 | −0.003 | 0.005 | −0.004 | −0.019 |
| 2021 | 0.658 | −0.013 | −0.031 | 0.001 | −0.025 | −0.004 | 0.020 |
| 2022 | 0.746 | −0.011 | −0.014 | −0.006 | −0.006 | −0.002 | 0.005 |
| 2023 | 0.648 | −0.030 | 0.010 | −0.008 | 0.002 | −0.003 | −0.006 |
| 2024 | 0.648 | −0.012 | −0.014 | −0.015 | 0.003 | −0.009 | 0.010 |
| 2025 | 0.702 | −0.000 | −0.002 | −0.014 | 0.026 | 0.014 | −0.014 |
| 2026 | 0.717 | 0.001 | −0.004 | −0.001 | −0.001 | 0.011 | 0.005 |

Almost all co-movement happens in the same hour (ρ ≈ 0.65–0.75). The lag-1 correlation is small and **negative**, which points to slight overshoot and reversal rather than delayed follow-through. It has also moved toward 0 over time (−0.05 in 2020, about 0 in 2025–26).

## Verdict
**Not tradable at 1h after costs.** The pre-registered gate failed: in dev, no forward outcome is positive. Point estimates after the impulse bar close are ≤ 0, and some are significantly negative (abn_2 t = −2.2, abn_24 t = −2.9 at k = 2). The holdout shows nothing at all. As pre-registered, **no strategy was built and no backtest was run** (0 of 4 variants used). A perp round trip costs about 10 bps in taker fees (5 bps × 2) plus spread, so even the in-bar gap (~14 bps in dev, ~3 bps in holdout) could not be captured after costs, and in any case it cannot be traded at bar resolution.

Alts do react incompletely *within* the impulse hour, but they catch up within that same hour. By the hourly close the information is priced. The mildly negative forward numbers point to reversal, not lag. That was not pre-registered and is **not** claimed as an edge here, since that would mean redefining the hypothesis after seeing the data.

## Why 1h is too coarse (honest caveat)
Price discovery between BTC and the major alts on centralized exchanges happens over milliseconds to seconds, through arbitrage and market-maker quote updates driven by BTC perp. Published intraday studies of crypto lead-lag find effects at the second-to-minute scale that decay within minutes. An hourly bar cannot see a lag shorter than one hour; it only shows up as the in-bar `gap`. The positive, decaying gap is consistent with a lag inside the hour that hourly data cannot trade.

## Next steps (if pursued; no data downloaded here)
1. **1m klines** from data.binance.vision (`futures/um/monthly/klines/<SYM>USDT/1m/`): about 0.5M rows per symbol-year, a few hundred MB for 14 symbols × 3 years. Rerun this same code with lookbacks scaled ×60 and horizons of 1–30 min.
2. **aggTrades** (`futures/um/daily/aggTrades/`), for second-level response curves around BTC impulses on a few event days first, because the files are several GB per month for BTC. Also needed: bookTicker / depth to model realistic entry, since at minute scale the spread plus taker fees (~6–7 bps per side) dominate.
3. Pre-register again before looking: impulse = BTC move over N seconds > k·sigma, entry at the next trade after a latency budget (e.g. 200 ms – 1 s), fixed exit after M seconds. Without colocation, the realistic latency budget is probably the binding constraint.
