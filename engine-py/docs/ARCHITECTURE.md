# Architecture

A Python research-and-paper-trading engine for systematic crypto strategies on
hourly Binance data. It downloads and cleans public market data, runs causal
signals through an event-driven backtester with explicit costs, validates the
results with multiple-testing-aware statistics, renders a self-contained HTML
report, and can drive a persistent paper-trading ledger from live public feeds —
all of it sharing one strategy interface so the exact code that is backtested is
the code that trades.

## 1. High-level overview

The whole system is built around a small set of shared dataclasses in
`src/engine/contracts.py`. Every layer either produces or consumes those
contracts, which keeps the data layout, the causality guarantee, and the
`Strategy` interface identical across research, backtest and live.

Pipelines:

- **Research pipeline** (`engine.pipeline.run_pipeline`): load cleaned data ->
  build strategies from config -> one causal backtest over all data -> slice
  into labelled periods -> validation statistics -> HTML + CSV + `stats.json`.
- **Standalone lead-lag runner** (`engine.leadlag.backtest_leadlag`): prices the
  lead-lag strategy and baselines through the same backtester/cost model.
- **Live paper loop** (`engine.cli.live_step`): one hourly step — fetch latest
  bars, fill pending orders, accrue funding, mark, check risk, re-decide using
  the same strategies, and log.

### Module-dependency diagram

```
                              +------------------------+
                              |  engine/contracts.py   |   shared dataclasses
                              |  MarketData, Dataset,  |   + CAUSALITY RULE
                              |  TargetWeights,        |
                              |  Strategy, CostBreak-  |
                              |  down, BacktestResult  |
                              +-----------+------------+
                                          ^ (imported by ~everything)
                                          |
     data/ ----------------------+        |        +--------------- validation/
  download.py  listings.py       |        |        |   metrics.py  stats.py
  spreads.py  clean.py  load.py  |        |        |   walkforward.py  reconcile.py
        |  raw zips -> parquet   |        |        |
        v                        |        |        |
   Dataset (wide panels) --------+        |        +--- signals/ ----------------+
        |                                 |        |  registry.py  trend.py       |
        |                                 |        |  carry.py  breakout.py       |
        |            +--------------------+--------+  xsmom.py  regime.py         |
        |            |                                 leadlag.py                 |
        v            v                                      ^                      |
   +----------------------------+                           | (leadlag imports    |
   |  backtest/engine.py        |<--- costs.py (CostModel)  |  leadlag/events.py) |
   |  run_backtest()            |                           |                      |
   |  backtest/portfolio.py     |     leadlag/ -------------+----------------------+
   |  combine(), buy&hold       |   events.py  study.py  backtest_leadlag.py
   +-------------+--------------+
                 | BacktestResult
                 v
   pipeline.py ----> reporting/ (html_report.py, csv_export.py)   audit/core.py
        ^                                                          (independent
        |                                                           reconciliation)
   cli.py (download|clean|backtest|live)
        |
        +--> live/ feed.py -> signals_live.py -> paper.py -> risk.py -> telegram.py
```

## 2. Core data contracts and the causality rule

All contracts live in `src/engine/contracts.py`. Timestamps are UTC, tz-aware,
and name the **bar OPEN time** (1h bars).

- `MarketData` (frozen): one market (`spot` or `perp`). Seven wide DataFrames —
  `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `is_filled` —
  indexed by a UTC `DatetimeIndex` with symbol columns. Missing/unlisted bars are
  `NaN`. `.truncate(end)` slices every panel to `[:end]`.
- `Dataset` (frozen): `spot`, `perp`, and `funding` (wide, index = funding event
  ts, columns = symbols, rate per event). `.truncate(end)`, `.market(m)`.
- `TargetWeights`: `spot` and `perp` weight frames (fraction of sleeve equity;
  positive = long, negative = short). Rows exist only at rebalance/decision
  times; the backtester holds positions between rows. `NaN -> 0`.
- `Strategy` (Protocol): a `name: str` plus
  `target_weights(self, data: Dataset) -> TargetWeights`. Must be **pure and
  causal**; the same method is used by backtest, paper and live (live takes the
  last row).
- `CostBreakdown`: `fees`, `spread`, `impact`, `funding` (funding positive =
  paid, negative = received) with a `.total` property.
- `BacktestResult`: `name`, `equity` (hourly), `returns` (hourly simple),
  `positions` (market -> hourly notional USDT frame), `trades`, `costs` (hourly
  fees/spread/impact/funding), and a `meta` dict (params, hashes, cost
  multiplier, exposure, turnover, etc.).

**The causality rule** (stated at the top of `contracts.py`, tested in
`tests/test_no_lookahead.py`): any signal function `f(panels) -> weights` must
satisfy

```
f(data.truncate(t)).loc[t] == f(data).loc[t]     for every t
```

i.e. the decision at `t` must not change when future bars are added. The
backtester reinforces this by executing weights decided at bar `t` at the OPEN of
bar `t+1` — never same-bar fills.

## 3. Data layer

`src/engine/data/` turns Binance public archives into the cleaned parquet layout.

- **`download.py`**: pulls monthly (daily fallback for the trailing month) zips
  from `data.binance.vision` into `data/raw/{spot|perp|funding}/{SYM}/`, each
  verified against its `.CHECKSUM` (sha256) with a `.sha256` sidecar for caching.
  Writes `data/raw/manifest.json`. A 404 is recorded as "missing", not an error.
- **`listings.py`**: point-in-time symbol discovery via the S3 ListObjects API
  behind `data.binance.vision`. Lists every USDT-M perp ever listed (delisted
  folders survive), filters stablecoins/leveraged/dated contracts, then selects a
  candidate universe as the union of the top-K by trailing-30d quote volume at
  each month end — a survivorship-bias control. Drives `config/universe_pit.yaml`.
- **`spreads.py`**: measured half-spreads (bps) to `data/cleaned/spreads.json`.
  Perp from the `bookTicker` archive (1 s time-weighted snapshots, available
  2023-05-16..2024-03-30); spot and uncovered perps from the Abdi-Ranaldo (2017)
  close-high-low estimator on 1h klines (conservative, upward-biased; floored at
  2 bps). Records `median`, `p75`, `p95` and `source` per entry.
- **`clean.py`**: parses raw zips into the cleaned contract. Dedupes/sorts,
  validates OHLC, truncates at ticker-reuse discontinuities (>90% open-vs-prev-
  close jump), reindexes to a full hourly grid, and forward-fills gaps.
- **`load.py`**: reads the parquet files into `Dataset` wide panels.

### Cleaned parquet layout

```
data/raw/<source zips, never modified>  +  data/raw/manifest.json
data/cleaned/bars/{spot|perp}/{SYMBOL}.parquet
    columns: ts, open, high, low, close, volume, quote_volume, trades, is_filled
data/cleaned/funding/{SYMBOL}.parquet
    columns: ts (settlement time, may carry ms jitter), rate (per EVENT)
data/cleaned/spreads.json      data/cleaned/listings.json      data/cleaned/audit.json
```

### `is_filled` semantics

`is_filled=True` marks a bar whose price is **not a real executable quote**. Two
cases are collapsed together in `clean.py`:

1. **Synthesized gaps** — hours missing from the archive are added to the hourly
   grid; `close` is forward-filled, `open/high/low` set to that close, volumes 0.
2. **Frozen bars** — bars present in the archive but with zero volume and
   `o=h=l=c=previous close` (e.g. halted contracts after the FTX/FTT collapse,
   Nov 2022). These are not tradable prices, so they are treated as stale too.

Downstream, `is_filled` is honoured everywhere it matters: the backtester skips
fills on stale bars; `trend`/`breakout` exclude filled bars from volatility so it
is not biased low; `costs.rolling_adv_and_vol` masks filled-bar volume out of ADV.

## 4. Strategy interface and the registry

Every signal in `src/engine/signals/` implements the `Strategy` protocol: a
`name` and a causal `target_weights(data) -> TargetWeights`. Shared primitives
live in `trend.py` (`decision_times`, `tradable_mask`, `stale_run_length`) and
`breakout.py` (`portfolio_vol_target`, `apply_caps`, `pack`, `realized_vol`),
reused across sleeves to keep sizing consistent (inverse-vol risk parity scaled
to an ex-ante portfolio vol target, then per-asset and gross caps).

Registered strategies (`signals/registry.py`, the `_REGISTRY` map):

| key            | class                 | idea |
|----------------|-----------------------|------|
| `trend`        | `TrendStrategy`       | TSMOM ensemble over multiple lookbacks, vol-targeted |
| `carry`        | `CarryStrategy`       | delta-neutral funding carry (long spot / short perp) with cost-aware entry |
| `breakout`     | `BreakoutStrategy`    | Donchian channel breakout ensemble (turtle-style) |
| `xsmom`        | `XSMomStrategy`       | weekly cross-sectional momentum, long/short terciles |
| `trend_regime` | `TrendRegimeStrategy` | trend scaled by Moreira-Muir vol management (clip [0, 1.5]) |
| `leadlag`      | `LeadLagStrategy`     | BTC impulse -> altcoin continuation (now a registered strategy) |

`build_strategies(exp_cfg)` iterates `exp_cfg["strategies"]`, and for each entry
whose `params` dict has `enabled: true` and whose name is in `_REGISTRY`,
constructs `_REGISTRY[name](params)`. The strategy stores its own hyper-params
from that dict, so config is the single source of which sleeves run and how.

`LeadLagStrategy` (`signals/leadlag.py`) reuses the causal impulse detector from
`leadlag/events.py` (`detect_impulses`, `log_returns`) and `tradable_mask`: at
each BTC impulse bar it targets an equal-weight, capped basket of eligible
followers in `sign(r_btc)` direction, held for `hold_hours`. The forward-return
labels in `events.py` are never used as signals.

## 5. Backtest engine timing model

`src/engine/backtest/engine.py` `run_backtest(...)` is the integrity core. It
flattens `(market, symbol)` into one column space, aligns weights to the bar grid
(decision timestamps are mapped to the last bar at or before them), and marches
bar by bar. Per bar `i`:

1. **Funding** charged on perp positions **held into** bar `i`'s open, marked at
   the last perp close before `i` (`cls_ff[i-1]`). A position opened by the fill
   at the settlement bar's open is **not** charged — fills are modelled as
   occurring just after the funding snapshot. Binance ms jitter (e.g.
   `08:00:00.001`) is rounded to the settlement hour.
2. **Execution** of the decision from bar `i-1` at the **OPEN of bar `i`**
   (`i > i0 and has_dec[i-1]`). Target notionals = `weights * equity`; trades
   smaller than `min_trade_frac * equity` are skipped. **No fills on stale bars**
   (`is_filled=True`): the trade is skipped, counted in `meta["n_skipped_stale"]`,
   and retried at the next decision. Costs come from the `CostModel` evaluated at
   the decision bar's ADV/vol.
3. **Forced exits** on delisting (holding a position while `close` is `NaN`),
   priced at the last real close and charged at `FORCED_EXIT_COST_MULT = 2.0x`
   the normal cost.
4. **Mark to market** at the forward-filled close. If equity falls to `<= 0` the
   run is flagged `ruined`, positions zeroed, and the loop breaks.

Spot weights are validated to be non-negative (spot cannot be short). Outputs are
assembled into a `BacktestResult` with rich `meta` (turnover, exposure,
`n_skipped_stale`, `n_forced_exits`, `ruined`, `cost_multiplier`, ...).

`backtest/portfolio.py` provides `combine(results, allocation, capital)` — sum of
linearly-rescaled sleeve equities/positions/costs (no inter-sleeve rebalancing) —
and `benchmark_buy_hold(...)` which runs a trivial one-shot buy-and-hold strategy
through the same `run_backtest`.

## 6. Cost model

`src/engine/costs.py` `CostModel` computes, per trade of absolute notional `N`:

```
fees   = fee_bps[market] * 1e-4 * N                       (taker: we cross the spread)
spread = half_spread(symbol, market) * 1e-4 * N
impact = impact_y * sigma_daily * sqrt(min(N/ADV_daily, max_participation)) * N
each component * stress multiplier
```

The square-root impact law follows Almgren et al. (2005) and Toth et al. (2011)
(`impact_y` of order 1). ADV (daily quote volume) and `sigma_daily` come from
`rolling_adv_and_vol(md, days)` — a trailing 30-day, filled-bar-masked, `shift(1)`
(causal) estimate. Unknown liquidity falls back to worst-case participation (the
cap). Half-spread resolution order: config override -> measured `spreads.json`
(default stat `p75`) -> config fallback -> `default`. The research pipeline re-runs
every result at 1.0x / 1.5x / 2.0x via `_cost_model(exp, mult)`.

## 7. Validation layer

`src/engine/validation/`:

- **`metrics.py`**: `performance_summary` (total/CAGR/vol/Sharpe/Sortino/Calmar,
  drawdown span, worst/best month, `% positive months`, round-trip trade stats),
  plus `daily_returns`, `drawdown_series`, `monthly_returns`, `yearly_returns`.
- **`stats.py`**: multiple-testing-aware robustness — Newey-West HAC t-stat of
  mean daily return, stationary block bootstrap CI (Politis-White block length),
  Probabilistic and Deflated Sharpe (Bailey & Lopez de Prado; DSR deflates by
  `E[max SR]` over the trial count), PBO via CSCV, and Hansen SPA vs a benchmark.
- **`walkforward.py`**: `walk_forward_splits` (rolling train/test month blocks
  with embargo purging); `HoldoutLock` which raises `HoldoutViolation` if data
  touches `holdout_start` while locked and permanently appends every `unlock` to
  `experiments/holdout_log.jsonl`; and `ExperimentRegistry`, an append-only JSONL
  log of every run (params hash, git sha, metrics) used for the honest DSR trial
  count.
- **`reconcile.py`**: an independent recomputation of a `BacktestResult` — every
  per-trade fee/spread/impact, ledger-vs-cost-table totals, the per-bar
  accounting identity (`d(equity) = gross market P&L - costs - funding`), and (if
  `data` is given) gross P&L rebuilt from prices. Returns a pass/fail table.

The pipeline wires these together: it runs one causal backtest over all available
data, truncating at `dev_end` unless `--unlock-holdout` is passed; slices results
into **DEVELOPMENT / HOLDOUT ONLY / FULL PERIOD** with equity rebased to initial
capital at each period start; evaluates a pre-declared trend trial grid and the
allocation mixes; and computes per-period statistics (DSR/PBO on the dev trial
grid as the selection-relevant figures).

## 8. Live / paper-trading loop (shares the strategy code)

`src/engine/live/` runs **paper trading only** — no API keys, no order endpoints,
read-only public GETs. One step is `engine.cli.live_step`:

1. **`feed.py`** `build_live_dataset(...)` fetches recent closed hourly bars
   (spot + perp klines) and funding from Binance public REST, merges them with
   on-disk cleaned history, drops the in-progress bar, and returns a `Dataset`
   shaped exactly like `data.load` output — so strategies cannot tell live from
   backtest.
2. **`signals_live.py`** `latest_signal(exp_cfg, data)` calls
   `build_strategies(exp_cfg)` — **the identical registry and strategy classes as
   the backtest** — and takes the **last decision row** of each sleeve's
   `target_weights`, allocation-weighted into a combined target. This is the
   mechanism by which paper and backtest share one implementation; the only
   difference is live reads the last row instead of replaying history.
3. **`paper.py`** `PaperLedger` is a persistent ledger under `data/paper/`
   (`state.json`, append-only `fills.jsonl`, `equity.jsonl`, `signals.jsonl`). It
   fills pending targets at the OPEN of the first bar strictly after the decision
   bar (same next-bar rule as the backtester), accrues funding on perp positions,
   and marks equity.
4. **`risk.py`** `check_risk` applies a latched drawdown kill switch, daily-loss
   halt, stale-data/exchange-error halts and a gross-leverage cap; `reconcile`
   checks ledger positions against the replayed fill log.
5. **`telegram.py`** formats the signal update (with a paper-trading disclaimer)
   and sends it only if `--send` and both `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
   env vars are set; otherwise it prints.

## 9. Reporting

`src/engine/reporting/`:

- **`html_report.py`** `build_report(ctx, out_path)` renders a single,
  self-contained HTML file (Plotly embedded inline once, no external resources).
  When `ctx["periods"]` is present it produces the period-labelled report
  (`build_period_report`) with DEVELOPMENT / HOLDOUT ONLY / FULL PERIOD sections,
  a holdout-access log, equity/drawdown/monthly/yearly charts, cost breakdowns,
  stress tests, walk-forward folds, and statistical-robustness tables with
  plain-English interpretations.
- **`csv_export.py`** `export_period_tables(ctx, out_dir)` writes one folder per
  labelled period (summary, costs, allocations, stress, stats, per-result
  monthly/yearly/trades CSVs) plus top-level `walk_forward.csv` and
  `holdout_log.csv`.

## 10. Config files and CLI entry points

Configs in `config/`:

- **`experiment.yaml`**: `initial_capital`, the `costs` block (fees, spread
  resolution, `impact_y`, stress multiplier), the chronological `split`
  (`dev_end` / `holdout_start`), `walk_forward` parameters, every strategy's
  hyper-params with an `enabled` flag, and the sleeve `allocation`.
- **`universe.yaml`**: the hand-picked symbol list (includes LUNA/FTT to limit
  survivorship bias), quote, interval and download window — the default universe.
- **`universe_pit.yaml`**: the machine-generated point-in-time candidate set from
  `listings.py`, consumed with `engine.universe.pit_universe_mask` (top-N by
  trailing ADV at each rebalance boundary, causal).
- **`leadlag.yaml`**: the pre-registered lead-lag event study config (leader,
  followers, impulse `k_values`, horizons, `dev_end`).
- **`live.yaml`**: paper-trading config — initial capital, ledger dir, feed
  history/retries, and the `risk` limits consumed by `RiskLimits.from_config`.

CLI (`src/engine/cli.py`, `engine` console script):

- `engine download` — fetch raw history from `data.binance.vision`.
- `engine clean` — clean raw data into `data/cleaned`.
- `engine backtest [--unlock-holdout --reason "..."]` — run the research pipeline
  and build the HTML report; unlocking the holdout is logged.
- `engine live step [--send]` — one hourly paper step (optionally Telegram).
- `engine live status` — print the paper ledger status.

Additional module runners: `python -m engine.leadlag.study [config]` (event
study + cross-correlation CSVs), `python -m engine.leadlag.backtest_leadlag
[--full]` (net-of-cost lead-lag vs baselines through the shared backtester),
`python -m engine.data.listings` (PIT universe), and
`python -m engine.data.spreads [--no-download]` (measured spreads).

## Appendix: independent audit

`src/engine/audit/core.py` provides pure (no-I/O) cross-checks over the engine
contracts: P&L attribution by long/short leg and by year, an independent
per-event funding ledger, funding-interval detection, data-sanity scans (stale
runs, frozen bars, implausible bars, per-trade fill-bar flags) and a per-bar
equity-identity residual. These are deliberately recomputed from first principles
so they can confirm the backtester's own accounting.
