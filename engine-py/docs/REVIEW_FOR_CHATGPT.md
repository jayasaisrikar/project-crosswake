# Systematic Crypto Engine — Build Description for Independent Review

**To the reviewer:** please audit this engine critically. Check for look-ahead bias, unrealistic fills, cost
under-estimation, overfitting, data errors and wrong statistics. The attached zip contains all source code,
tests, configs, the result CSVs, the statistics JSON, the data-quality audit and the experiment logs.
The raw market data (about 180 MB) is not attached. It can be rebuilt exactly with `uv run engine download`
followed by `uv run engine clean`; every file is checksum-verified against Binance's own public archive.

---

## 1. Verdict from the builder

**The engine works technically:** it downloads, cleans, backtests, validates and reports, and the quality gates
(52 tests, lint, type checks) all pass. **The trend strategy shows a modest edge that looks real. The carry
strategy does not work after costs.**

| Strategy (net of all modeled costs, 2020-01 → 2026-09) | CAGR | Sharpe | Max drawdown | Positive months |
|---|---|---|---|---|
| Combined (50% trend / 50% carry) | 12.9% | 0.94 | −18.0% | 59% |
| Trend (TSMOM on perps) | 20.9% | 1.02 | −24.4% | 57% |
| Carry (spot long / perp short) | −1.0% | −0.32 | −17.8% | 32% |
| Benchmark: BTC buy & hold | 43.8% | 0.90 | −77.5% | 57% |

Combined yearly returns: 2020 +14.7%, 2021 +39.3%, 2022 +3.0%, 2023 +2.3%, 2024 +10.9%, 2025 +1.2%,
2026 (through September) +20.2%.

These are backtest results, not live trading. The engine does **not** beat BTC on raw return. Its case is
lower drawdown and a different return profile.

---

## 2. Research basis (why these strategies)

Five parallel web-research passes found the following:
- **BTC→altcoin lead-lag** (the original idea) is statistically real but tiny and getting smaller. Among liquid
  coins it lasts milliseconds and belongs to colocated HFT firms. In illiquid coins much of the apparent lag is
  stale-price (Epps / asynchronous trading) artifact. It was rejected as a core strategy.
- **Time-series momentum with volatility targeting** has the strongest net-of-cost evidence in crypto (Han,
  Kang & Ryu; Liu & Tsyvinski 2021; Moskowitz, Ooi & Pedersen 2012 for the general case).
- **Funding-rate carry** has historically been positive, but yields compressed after 2024 (Ethena-era
  crowding, BitMEX research).
- **Cross-sectional momentum, pairs trading and deep learning** have weak or overfit evidence after costs and
  were not built.

---

## 3. Architecture

```
config/universe.yaml      16 coins (incl. delisted LUNA, FTT, EOS), 1h bars, spot + USDT-M perps, from 2020-01
config/experiment.yaml    capital, costs, split dates, walk-forward, strategy params, allocation
src/engine/contracts.py   shared data layout + interfaces (Dataset, TargetWeights, Strategy, BacktestResult)
src/engine/data/          download.py, clean.py, load.py
src/engine/signals/       trend.py, carry.py, registry.py
src/engine/costs.py       fee + half-spread + square-root impact, stress multiplier
src/engine/backtest/      engine.py (event-driven), portfolio.py (combine sleeves, BTC benchmark)
src/engine/validation/    metrics.py, stats.py, walkforward.py (splits, HoldoutLock, ExperimentRegistry)
src/engine/reporting/     html_report.py (self-contained HTML), csv_export.py
src/engine/pipeline.py    end-to-end orchestration;  src/engine/cli.py  `engine download|clean|backtest`
tests/                    52 tests incl. no-lookahead, timestamps, costs, backtest semantics, statistics
```

Stack: Python 3.12, pandas 3.0, numpy, scipy, statsmodels, arch 8.0, plotly, managed with uv.
NautilusTrader was recommended for later live trading but was **not** used. The backtester is custom so that
every fill rule is explicit and tested.

---

## 4. Data pipeline

- **Source:** data.binance.vision (Binance's official public archive). Monthly zip files of 1h klines (spot and
  USDT-M perps) and funding-rate history. Each zip's SHA-256 is verified against the `.CHECKSUM` file.
  3,561 files were downloaded with 0 errors. 417 months returned 404, meaning the coin was not yet listed
  or already delisted; these are recorded in `data/raw/manifest.json`.
- **Raw data is immutable.** Cleaned data and derived panels are stored separately.
- **Cleaning:**
  - Detect ms vs µs timestamps per value (Binance spot switched to µs on 2025-01-01).
  - Dedupe, sort, and check OHLC sanity. There were 0 bad rows.
  - Build a full hourly index and forward-fill gaps, flagged `is_filled=True` with volume 0. Never fill past the
    last real bar, so delisted coins end.
- **Ticker-reuse handling:** a bar opening more than 90% away from the previous close is treated as a different
  asset, and the series is truncated there. This keeps the old LUNA up to 2022-05-13 and excludes LUNA 2.0.
- **Known data issues:** see `data/cleaned/audit.json`.
  - FTT spot has a 7,467-hour frozen gap after the FTX collapse. It is flagged as filled.
  - EOS bars end in May 2025 (ticker rename), but its funding series continues.
  - FTT spot and perp are different-priced instruments in 2025.
  - Only 31 hours are filled on major spot pairs. Some perps have one 72-hour gap.
- **Survivorship:** a symbol is tradable at time t only if it has a real, non-stale bar at t. The universe still
  was **chosen in 2026**, so survivorship bias is only reduced, not eliminated.

---

## 5. Strategies (pure, causal functions shared by backtest and future live trading)

**Causality rule** (enforced by `tests/test_no_lookahead.py`):
`f(data.truncate(t)).loc[t] == f(data).loc[t]`. Perturbing any data after t must not change the weights at t.

### Trend (`signals/trend.py`)
- **Decision time:** daily at 00:00 UTC, on perps, using bar closes up to the decision bar only.
- **Score:** the mean over lookbacks L ∈ {20, 60, 120} days of `sign(close_t / close_{t−24L} − 1)`, giving a value
  in [−1, 1]. Long and short are both allowed.
- **Raw weight:** `score / asset_vol`, where asset vol is the 30-day realized vol of hourly returns
  (inverse-vol risk parity).
- **Portfolio scaling:** the whole row is scaled so that its ex-ante portfolio vol equals a 20% annual target.
  Ex-ante vol is the proposed weights applied to the trailing 30 days of returns, using data ≤ t only.
- **Caps:** at most 25% per asset and at most 2.0× gross leverage.
- **Eligibility:** a valid close, no stale run longer than 24 bars, full lookback history, and vol > 0.
- **Bug fixed during the build:** v1 vol-targeted each asset separately and summed them, which produced 112%
  portfolio vol and a −91% drawdown. v2 uses the portfolio-level scaling above.

### Carry (`signals/carry.py`)
- **Position:** delta-neutral, long spot +w and short perp −w on the same coin.
- **Decision times:** 00:00, 08:00 and 16:00 UTC.
- **Entry and exit:** enter when the trailing 72h mean funding × 1,095 exceeds 10% APR. Exit when it falls
  below 2% (hysteresis).
- **Sizing:** active symbols are equal-weighted, at most 20% each, with total gross across both legs of at most
  1.0.
- **Eligibility:** both legs must be tradable, and the basis guard `|spot/perp − 1| ≤ 2%` must hold.
- **Bug fixed during the build:** v1 lacked the basis guard. It "hedged" FTT spot against an FTT perp trading
  at 0.28–2.5× the spot price, which caused a −23% loss in 2025. A regression test now covers this.

---

## 6. Backtester (`backtest/engine.py`)

**Fills and costs**
- Weights decided at bar t (using the bar-t close) are executed at the **open of bar t+1**. There are never
  same-bar fills.
- **Target notional** = weight × equity at the execution open. Trades smaller than 0.1% of equity are skipped.
- **Cost per trade:**
  - fee: 10 bp spot, 5 bp perp (Binance VIP0 taker)
  - half-spread: 0.5 bp for BTC and ETH, 2 bp for others; these are configured estimates, not measured
  - impact: `0.7 × daily_vol × sqrt(notional / ADV) × notional`; ADV and vol are causal, 30-day trailing
  - all three components are multiplied by a stress multiplier

**Funding, delisting and failure**
- **Perp funding:** at each funding event, cash −= qty × mark × rate. A short position receives positive funding.
- **Delisting:** if a held symbol's price turns NaN, the position is force-closed at the last close at 2× cost.
- **Shorts:** negative spot weights raise an error. Perp shorts are allowed.
- **Ruin:** if equity reaches 0 or below, everything is liquidated and the backtest stops.

**Portfolio**
- Sleeves run on capital × allocation (50/50). Combined equity is the sum of the sleeves; there is no
  rebalancing between sleeves.
- The benchmark is BTC spot buy & hold with the same cost model.

---

## 7. Validation methodology

- **Chronological split:**
  - Development period: 2020-01-01 → 2024-06-30.
  - Holdout: 2024-07-01 → 2026-09-30. It is locked by `HoldoutLock`, and every unlock is appended to
    `experiments/holdout_log.jsonl`.
- **Holdout disclosure:** the holdout was unlocked twice. The second unlock came after the FTT data-integrity
  fix. No parameters were tuned; all strategy parameters are the original pre-declared values.
- **Experiment registry:** `experiments/registry.jsonl` logs every run, with params hash, data hash and metrics.
- **Trial grid for trend:** 3 lookback sets × 3 vol targets = 9 trials. They feed the deflated Sharpe and PBO.
- **Statistics** (`validation/stats.py`, computed on daily returns):
  - HAC (Newey-West) t-stat of the mean.
  - Stationary block-bootstrap 95% CI of the Sharpe (arch).
  - PSR and Deflated Sharpe (Bailey & López de Prado 2014).
  - PBO via CSCV with S = 16 (Bailey, Borwein, López de Prado & Zhu).
  - Hansen SPA test of the 9 trend variants vs the BTC benchmark (arch; consistent p-value).
- **Walk-forward:** rolling 24-month train / 3-month test with a 1-week embargo. Parameters are fixed, not
  re-fit per fold, so this measures per-fold out-of-sample stability only.
- **Cost stress:** everything is re-run at 1.5× and 2.0× costs.

---

## 8. Full-period results (`reports/stats_holdout.json`, `reports/tables_holdout/*.csv`)

| Robustness statistic | Value | Reading |
|---|---|---|
| HAC t-stat (combined, daily) | 2.42 | mean return significant at about 5% |
| Bootstrap 95% CI of annual Sharpe (combined) | [0.17, 1.68] | excludes zero |
| Deflated Sharpe, trend (N = 9) | 0.973 | ~97% probability the Sharpe > 0 after 9 trials |
| PBO, trend grid | 0.35 | borderline; below the 0.5 coin-flip level, above the ideal of < 0.2 |
| SPA p-value vs BTC buy & hold | 0.91 | does **not** beat BTC on raw returns |

| Cost stress (combined) | CAGR | Sharpe | Max drawdown |
|---|---|---|---|
| 1.0× | 12.9% | 0.94 | −18.0% |
| 1.5× | 9.3% | 0.69 | −22.9% |
| 2.0× | 5.8% | 0.46 | −27.7% |

**Walk-forward:** 12 of 19 three-month test windows were positive. The worst window was 2022-Q3 at −13.5%, and
the best was 2024-Q1 at +14.4%.

### Monthly returns, Combined (%)

| Year | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec | Year |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2020 | −3.1 | 1.1 | −0.2 | −0.6 | 0.5 | 1.3 | 4.9 | 2.9 | −3.1 | −0.8 | 9.2 | 2.5 | **14.7** |
| 2021 | 7.8 | 8.0 | 3.8 | 9.5 | −2.4 | 1.4 | −1.0 | 4.5 | −1.1 | 0.1 | 1.7 | 2.1 | **39.3** |
| 2022 | 4.7 | −1.7 | −2.6 | −0.2 | 7.0 | 4.1 | −4.6 | −3.7 | −5.8 | 1.7 | 3.3 | 1.7 | **3.0** |
| 2023 | −0.7 | 0.7 | −4.4 | −1.6 | −2.8 | 3.1 | −3.1 | 4.6 | 0.3 | −3.8 | 5.5 | 5.1 | **2.3** |
| 2024 | −1.8 | 10.1 | 5.9 | −5.2 | −7.1 | 3.1 | −2.3 | 2.0 | −6.2 | 1.1 | 12.6 | 0.2 | **10.9** |
| 2025 | 2.1 | 1.1 | −1.9 | −3.5 | −4.6 | 2.1 | 5.1 | 2.4 | −0.6 | −5.3 | 3.4 | 1.5 | **1.2** |
| 2026 | 3.1 | 2.0 | −0.3 | −1.3 | 1.6 | 8.3 | −0.7 | 3.4 | 2.7 | | | | **20.2** |

Yearly results for trend, carry and BTC are in `reports/tables_holdout/yearly_*.csv`.

---

## 9. Known limitations, for the reviewer to scrutinize

1. **Spreads are assumed, not measured.** No historical bid/ask data is used.
2. **Fills happen at the next 1h bar open, with no latency or partial fills.** Liquidation-cascade slippage is
   only approximated by the impact model.
3. **The universe was chosen in hindsight in 2026,** so survivorship bias is reduced but not removed.
4. **Exchange counterparty risk (an FTX-type failure) is not modeled.** Carry assumes Binance stays solvent.
5. **The holdout was viewed twice,** for a bug fix with no tuning. Fully clean out-of-sample evidence now
   requires forward paper trading.
6. **The walk-forward does not re-fit parameters per fold,** so it tests stability, not the full fitting procedure.
7. **The trial grid is small,** 9 variants. The trend design choices themselves (lookback family, risk parity)
   came from the literature, which is an implicit form of multiple testing.
8. **Carry rebalances every 8h,** which likely creates excess turnover; that is probably the main reason it
   loses money.
9. **There is no inter-sleeve rebalancing,** so the combined weights drift over time.
10. **The trend backtest uses perp prices and includes funding,** but funding paid or received by trend
    positions is not reported separately.

## 10. Specific questions for the reviewer

1. Are there any look-ahead paths? Pay particular attention to vol and ADV estimation, decision-time
   alignment, and funding timing.
2. Is the next-bar-open fill model plus the cost model sufficiently conservative for 1h perp trading at
   $100k–$1M size?
3. Is the PBO / DSR / SPA implementation correct, and is N = 9 an honest trial count?
4. Is the conclusion "trend has a modest real edge; carry does not survive costs" justified by this
   evidence?
5. What should be done before paper or live trading?
