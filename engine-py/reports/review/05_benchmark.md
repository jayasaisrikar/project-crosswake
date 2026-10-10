# 05 — Benchmark against real products, data gaps, prioritized improvements

Date: 2026-10-10. Scope: research only, no code changes. Repo state read from README §0, ARCHITECTURE.md,
AUDIT_REPORT.md, DATA.md, `src/engine/validation/stats.py`, `src/engine/research/{splits,multiple_testing}.py`,
`src/engine/costs.py`.
Rule used: a competitor feature is listed only if it was confirmed in that product's docs or repo during this
review (URLs given). "Not verified" means I did not confirm it, not that the feature is missing.

## 1. What this engine is (for comparison)

- Python 3.12, **hourly** Binance spot + USD-M perp bars and funding (2020 to Sep 2026). Bar-close decisions,
  next-open fills. Cost model: fee + half-spread table + impact term with a participation cap (`src/engine/costs.py`).
  Paper trading only.
- Research discipline: pre-registered hypotheses (H-xxxx), a promotion-rules file frozen before results
  (`config/promotion_rules.yaml`), a sealed H2 holdout (>= 2025-10-01) where every opening is logged
  (`experiments/holdout_log.jsonl`), append-only experiment registries, a point-in-time store with
  event/publication/availability times, a PIT universe, purged k-fold and walk-forward
  (`research/splits.py`), PSR/DSR, PBO via CSCV, Hansen SPA, HAC t-stat, block bootstrap
  (`validation/stats.py`), and BH/Holm (`research/multiple_testing.py`).
- Known limits: hourly bars only. OI, liquidation and order-book models are stubs that raise
  `DataUnavailable`. Batch 001 found 0 promotions, PBO = 1.00 looks degenerate, there is an `st_reversal`
  crash, and `ridge` was too slow.

## 2. Product-by-product

| Product | Does better (verified) | This repo does better | Gap that matters for research |
|---|---|---|---|
| **Freqtrade** ([lookahead](https://www.freqtrade.io/en/stable/lookahead-analysis/), [hyperopt](https://www.freqtrade.io/en/stable/hyperopt/)) | `lookahead-analysis` re-runs the backtest per signal and diffs the indicators automatically (an empirical bias detector). There is also a recursive-analysis tool. Hyperopt uses Optuna (NSGA-III sampler), 12 loss functions including per-pair drawdown and MultiMetric with a trade-count penalty, `--min-trades`, and decimals capped at 3 places to limit overfitting. Live exchange adapters, Telegram/web UI. | Freqtrade's own docs describe **no** out-of-sample/walk-forward split, DSR, PBO or holdout log for hyperopt. Here trial counts feed DSR, and the holdout is sealed and audited. | An automated **look-ahead diff harness** over every model. The repo has truncation tests (README rule 4), but Freqtrade's "run it and diff" approach is a cheap model to copy for new models. |
| **FreqAI** ([docs](https://www.freqtrade.io/en/stable/freqai/)) | Periodic retraining during live runs (background thread), and a backtest that emulates that retraining. Outlier removal on training and prediction data. Eight example models (LightGBM, CNN, RL). | Calibration + net-edge + NO-TRADE gating, and a prediction ledger scored at expiry. FreqAI's docs show no pre-registration or multiple-testing control. | The repo's `fit(data, end)` contract supports refit, but refit **cadence** is not yet part of what gets pre-registered. Retrain frequency is a hidden degree of freedom. |
| **Hummingbot** ([site](https://hummingbot.org/), [V2](https://hummingbot.org/strategies/v2-strategies/)) | 318 CEX/DEX connectors, market-making focus, V2 controllers/executors with an event queue, Apache-2.0. | Statistical validation; Hummingbot is execution infrastructure, not a research lab. | Not relevant for an hourly research engine. Revisit only if a maker/liquidity-provision edge is ever studied. |
| **Jesse** ([docs](https://docs.jesse.trade/)) | Multi-timeframe and multi-symbol without look-ahead. Optuna + Ray optimization with separate train/test periods. Live trading and alerts. | Purged CV, DSR/PBO/SPA, PIT universe, holdout audit trail. | Nothing essential. Jesse's train/test split is weaker than what the repo already has. |
| **NautilusTrader** ([backtesting](https://nautilustrader.io/docs/latest/concepts/backtesting/), [fill models](https://nautilustrader.io/docs/latest/concepts/backtesting/fill-models)) | Event-driven, and the same components run in backtest and live. Fills walk L2/L3 book levels. `ProbabilisticFillModel`, `ThreeTierFillModel` and `CompetitionAwareFillModel`, `prob_fill_on_limit`, a seeded RNG, `liquidity_consumption` per level, separate queue-position tracking. Funding and margin models. | Research governance (pre-registration, holdout, DSR/PBO). Nautilus offers no statistical overfitting tooling. | **Execution realism below 1h.** The repo's cost model is parametric. With a short horizon (4h reversal, lead-lag), the edge is the same size as the spread/impact error. Nautilus shows what "honest fills" look like if the engine ever goes sub-hour. A latency model was not verified on the pages fetched. |
| **QuantConnect LEAN** ([repo](https://github.com/QuantConnect/Lean)) | Event-driven, Python/C#, pluggable model points, live brokerages, Apache-2.0. | Crypto-specific funding/basis handling, PIT event times, holdout policy. | No essential gap. LEAN is a reference design for pluggable fee, slippage and fill models (fill model details not verified). |
| **vectorbt PRO** ([site](https://vectorbt.pro/)) | Very fast Numba/Rust simulation. Over 10 CV splitters (rolling, expanding, walk-forward, **purged, combinatorial**), `@cv_split` train-only selection, and parameter **neighbourhood/surface** analysis instead of a single winner. Paid ($25/mo+). | Pre-registration, frozen promotion rules, append-only registry, PIT store. | (a) **Speed**: `ridge` was killed after about 100 min, and vectorised evaluation would allow honest full-grid DSR trial counts. (b) **Combinatorial purged CV (CPCV)**: the repo has purged k-fold + WF but no CPCV path distribution. (c) **Parameter-surface stability** as a promotion criterion. |
| **Zipline-reloaded** ([repo](https://github.com/stefan-jansen/zipline-reloaded)) | Pipeline API, PyData integration, maintained fork (pandas 2 / NumPy 2). | Crypto, 24/7, funding, PIT. Zipline does not mention crypto. | None. |
| **Backtrader** ([repo](https://github.com/mementum/backtrader)) | Rich order types (OCO, bracket, trailing), volume-based filling, analyzers, IB/Oanda live. GPL-3.0. README is years stale (2018 notes, travis-ci.org). | Everything statistical. | None. Treat as legacy. |
| **Qlib** ([repo](https://github.com/microsoft/qlib)) | PIT database, a large model zoo (LightGBM/XGB/CatBoost, LSTM, Transformer, TabNet, HIST), Alpha158/360 feature sets, automatic **rolling retraining**, a nested decision/execution framework, RD-Agent factor mining. MIT. | Pre-registration and holdout governance. Qlib's automated factor mining is the opposite of a controlled trial count. | **A standard feature-set baseline** (an Alpha158-style panel) and a rolling-retrain benchmark. Any new model should beat "LightGBM on a standard panel" before it counts. |
| **mlfinlab / Hudson & Thames** ([page](https://hudsonthames.org/mlfinlab/)) | Labelling (triple barrier, meta-labelling, trend scanning), sequential bootstrap, deflated/haircut Sharpe, profit hurdles, **minimum track record length**. Commercial licence (£100/user/month). | Already has DSR, PBO, SPA, BH/Holm, purged CV in-house, so no licence is needed. | **Triple-barrier / meta-labelling** (labels that match how the trades actually exit), **uniqueness/sample weights** for overlapping labels, **haircut Sharpe** and **MinTRL** to size the paper-trading period needed (README asks for 3–6 months without a statistical basis). |
| **OctoBot** ([repo](https://github.com/Drakkar-Software/OctoBot)) | Web/mobile UI, CCXT on 15+ exchanges, grid/DCA/basket, TradingView alerts, ChatGPT/Ollama trading mode. GPL-3.0. | Everything about validity. An LLM "opinion" mode has no validation story. | None for research. |
| **3Commas** ([site](https://3commas.io/)) / **Cryptohopper** (features page returned 403, not verified) | DCA/grid/signal bots, TradingView webhook ingestion, "custom backtesting on 1-minute candles", 9+ exchanges. | These are execution conveniences with marketing backtests. No overfitting controls are documented. | Shows the market these signals would compete in. Legal/licensing is the binding constraint (see §3). |

### Data vendors

| Vendor | Verified | Relevance |
|---|---|---|
| **Tardis.dev** ([CSV API](https://docs.tardis.dev/downloadable-csv-files/api.md), [FAQ](https://docs.tardis.dev/faq/data)) | "Historical datasets for the **first day of each month** are available to download **without API key**." Types include `trades`, `incremental_book_L2`, `quotes`, `book_snapshot_25/5`, `derivative_ticker` (OI, funding, mark, index), `liquidations`. Binance `forceOrder` liquidations are snapshot-limited (at most 1/s since Apr 2021), so liquidation data is **incomplete by construction**. | The free days give about 70 tick-level days for 2020–2026 per exchange. That is enough to **calibrate the spread/impact model** and to check sub-hour microstructure, but not to backtest a strategy. Paid pricing was not verified. |
| **CoinGlass** ([pricing](https://www.coinglass.com/pricing)) | API $29/mo (Hobbyist) to $699/mo. Hobbyist/Startup are **personal use only**; commercial use needs Standard ($299/mo)+. History is short at fine intervals (1m capped at 6–12 days on low tiers, hourly 180–720 days, daily all-time). | Cross-exchange aggregated OI/liquidations at daily granularity over all history is cheap. Not usable for sub-hour backtests on cheap tiers. |
| **Kaiko** ([site](https://www.kaiko.com/)) | L1/L2 CeFi/DeFi data, derivatives risk indicators (volume, OI, funding, Greeks), IOSCO reference rates. Pricing on request; a free "Research" account is mentioned without detail. | Institutional, cross-venue. Only worth it if multi-venue lead-lag becomes the main thesis. |
| **Amberdata** ([site](https://www.amberdata.io/)) | L2 market data, liquidity analytics, on-chain, options analytics (free sign-up for the analytics UI). OI/funding/liquidations are not explicitly listed on the home page. | Low priority. |

## 3. Free/cheap sub-hour, OI, liquidation and order-book data: Binance Vision

Verified on 2026-10-10 by listing the S3 bucket behind `https://data.binance.vision` and downloading sample files.

| Path | Content (verified sample) | Coverage seen |
|---|---|---|
| `data/futures/um/daily/metrics/{SYM}/` | **5-minute** rows: `sum_open_interest`, `sum_open_interest_value`, `count_toptrader_long_short_ratio`, `sum_toptrader_long_short_ratio`, `count_long_short_ratio`, `sum_taker_long_short_vol_ratio` | BTCUSDT 2020-09-01 to 2026-10-09 |
| `data/futures/um/daily/bookDepth/{SYM}/` | Periodic snapshots of cumulative depth and notional at ±1..±5 % from mid (`timestamp,percentage,depth,notional`) | BTCUSDT 2023-01-01 to 2026-10-09 |
| `data/futures/um/{daily,monthly}/bookTicker/` | Best bid/ask tick stream | BTCUSDT **ends 2024-03-30** (the latest file found) |
| `.../aggTrades/`, `.../trades/` (spot, um, cm) | Tick trades with aggressor side | long history |
| `.../klines/` | 1s, 1m … 1mo intervals | long history |
| `um/.../premiumIndexKlines`, `markPriceKlines`, `indexPriceKlines`; `um/monthly/fundingRate` | Basis/premium at 1m granularity | long history |
| `data/futures/cm/daily/liquidationSnapshot/` | Liquidation snapshots, **COIN-M only** (no UM folder exists) | per contract |
| `data/option/daily/BVOLIndex`, `EOHSummary` | Binance options vol index / summaries | — |

**Licensing (critical).** The `binance-public-data` repo **code** is MIT, but the **datasets** are governed by
[TERMS_AND_CONDITIONS.md](https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md)
("Binance Vision Dataset Terms", v1.0, last updated **2026-08-26**): **CC BY-NC-SA 4.0**.
- §4.1 permits "algorithmic historical backtesting for purely personal non-production research".
- §4.2 prohibits "live proprietary trading execution, automated commercial order generation, or signal
  distribution to third parties for direct or indirect compensation".
- §4.4 bars integrating the data into "paid subscription newsletters, or commercial trading bot platforms".
- §1.4: amendments apply prospectively, and data already downloaded keeps the terms in force at download.

Implication: this repo's history (`download.py` pulls from data.binance.vision) is fine for personal
research. The README §13 idea of **charging for signals** would need one of two things:
- a Binance enterprise licence, **or**
- a data pipeline whose provenance avoids these files: exchange REST APIs under the exchange ToS, or a
  commercial vendor such as CoinGlass Standard+, Tardis or Kaiko.

Record the download date of every raw file (sha256 is already kept) so you can show which terms version applied.

Other licensing: Tardis free first-of-month files are intended as samples, and their commercial terms were not
verified. CoinGlass Hobbyist/Startup tiers are personal use only.

## 4. Prioritized improvements (max 15; robustness/research quality, not features)

Effort: S <= 1 day, M = 2–5 days, L = 1–3 weeks.

1. **Ingest Binance UM `metrics` (5-min OI, long/short ratios, taker buy/sell ratio) into the PIT store** — M.
   This turns the OI stub models from `DataUnavailable` into testable hypotheses, using 6 years of free data at
   the right granularity. Availability time = `create_time` + a publication lag. Measure the lag; do not assume 0.
   Pre-register the OI hypotheses *before* ingesting, and keep H2 rows behind the guard.
2. **Ingest 1m klines + premiumIndex/markPrice 1m for the universe** — M. This allows sub-hour lead-lag
   (README rule 6 says it "cannot be tested") and intrabar path checks for stops and forced exits. It is cheap
   and from the same source.
3. **Calibrate the cost model empirically from `bookDepth` (±1–5 % depth, 2023+) and Tardis free first-of-month
   `book_snapshot_25` + `trades`** — M. Fit half-spread and the impact coefficient per asset and regime. Then
   pre-register the fitted parameters before the next batch, since rule 2 forbids changing costs after seeing
   results. Short-horizon WATCH candidates (4h reversal, BTC→ADA) are exactly the edges that live or die on cost
   error.
4. **Make the causal (expanding) spread estimate the default for new experiments** while keeping baseline_v0
   frozen — S. The current static `spreads.json` uses full-sample information, which is a mild look-ahead in costs.
5. **Fix PBO degeneracy** — S. Deduplicate near-identical variants by return correlation before CSCV, and report
   PBO on clusters. PBO = 1.00 on near-clones is uninformative and currently produces false REJECTs.
6. **Add CPCV (combinatorial purged CV) with a path distribution of Sharpe** — M. One walk-forward path is one
   draw. CPCV gives a distribution and feeds PBO naturally. vectorbt PRO and the de Prado literature treat it as
   standard.
7. **Minimum Track Record Length + haircut Sharpe to size the paper-trading period** — S. This replaces the ad hoc
   "3–6 months" with a computed horizon per strategy, given its claimed Sharpe and skew/kurtosis. It also tells
   you honestly when paper evidence is still meaningless.
8. **Effective-trial-count accounting for DSR** — S. Count trials as clusters of correlated variants per
   hypothesis family, including refit cadence and cost variants. Store the count in the registry so DSR cannot be
   under-deflated after the fact.
9. **Standard-panel baseline (Alpha158-style features + LightGBM, rolling retrain) as a mandatory comparator** —
   M. A new model must beat a generic ML baseline under the same splits, not just zero. This is Qlib's main lesson.
10. **Triple-barrier / meta-labelling + sample-uniqueness weights for overlapping-horizon labels** — M. Current
    labels are fixed-horizon returns. Overlapping labels inflate effective sample size and t-stats.
11. **Vectorise/accelerate model evaluation, and fix the `ridge` 100-min kill and the `st_reversal` crash** — M.
    Slow evaluation pressures you to test fewer variants *informally*, and informal trials are untracked trials.
12. **Empirical look-ahead diff harness (Freqtrade-style)** — S. For each registered model, compare predictions on
    the full data vs. data truncated at random t, across all assets. Run it as an automatic gate.
13. **Liquidation features from COIN-M `liquidationSnapshot` + Tardis free days, flagged as incomplete
    (1/s snapshot)** — M. Pre-register only coarse event studies (large-liquidation hours), not fine models, since
    the source undercounts by construction.
14. **Data provenance/licence field per raw file (source, URL, terms version, download date)** — S. It is
    required to show which uses are allowed under CC BY-NC-SA, and it doubles as a PIT vintage record.
15. **Live-vs-model cost reconciliation in paper (bid/ask at decision time from public REST bookTicker)** — S.
    This closes the loop on item 3 with out-of-sample evidence, as README §13 item 5 already asks.

Not recommended (feature-packing for this goal): live exchange adapters, Hummingbot-style market making, a
web UI or alerting beyond the local app, and LLM trading modes.
