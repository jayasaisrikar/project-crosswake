# ARCHITECTURE — current state and target adaptive research engine

Companion to `AUDIT_REPORT.md` (findings) and `reports/baseline_v0/BASELINE_V0.md` (frozen numbers).
The older `docs/archive/ARCHITECTURE.md` describes the current engine in more detail; this file adds the
target architecture being built in parallel.

## 1. Current architecture (as of baseline v0)

```
 data.binance.vision ──download.py──> data/raw/*.zip (sha256)
                                         │ clean.py (dedupe, hour grid, ffill+is_filled, frozen bars,
                                         │           ticker-reuse cut)
                                         v
                                 data/cleaned/{bars,funding}/*.parquet, spreads.json, listings.json
                                         │ load.py
                                         v
                             Dataset(spot: MarketData, perp: MarketData, funding)   [contracts.py]
                                         │
         ┌───────────────────────────────┼─────────────────────────────────┐
         v                               v                                 v
 signals/ (trend, carry,        leadlag/ (events, study,          universe.py pit_universe_mask
 breakout, xsmom, regime,       predictive, scorecard,            (implemented, NOT wired)
 leadlag) -> TargetWeights      backtest_leadlag)
         │
         v
 backtest/engine.run_backtest (next-open fills, costs.CostModel, funding, stale skip, forced exit)
         │ BacktestResult
         v
 backtest/portfolio.combine (fixed 50/50, no rebalance)
         │
         v
 pipeline.run_pipeline: HoldoutLock -> periods -> validation/{metrics,stats,walkforward,reconcile}
         │                                -> ExperimentRegistry (registry.jsonl)
         v
 reporting/ html + csv + reports/stats.json

 Live (hourly cron):  live/feed (public REST) -> live/paper (ledger) -> live/risk -> signals_live
                      -> telegram (opt-in)   ; track/ versions, scorecard gate, dashboard, health
```

Key properties: one `Strategy.target_weights(Dataset)` interface for backtest and live
(`src/engine/contracts.py:71-76`); decisions at bar close, fills at next open; strategies output
weights, not forecasts.

## 2. Target architecture

### 2.1 Shared contract
`engine.research.contract` (exists): `H1_START = 2024-07-01` (consumed, ordinary OOS only),
`H2_START = 2025-10-01` (sealed), `Prediction` (timestamp, asset, model_id, horizon, expected_return,
direction incl. 0 = NO TRADE, calibrated confidence, uncertainty, risk, expected_cost,
expected_net_edge, sources, features, regime, reason) and `SignalModel` protocol (`fit(data, end)`,
causal `predict(data, t)`). Every new package codes against it.

### 2.2 New packages (built in parallel by other agents)

| Package | Responsibility | Consumes | Produces |
|---|---|---|---|
| `engine.research` | `contract`; `holdout_guard` (refuses any read >= H2_START unless `open_h2(reason)`, logs to `experiments/holdout_log.jsonl`); hypothesis registry (pre-registration, every hypothesis = a DSR trial); purged/embargoed CV with refit; promotion rules | registry, holdout log | guarded datasets, CV splits, trial counts, promotion decisions |
| `engine.pit` | Point-in-time store: as-of reads, data vintages, PIT universe (wraps `engine.universe.pit_universe_mask`) | `data/cleaned`, `config/universe_pit.yaml` | `Dataset` restricted to what was knowable at t, universe mask |
| `engine.features` | Feature store: named, versioned, causal features computed once and cached (returns, vol, momentum, funding APR, basis, ADV, cross-sectional ranks) | PIT store | feature panels keyed by (feature, version) |
| `engine.events` | External news / event ingestion with PIT `available_at` timestamps (listings, delistings, unlocks, macro calendar) | external sources (local files) | event table, event features |
| `engine.models` | Signal families implementing `SignalModel`: trend/TSMOM, carry/funding, breakout, cross-sectional momentum, mean-reversion, regression forecasts | features, events | `Prediction` per (asset, t, horizon) |
| `engine.leadlag` (extended) | Lead-lag engine: dynamic leaders, rolling lag/beta, Granger with FDR, event-driven forecasts as `Prediction` | features | `Prediction`, research tables |
| `engine.regimes` | Regime classification (vol, trend, funding, correlation regimes), causal | features | regime label per t |
| `engine.ensemble` | Combine predictions; expected edge = E[r] - expected cost; confidence calibration (isotonic/Platt on purged OOS); risk (vol, covariance, caps, gross/net); NO-TRADE when net edge <= threshold | predictions, regimes, `CostModel` | target weights (`TargetWeights`) + decision log |
| `engine.monitor` | Prediction ledger (append-only), realised-outcome scoring at expiry, model health, drift (feature and performance), leaderboard by net edge and calibration | predictions, live/paper fills | ledger, health/drift reports, leaderboard |

Existing modules stay: `data`, `costs`, `backtest`, `validation`, `live`, `track`, `reporting`,
`audit`. `engine.ensemble` emits `TargetWeights` so `run_backtest` and the paper loop are reused
unchanged.

### 2.3 Target pipeline diagram

```
 raw archive / REST / external events
          │
          v
 ┌───────────────┐   ┌──────────────────┐
 │ engine.data   │   │ engine.events    │  available_at timestamps
 └──────┬────────┘   └────────┬─────────┘
        v                     v
 ┌──────────────────────────────────────┐
 │ engine.pit  (as-of store, PIT universe)│◄── engine.research.holdout_guard
 └──────────────────┬───────────────────┘     (blocks t >= H2_START unless open_h2)
                    v
 ┌──────────────────────────────────────┐
 │ engine.features (cached, causal)     │
 └───────┬───────────────┬──────────────┘
         v               v
 ┌───────────────┐ ┌──────────────┐ ┌──────────────────┐
 │ engine.models │ │engine.leadlag│ │ engine.regimes   │
 └───────┬───────┘ └──────┬───────┘ └────────┬─────────┘
         └──── Prediction ┴──────────────────┘
                    v
 ┌──────────────────────────────────────────────────────┐
 │ engine.ensemble: calibrate -> expected net edge       │
 │   (CostModel) -> NO TRADE filter -> risk sizing       │
 └──────────────────┬───────────────────────────────────┘
                    │ TargetWeights
        ┌───────────┴─────────────┐
        v                         v
 backtest.run_backtest      live paper step (feed -> paper -> risk)
        │                         │
        v                         v
 engine.research               engine.monitor
 (purged CV with refit,        (prediction ledger, outcome scoring,
  hypothesis registry,          health, drift, leaderboard)
  DSR/PBO with full trial       │
  count, promotion)  ◄──────────┘
        │
        v
 promotion: frozen candidate -> single H2 evaluation (open_h2) -> track.versions freeze -> live paper
```

### 2.4 Rules the target architecture enforces
1. All research and selection use data < `H2_START`; H1 is ordinary walk-forward OOS.
2. Every model is causal: `predict(data.truncate(t), t) == predict(data, t)` (same test pattern as
   `tests/test_no_lookahead.py`).
3. Every evaluated hypothesis is registered before results are seen and counts as a trial.
4. Every decision is a `Prediction` with expected cost; NO TRADE is an explicit, logged outcome.
5. Execution and cost semantics are those of `engine.backtest` / `engine.costs` (next-open fills,
   taker fees, measured spreads, sqrt impact, funding).
6. `reports/baseline_v0/` is immutable; new results are compared against it.
