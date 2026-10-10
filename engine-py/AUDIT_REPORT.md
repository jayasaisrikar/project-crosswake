# AUDIT REPORT — Phase 0 (documentation only)

Audit date: 2026-10-10. Baseline commit `8afa308` + uncommitted working tree (see
`reports/baseline_v0/git_status.txt`). No code was modified for this audit. Every claim cites
`file:line` from the code as read on this date. Line numbers refer to the current working tree.

Notation: `src/engine/` is abbreviated as `e/`.

---

## 1. Repository

### 1.1 Structure

| Path | Role |
|---|---|
| `e/contracts.py` | Shared dataclasses: `MarketData`, `Dataset`, `TargetWeights`, `Strategy` protocol, `CostBreakdown`, `BacktestResult`; causality rule (`e/contracts.py:14-16`) |
| `e/research/contract.py` | NEW shared research contract: `H1_START=2024-07-01`, `H2_START=2025-10-01` (`:18-19`), `Prediction` dataclass (`:24-53`), `SignalModel` protocol (`:56-65`) |
| `e/data/` | `download.py` (Binance archive), `clean.py` (zip -> parquet), `load.py` (parquet -> panels), `spreads.py` (spread estimation), `listings.py` (perp discovery / PIT candidate set), `integrity.py` (dataset checks), `cli_data.py` |
| `e/universe.py` | `pit_universe_mask` (PIT top-N by ADV) |
| `e/signals/` | `trend.py`, `carry.py`, `breakout.py`, `xsmom.py`, `regime.py`, `leadlag.py`, `registry.py` |
| `e/costs.py` | `CostModel` (fees + half-spread + sqrt impact), `rolling_adv_and_vol` |
| `e/backtest/` | `engine.py` (`run_backtest`), `portfolio.py` (`combine`, buy&hold benchmark) |
| `e/validation/` | `metrics.py`, `stats.py` (HAC, bootstrap, PSR/DSR, PBO, SPA), `walkforward.py` (splits, `HoldoutLock`, `ExperimentRegistry`), `reconcile.py` |
| `e/pipeline.py` | End-to-end research pipeline (`run_pipeline`, `e/pipeline.py:449`) |
| `e/leadlag/` | `events.py` (impulse event study), `study.py`, `predictive.py` (Granger/rolling lag/OOS R2), `research_predictive.py`, `scorecard.py` (pre-registered gate), `backtest_leadlag.py` |
| `e/live/` | `feed.py` (public REST), `paper.py` (paper ledger), `risk.py`, `signals_live.py`, `telegram.py` |
| `e/track/` | Frozen versions (`versions.py`), live scorecard/gate (`scorecard.py`), `dashboard.py`, `health.py`, `market.py`, `venue.py`, `manual.py`, `commands.py` |
| `e/audit/` | `core.py`, `run.py` — forensic audit (LUNA/FTT/forced exits/funding/reconcile/leakage) |
| `e/reporting/` | `html_report.py` (plotly HTML), `csv_export.py` |
| `tests/` | 23 test files, 184 tests (baseline `reports/baseline_v0/pytest.txt`) |
| `config/` | `experiment.yaml`, `universe.yaml`, `universe_pit.yaml`, `live.yaml`, `leadlag.yaml`, `versions/v001.yaml`, `versions/v002.yaml` |
| `deploy/` | `oracle_setup.sh` (cron), `run_step.ps1` (Windows Task Scheduler) |
| `experiments/` | `registry.jsonl` (88 rows), `holdout_log.jsonl` (5 rows), `dsr_sensitivity.py/json` |
| `reports/` | `stats.json`, `report.html`, `tables/`, `audit/`, `leadlag/`, `dashboard.html`, `baseline_v0/` |
| `docs/` | 15 prior docs + `docs/research/01-05` |

### 1.2 Dependencies (`pyproject.toml`)
Python `>=3.12,<3.13`; pandas>=2.2, numpy>=1.26, pyarrow>=16, scipy>=1.13, statsmodels>=0.14,
arch>=7.0 (bootstrap + SPA), pyyaml, requests, plotly, jinja2. Dev: pytest, ruff (line 110,
E/F/I/B/UP/SIM), mypy (`check_untyped_defs`), pandas-stubs. No ML library (sklearn, lightgbm) and no
database dependency.

### 1.3 Entry points
- `engine = engine.cli:main` (`pyproject.toml`; `e/cli.py:153`). Subcommands: `download`, `clean`,
  `backtest [--unlock-holdout --reason --acknowledge-reuse]`, `live step|status|record-fill`,
  `version list|freeze|set-status`, `scorecard`, `dashboard`, `health`, `market update`, `venue check`
  (`e/cli.py:1-13`, `:156-202`).
- Module mains: `python -m engine.leadlag.study`, `engine.leadlag.research_predictive`,
  `engine.leadlag.backtest_leadlag [--full]`, `engine.data.spreads`, `engine.data.listings`,
  `engine.data.integrity`, `engine.audit`.

### 1.4 Configuration
- `config/experiment.yaml`: capital 100k; costs (fees 10/5 bps spot/perp taker, spreads from
  `data/cleaned/spreads.json` p75, impact_y 0.7) (`:3-17`); split `dev_end 2024-06-30`,
  `holdout_start 2024-07-01` (`:20-22`); walk-forward 24m train / 3m test / 168-bar embargo
  (`:24-27`); strategy blocks (`:29-94`); allocation trend 0.5 / carry 0.5 (`:95-97`).
- `config/universe.yaml`: 16 hand-picked symbols incl. LUNA, FTT (used by pipeline and live).
- `config/universe_pit.yaml`: 283 candidate perps + PIT rules (top_n 20, 60d history, 30d ADV,
  monthly) — not consumed by any strategy (see §8).
- `config/live.yaml`: paper capital, feed, risk limits (max DD 20%, daily loss 5%, stale 2h).
- `config/versions/v001.yaml`, `v002.yaml`: frozen live-paper versions, both `status: live`.

### 1.5 Data stores
- `data/raw/{spot,perp,funding}/{SYM}/*.zip` + `manifest.json` (sha256-verified, `e/data/download.py:433-468`).
- `data/cleaned/bars/{spot,perp}/{SYM}.parquet` (283 perp files present), `data/cleaned/funding/`,
  `audit.json`, `spreads.json`, `listings.json`.
- `data/paper/` and `data/paper/v00N/`: `state.json`, `fills.jsonl`, `equity.jsonl`, `signals.jsonl`
  (`e/live/paper.py:1-12`).
- `experiments/registry.jsonl`, `experiments/holdout_log.jsonl` — append-only JSONL.
- No database; everything is parquet/JSON/JSONL on local disk.

### 1.6 External APIs (all read-only, public)
- `https://data.binance.vision` archive (`e/data/download.py:331`).
- Binance REST `api.binance.com/api/v3/klines`, `fapi.binance.com/fapi/v1/klines`,
  `/fapi/v1/fundingRate` (`e/live/feed.py:27-31`).
- Hyperliquid daily candles for venue cross-check (`e/track/venue.py:35`).
- Telegram Bot API, only with `--send` and env vars (`e/live/telegram.py:674-688`).
- No order endpoints, no API keys.

### 1.7 Scheduled jobs / deployment
- Linux: cron `2 * * * * uv run engine live step` (`deploy/oracle_setup.sh:21-22`).
- Windows: `deploy/run_step.ps1` (hourly via Task Scheduler, hard-coded uv path line 6).
- `engine live step` iterates every `status: live` version (`e/cli.py:105-120`).

---

## 2. Current architecture

| Stage | Implementation |
|---|---|
| Ingestion | Monthly Binance archive zips, checksum-verified, daily fallback only for the last month (`e/data/download.py:485-528`). Live: REST klines/funding merged over disk history (`e/live/feed.py:173-234`). |
| Cleaning | Dedupe, hour-align, drop invalid OHLC, cut at >90% open/prev-close discontinuity (ticker reuse), reindex to full hourly grid, forward-fill gaps and mark `is_filled`; frozen bars (vol 0, o=h=l=c=prev close) also marked filled (`e/data/clean.py:102-162`). Funding: dedupe only (`:165-168`). |
| Loading | Wide panels per field, union index, NaN outside listing, `is_filled` NaN -> True (`e/data/load.py:26-50`). |
| Features | No feature layer. Each strategy computes its own rolling stats inline (e.g. `e/signals/trend.py:67-76`). Shared helpers: `tradable_mask`, `decision_times` (`e/signals/trend.py:32-44`), `realized_vol`, `portfolio_vol_target`, `apply_caps` (`e/signals/breakout.py:22-58`). |
| Strategies | `Strategy.target_weights(Dataset) -> TargetWeights`, built from config by registry (`e/signals/registry.py:15-31`). |
| Backtest | Single-pass hourly event loop, next-bar-open fills, funding at settlement, stale-bar skip, forced exits on delisting, ruin stop (`e/backtest/engine.py:58-274`). Sleeves combined without rebalancing (`e/backtest/portfolio.py:13-56`). |
| Validation | Period slicing with rebase (`e/pipeline.py:123-154`), HAC t, stationary bootstrap CI, PSR, DSR, PBO (CSCV), Hansen SPA (`e/validation/stats.py`), fixed-param walk-forward table (`e/pipeline.py:355-370`), cost stress 1/1.5/2x (`:479-480`), reconciliation (`e/validation/reconcile.py`). |
| Holdout control | `HoldoutLock` + log, one-use `reserve()` per params hash (`e/validation/walkforward.py:78-154`). |
| Live / paper | Hourly step: feed -> fill pending at next open -> funding -> mark -> risk -> reconcile -> latest signal -> pending (`e/cli.py:27-102`). |
| Tracking | Frozen versions with hash check, per-version paper ledgers, live gate (90 days, 30 trades, PF 1.2, CI>0, DD<=25%) (`e/track/versions.py:20-26`, `e/track/scorecard.py:154-181`). |
| Reporting | Plotly HTML report, CSV tables, `stats.json` (`e/pipeline.py:554-569`); HTML dashboard (`e/track/dashboard.py:186`). |
| Notifications | Telegram text message, opt-in (`e/live/telegram.py:674`). |

---

## 3. Current strategies (exact, from code)

Shared: decision times = bars whose UTC hour is a multiple of `rebalance_hours` (or every N days at
00:00) (`e/signals/trend.py:37-44`); tradable = valid close and stale run <= 24 bars
(`e/signals/trend.py:17,32-34`). Execution at next bar open (`e/backtest/engine.py:167-194`).

### 3.1 Trend (TSMOM ensemble) — `e/signals/trend.py:47-104` — ENABLED, alloc 0.5
- score_i,t = mean over L in {20,60,120} days of sign(close_t / close_{t-24L} - 1) (`:67-70`).
- vol_i,t = std of hourly returns over 30d (min half window), excluding filled bars, x sqrt(8760) (`:73-76`).
- raw = score / vol where eligible (tradable, 120d history, vol>0) (`:78-79`).
- Portfolio vol target: row scaled so std of trailing 30d portfolio returns (current weights applied
  to past returns) x sqrt(8760) = 0.20 (`:80-96`).
- Caps: |w| <= 0.25 per asset, gross <= 2.0 (`:99-102`). Perp market, daily rebalance, shorts allowed.

### 3.2 Carry (delta-neutral funding) — `e/signals/carry.py:22-106` — ENABLED, alloc 0.5
- APR_t = sum(funding events in (t-72h, t]) x 8760/72; NaN if no event before t-72h (`:49-59`).
- Eligible: spot and perp tradable, |spot/perp-1| <= 2% (`:71-80`).
- Hold while APR >= 2%; enter if APR > 10% AND APR x 14/365 > 2 x round-trip cost, round trip =
  2 x (10+5+2+2) bps = 38 bps (`:42-47`, `:61-65`).
- Max 5 positions, fixed weight w = min(0.20, 1.0/2/5) = 0.10 per leg; long spot / short perp
  (`:47`, `:106`); no-trade band 0.25w (`:102`); daily decisions.

### 3.3 Breakout (Donchian ensemble) — `e/signals/breakout.py:83-116` — OFF
- For L in {20,55,100} days: long when close >= rolling L-day max of closes (incl. t), short when
  close <= min, exit long below midline, exit short above midline; forward state machine (`:66-80`).
- score = mean position; raw = score/vol; portfolio vol target 20%, caps 0.25 / 2.0 (`:110-116`).

### 3.4 XSMOM (cross-sectional momentum) — `e/signals/xsmom.py:21-54` — OFF
- mom = close_{t-24} / close_{t-24*31} - 1 (30d formation, 1d skip) (`:39`).
- Weekly: long top tercile, short bottom tercile, equal weight 1/n each leg (`:44-51`); portfolio
  vol target 20%, caps (`:53-54`).

### 3.5 Trend regime (vol-managed trend) — `e/signals/regime.py:20-40` — OFF
- Trend weights x clip(0.20^2 / realized_var(trend book hourly returns, 30d), 0, 1.5); NaN -> 1.0
  (`:34-39`). Caps re-applied.

### 3.6 Lead-lag overlay — `e/signals/leadlag.py:32-120` — OFF
- r = hourly log return, masked on filled bars (`e/leadlag/events.py:18-24`).
- Impulse at t: |r_BTC,t| > k x std(r_BTC over previous 720 bars) (`e/leadlag/events.py:27-36`), k=2.
- Basket: every eligible non-BTC follower, weight sign(r_BTC) x gross/n_elig capped 0.25, held
  `hold_hours` bars via ffill (`e/signals/leadlag.py:58-72`). `reversion` flips sign.
- `BtcImpulseFollow` baseline trades BTC only (`:81-115`).
- Research status: dev scorecard REJECTs all 7 variants; gross Sharpe of headline cell -0.74, i.e. no
  signal even before costs (`reports/leadlag/scorecard.csv`); Granger OOS R2 incremental negative for
  followers (`reports/leadlag/predictive_oos.csv`).

---

## 4. Strengths
1. Strict execution timing: decisions at t filled at open t+1, never same bar (`e/backtest/engine.py:167-194`; `e/contracts.py:14-16`).
2. Causality tested by truncation and future-perturbation invariance for trend, carry (`tests/test_no_lookahead.py:57,87`), breakout/xsmom/regime (`tests/test_new_signals.py:22`), lead-lag (`tests/test_leadlag_signal.py:41,54`) and the PIT universe (`tests/test_universe.py:35,43`).
3. Realistic cost model: taker fees, measured per-symbol spreads, sqrt-impact with causal (shifted) ADV/vol (`e/costs.py:119-156`), 2x cost on forced exits (`e/backtest/engine.py:23,202`), cost stress (`e/pipeline.py:479-480`).
4. Funding handled per event with ms-jitter snapping and settlement-time semantics (`e/backtest/engine.py:121-132,159-166`); interval-agnostic APR (`e/signals/carry.py:49-59`).
5. Stale/frozen-bar handling end-to-end: filled bars excluded from vol (`e/signals/trend.py:73-74`), no fills on stale bars (`e/backtest/engine.py:181-183`), frozen-contract detection (`e/data/clean.py:134-140`, `e/live/feed.py:89-93`).
6. Independent accounting reconciliation (`e/validation/reconcile.py:39-147`) and forensic audit module (`e/audit/run.py`).
7. Holdout lock with permanent append-only log and one-use rule (`e/validation/walkforward.py:78-154`); experiment registry (`:183-226`).
8. Multiple-testing-aware stats already implemented: DSR, PBO-CSCV, SPA, HAC, BH-FDR (`e/validation/stats.py`, `e/leadlag/predictive.py:30-44`).
9. Frozen-version discipline with content hash; live paper gate pre-declared (`e/track/versions.py:1-37`).
10. Pre-registered rejection gate for lead-lag with honest null verdict (`e/leadlag/scorecard.py:32-39`).
11. Clean gates at baseline: 184 tests pass, ruff and mypy clean (`reports/baseline_v0/`).

## 5. Weaknesses
1. No prediction layer: strategies emit weights only; no expected return, confidence, uncertainty or cost-aware edge per decision. The new `Prediction` contract (`e/research/contract.py:24-53`) has no producer yet.
2. No feature store / PIT store: every strategy recomputes rolling stats on full panels (`e/signals/trend.py:67-76`, `e/signals/breakout.py:103-110`).
3. Walk-forward never refits: parameters fixed for all folds (`e/pipeline.py:355-370`, note at `:550`), so it measures stability, not out-of-sample model selection.
4. Universe is a 16-coin hand list chosen in 2026 (`config/universe.yaml`); the implemented PIT universe is unused (see §8).
5. Static 50/50 sleeve allocation with no rebalancing (`e/backtest/portfolio.py:13-56`, `e/pipeline.py:415`); no regime conditioning, no ensemble weighting.
6. DSR/PBO computed on a 9-config trend grid only (`e/pipeline.py:421-429,305-310`), ignoring the 88-row registry and all non-trend trials.
7. Trend turnover is very high: 74x (dev) / 86x (H1) avg equity per year; trend fees+spread+impact = 23.7k of 113k gross in dev (`reports/baseline_v0/stats.json` dev.costs.Trend). No no-trade band in trend (`e/signals/trend.py:96-104`) unlike carry (`e/signals/carry.py:102`).
8. Carry edge has decayed: H1 total return 0.7% over 2.25 years, 14.8% positive months (stats.json holdout.summary.Carry).
9. No monitoring of model health/drift; live gate only on aggregate paper P&L (`e/track/scorecard.py:154-181`).
10. Two cost-model construction paths: pipeline and lead-lag runner omit `base_dir` (see bug B3).

## 6. Potential bugs (file:line)

| # | Location | Issue | Severity |
|---|---|---|---|
| B1 | `e/validation/metrics.py:72-74` | Round-trip P&L sign: any side not in {buy,long,b,1} is treated as a sell. Engine forced exits have side `"forced_exit"` (`e/backtest/engine.py:210`) with signed notional `-qty*p` (`:200`); a forced exit of a SHORT is a buy but is booked as a sell, corrupting hit rate / profit factor / expectancy for any sleeve with short forced exits. Fix: use sign of `qty_notional`. | Medium |
| B2 | `e/pipeline.py:413` + `e/backtest/engine.py:215-221` | Sleeves enabled but missing from `allocation` get capital `cap*0 = 0`; equity 0 triggers `ruined` on the first bar. Enabling breakout/xsmom without an allocation silently produces a dead sleeve. Live path does the opposite: default allocation `1/len(strategies)` (`e/live/signals_live.py:42`) — backtest/live mismatch. | Medium |
| B3 | `e/pipeline.py:402`, `e/leadlag/backtest_leadlag.py:71` | `CostModel.from_config(cfg)` without `base_dir`; `spreads_file: data/cleaned/spreads.json` is resolved against the CWD (`e/costs.py:87-92`). Run from any other directory, measured spreads are silently replaced by fallbacks (only a log warning, `e/costs.py:58-60`). Live/audit pass `base_dir=ROOT` (`e/cli.py:57`, `e/audit/run.py:73`). | Medium |
| B4 | `e/backtest/engine.py:168` | Execution requires `i > i0`: a decision on bar `i0-1` (just before `start`) is never executed, so each run started with `start=` begins flat until the next decision (up to 7 days for xsmom). Pipeline runs from data start so impact is small; any per-fold run would be biased. | Low |
| B5 | `e/live/paper.py:103-151` vs `e/backtest/engine.py:181-183` | Paper fills do not skip stale (`is_filled`) bars; backtest does. Paper and backtest diverge on frozen/halted symbols. | Medium |
| B6 | `e/validation/walkforward.py:104-112` | `reserve()` dedupes by `params_hash`, but all 5 entries in `experiments/holdout_log.jsonl` predate the field (no `params_hash`), so the one-use rule cannot detect re-evaluation of the existing rules. | Medium |
| B7 | `e/pipeline.py:465` | With `--unlock-holdout`, `end=None` loads all data, i.e. up to the latest bar including H2 (>= 2025-10-01). The pipeline knows nothing of `H2_START` (`e/research/contract.py:19`). Any future unlock opens H2. | High |
| B8 | `e/leadlag/study.py:51-53` | The lead-lag event study always computes a `holdout` segment (`ts > dev_end`) and per-year segments for every year in the data, including 2025-2026 — reads H1 and H2 without the lock or the log. | High |
| B9 | `e/leadlag/backtest_leadlag.py:67` | `--full` runs through the end of data (H1 and H2) with no `HoldoutLock` call and no holdout-log entry, contradicting its docstring claim of being "logged" (`:5-7`). | Medium |
| B10 | `e/pipeline.py:545-547` | Report notes state "Spreads are configured estimates, not measured" while costs use measured `spreads.json` (`config/experiment.yaml:12`). Stale disclosure. | Low |
| B11 | `e/data/clean.py:84-99` | `truncate_at_discontinuity` drops everything after the first >90% open-vs-prev-close jump. A genuine >10x gap (or a bad print) truncates the whole remaining history of the symbol. | Low |
| B12 | `e/signals/regime.py:38` | `scale.fillna(1.0)` gives full scale when realized variance is undefined (warm-up), i.e. unscaled trend exposure exactly when the regime estimate is unknown. | Low |
| B13 | `e/live/paper.py:153-181` | Funding accrual applies every event after `last_funding_ts` to the CURRENT qty; positions filled in the same step before accrual (`e/cli.py:58-60`) are charged for events that preceded the fill if the step lagged. Backtest explicitly avoids charging positions opened at the settlement bar (`e/backtest/engine.py:4-6`). | Low |
| B14 | `experiments/holdout_log.jsonl` vs `reports/stats.json` | Log has 5 views, `stats.json` reports `holdout_views: 4`; the 5th entry (16:30:00, crosswake comparison) was not produced by `run_pipeline` (manual/other script). | Info |

## 7. Look-ahead risks
1. **H2 is not pristine (most important).** `reports/stats.json` / `reports/baseline_v0/stats.json` "holdout" period is `2024-07-01 -> 2026-09-30` and the walk-forward table reports four H2 folds (2025-10..2026-09 test Sharpe -0.00, 1.37, 2.27, 1.53). Every result viewed under the 5 H1 unlocks covered H2 as well. Also `reports/leadlag/event_study.csv` contains per-year 2025/2026 segments (B8). The contract's claim "H2 SEALED" (`e/research/contract.py:7`) holds only from now on for NEW hypotheses; the existing trend/carry/breakout/xsmom/leadlag rules and the v001/v002 versions have been seen on H2 data. Only live paper data after 2026-10-09 is genuinely unseen for them.
2. Spread estimates use the full sample: Abdi-Ranaldo monthly estimates over all bars (`e/data/spreads.py:131-145`, called on full history in `build_spreads` `:160-212`) and a p75 statistic over that distribution feed every historical trade cost — a cost input that knows the future (conservative in level, but not PIT).
3. PIT universe candidate list was built from 2020-01..2026-09 rankings (`config/universe_pit.yaml` header); acceptable only because the mask re-selects causally (`e/universe.py:68-79`), but the mask is unused.
4. `config/universe.yaml` symbols were chosen in 2026 (pipeline note `e/pipeline.py:547`).
5. Strategy params were set after holdout views: holdout log entry 4 states "Carry v2 + new strategies were developed AFTER holdout views (not OOS)" (`experiments/holdout_log.jsonl` line 4).
6. Breakout channel max includes the current close (`e/signals/breakout.py:105`): intended (signal at close t, fill at open t+1) — not a leak, noted for reviewers.
7. Funding timestamps are rounded to the nearest hour (`e/backtest/engine.py:127`); a settlement at hh:59:59 would be moved forward one hour — Binance jitter is ms-level so practically safe.
8. No look-ahead found inside signal code; causality tests cover all registered strategies (§4.2).

## 8. Survivorship bias
- Pipeline and live use `config/universe.yaml` (16 coins, `e/pipeline.py:451-453`, `e/cli.py:24,44`): today's large caps plus LUNA and FTT. Coins that were top-20 in 2020-2022 and later faded (e.g. many 2021 alts) are absent.
- `pit_universe_mask` (`e/universe.py:39-83`) and the 283-symbol candidate set exist but are referenced by no strategy, pipeline or live code (grep: only `e/data/listings.py:144` docstring and tests).
- v002 adds HYPE, SUI, ENA, TAO, WLD (`config/versions/v002.yaml`) — chosen with hindsight; correctly judged on live paper only.
- Delistings: forced exit priced at last real close x 2 costs (`e/backtest/engine.py:195-210`); no modelling of halt-before-delist losses beyond frozen-bar detection.

## 9. Selection bias (incl. holdout consumption history)
- H1 views (`experiments/holdout_log.jsonl`): 5 on 2026-10-09 — (1) first final eval after vol bugfix, (2) carry basis guard fix, (3) reporting fix, (4) review fixes incl. funding timing, APR, stale bars, measured spreads — explicitly "Carry v2 + new strategies were developed AFTER holdout views", (5) crosswake comparison of breakout, xsmom, rebuilt carry, blend weights. H1 is CONSUMED (`e/research/contract.py:5-6`).
- Because the holdout window ran to the data end, each H1 view also displayed H2 (§7.1).
- Registry: 88 rows (trend 36, leadlag 30, Combined/Trend/Carry/BTC 4 each, leadlag_predictive 3, leadlag_scorecard 2, data_integrity 1). DSR uses only 9 trials (`stats.json n_trials: 9`; `e/pipeline.py:306`), so `dsr_trend = 0.985` (dev) is optimistic. `experiments/dsr_sensitivity.py` exists as a side analysis.
- Dev PBO for the trend grid is 0.94 (`stats.json dev.pbo_trend`): the IS-best grid member ranks below the OOS median in 94% of CSCV splits — the grid offers no reliable in-sample selection.
- SPA vs BTC buy&hold: p = 0.92 dev, 0.53 H1 — cannot reject "no strategy beats BTC" on raw returns.
- Strategy menu itself (trend+carry chosen, breakout/xsmom/regime/leadlag off) is a selection made with full-sample knowledge.

## 10. Data-quality problems
- Gaps forward-filled with `is_filled=True`, volume 0 (`e/data/clean.py:140-146`); handled downstream but filled bars still enter `close` (and `close.shift(L*24)` in trend momentum, `e/signals/trend.py:69`).
- Ticker reuse (LUNA->LUNC) handled by discontinuity cut (`e/data/clean.py:84-99`); funding of the successor dropped (`:207-209`).
- FTT spot/perp mismatch handled by basis guard (`e/signals/carry.py:75-80`); `e/data/integrity.py` checks grid, OHLC, frozen runs, basis, funding (`:103-224`), output `reports/data_integrity.json`.
- Funding parsed with "last column = rate" (`e/data/clean.py:147-155`) — format-dependent.
- No PIT vintage: cleaned data is overwritten in place by `clean_all` (`e/data/clean.py:258-304`); no as-of timestamps, no record of when a bar became known.
- Spot exists only for a subset of the 283 perps (`config/universe_pit.yaml` comment).

## 11. Execution assumptions
- Fill at next 1h bar open, full size, taker (`e/backtest/engine.py:167-194`); no partial fills, no latency beyond one bar, no queue/limit orders.
- Costs: fee 10 bps spot / 5 bps perp, half-spread p75 measured, impact = 0.7 x sigma_daily x sqrt(min(N/ADV,1)) x N (`e/costs.py:3-7,131-139`); unknown ADV -> participation 1.0 (worst case, `:141-145`).
- Min trade 0.1% equity (`e/backtest/engine.py:66,179`).
- Perps marked linearly, no margin/liquidation model, no borrow cost for spot short (spot shorts forbidden, `:73-74`).
- Funding paid on positions held into settlement, marked at prior close (`:159-166`).
- Exchange/counterparty failure not modelled (`e/pipeline.py:548`).
- Live paper: same timing, but stale-bar rule differs (B5).

## 12. Statistical weaknesses
- Sharpe on hourly returns x sqrt(8760) (`e/validation/metrics.py:128`) ignores intraday autocorrelation; HAC/bootstrap are on daily returns (`e/validation/stats.py:29-35`) — mixed conventions in reports.
- DSR trial count too small (9) and only for trend (`e/pipeline.py:305-308`).
- PBO with S=16 on 9 configs (`e/pipeline.py:310`), trend only.
- Walk-forward without refit, without purging by label horizon (none needed now, but required once models are fitted) (`e/validation/walkforward.py:28-68`).
- No calibration metrics (Brier, reliability), no per-prediction evaluation, no IC/rank-IC.
- Event-study clustering averages across alts per event then HAC (`e/leadlag/events.py:93-101`) — good, but horizon-overlap lags set to h (`e/leadlag/study.py:44`).
- H1 inference: Combined HAC t 1.43, bootstrap Sharpe CI [-0.34, 2.26] — not significant on H1.

## 13. Missing capabilities
PIT data/feature store; PIT universe wiring; prediction objects and ledger; model families beyond rules (no ML, no regression forecasts); purged/embargoed CV with refit; hypothesis registry with pre-registration; H2 guard; ensemble / meta-allocation; expected-edge and confidence calibration; risk model (covariance, correlation limits, exposure by factor); regime detection used for decisions; external event/news ingestion; drift / health monitoring of models; leaderboard; per-symbol capacity analysis; maker/limit execution models; margin/liquidation model.

## 14. Performance bottlenecks
- `run_backtest` pure-Python hourly loop with an inner loop over all columns on every decision bar (`e/backtest/engine.py:157-194`); lead-lag weights exist on every bar so decisions fire hourly (`e/signals/leadlag.py:54-73`).
- Per-decision Python loops for portfolio vol targeting (`e/signals/trend.py:83-95`, `e/signals/breakout.py:40-50`).
- Carry loops times x symbols with `.at` lookups and per-step frame slicing in `trailing_apr` (`e/signals/carry.py:84-104,55-58`).
- `stale_run_length` groupby per column (`e/signals/trend.py:21-29`), recomputed by every strategy via `tradable_mask`.
- `pit_universe_mask` boolean-index scan per boundary (`e/universe.py:69`).
- Pipeline re-runs strategies at 3 cost multipliers + 9 trend trials + 5 allocation mixes (`e/pipeline.py:477-498`); `_CachedStrategy` caches weights only (`:385-396`).
- Live recomputes full `target_weights` over 200 days every hour (`e/live/signals_live.py:44`) and `rolling_adv_and_vol` per fill step (`e/live/paper.py:123`).

## 15. Top 10 highest-value improvements
1. Enforce H2 everywhere: a `holdout_guard` used by pipeline, lead-lag scripts and any new research (fixes B7-B9); record that existing rules have seen H2.
2. Wire the PIT universe (`e/universe.py`) into data loading and strategies to remove survivorship bias.
3. Introduce the `Prediction` contract producers + an append-only prediction ledger so every model is scored per-prediction (calibration, IC, net edge).
4. Purged/embargoed walk-forward with REFIT and a hypothesis registry where each hypothesis counts as a trial for DSR.
5. Expected-net-edge gate: trade only when |E[r]| - expected cost > threshold; adds a no-trade band to trend (turnover 74-86x/yr).
6. Ensemble/meta-allocation across sleeves with risk model (vol, correlation) instead of fixed 50/50.
7. Regime layer (vol/trend/funding regimes) feeding model weights; carry needs a funding-regime switch given H1 decay.
8. Fix metrics round-trip sign (B1), zero-capital sleeves (B2), cost-model base_dir (B3), paper stale-bar rule (B5).
9. Feature store with PIT as-of semantics and caching to remove duplicated rolling computations and speed the loop.
10. Monitoring: model health, drift, live-vs-backtest divergence, leaderboard by net edge on live paper.

## 16. Reusable infrastructure
`contracts.py` panels and causality rule; `data/*` ingestion and cleaning; `costs.CostModel` and `rolling_adv_and_vol`; `backtest.engine.run_backtest` and `reconcile`; `validation.stats` (HAC, bootstrap, PSR/DSR, PBO, SPA); `walk_forward_splits`; `HoldoutLock` and `ExperimentRegistry` (extend, do not replace); `leadlag.events`/`predictive` (Granger, BH-FDR, OOS R2); `leadlag.scorecard` gate pattern; `universe.pit_universe_mask`; `live.*` feed/paper/risk; `track.versions` freeze/hash; test patterns for causality (truncation + perturbation).

## 17. What must be added
`engine.research` (holdout_guard, registry, hypotheses, purged CV, promotion), `engine.pit` + `engine.features`, `engine.events`, `engine.models`, extended `engine.leadlag`, `engine.regimes`, `engine.ensemble` (expected edge, calibration, risk), `engine.monitor` (prediction ledger, health, drift, leaderboard). See `ARCHITECTURE.md`.

## 18. Phased plan
- **Phase 0 (this):** audit, baseline frozen in `reports/baseline_v0/`, architecture.
- **Phase 1 — integrity:** holdout_guard (H2), PIT store + PIT universe, fix B1-B5, hypothesis registry, purged CV with refit. Gate: all existing tests + new causality tests; no read of data >= H2_START outside guard.
- **Phase 2 — signals:** model families emitting `Prediction`; lead-lag engine extensions; external events PIT ingestion; regimes. Each model pre-registered, evaluated only on < H2_START data with H1 as ordinary OOS.
- **Phase 3 — decision layer:** expected-edge (cost-aware), confidence calibration, ensemble, risk model, NO-TRADE as a first-class outcome.
- **Phase 4 — monitoring/promotion:** prediction ledger, health/drift, leaderboard, promotion rules; frozen candidate evaluated ONCE on H2 via `open_h2(reason)`, then live paper.
