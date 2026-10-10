# Validation (Phase 3)

## Holdout policy (pre-registered 2026-10-10)
* H1 = 2024-07-01: viewed 5 times -> consumed. Usable only as walk-forward OOS.
* H2 = 2025-10-01 00:00 UTC: sealed. `assert_research_window()` raises on any timestamp >= H2.
  `open_h2(reason)` appends to `experiments/holdout_log.jsonl`; openings are counted.

## Splits (`engine.research.splits`)
* `walk_forward(index, n_splits, label_horizon, embargo, min_train)` - expanding window; a training
  observation is kept only if its label end `t + h < test_start - embargo`.
* `purged_kfold(index, n_splits, label_horizon, embargo)` - Lopez de Prado (AFML ch. 7): training
  observations whose label [t, t+h] overlaps [test_start, test_end + h] are purged; observations in
  (test_end, test_end + h + embargo] are embargoed.
* Both refuse any index reaching H2.

## Leakage tests (runner; checks that can fail since review 01 #10)
* Model only receives data truncated at `end` (fit) / `t` (predict).
* Fold boundary check: train_end + horizon < test_start (sanity only; it holds by construction).
* `full_data`: predict(full research data, t) == predict(data truncated at t, t).
* `perturbation`: predict(data with every value after t scrambled, t) == the truncated prediction.
* `fit`: a model fitted on full-length data that is scrambled after `end` (with `end` passed) predicts
  exactly like one fitted on truncate(data, end). A model that refuses future data by raising passes.
* `pointwise`: the batched OOS predictions (`predict_many`) equal fresh pointwise predictions.
  Any failure => `leakage_pass=False` => REJECT. `tests/test_models_review01.py` shows that a leaky score
  and a leaky fit are both caught.
* Lead-lag (batch_002): a truncation re-run must reproduce every common fold's lag and PnL.

## Statistics (`engine.research.multiple_testing`, reusing `engine.validation.stats`)
Annualised net Sharpe (bar level), daily Sharpe, Newey-West HAC t / p, stationary block bootstrap CI,
Deflated Sharpe vs ALL registered trials + neighbours (N passed explicitly), PBO (CSCV) over the
parameter neighbourhood (identical variants deduplicated, OOS mid-ranks, IS-best ties averaged, overfit iff
logit < 0 strictly, degenerate when < 5 distinct variants), alpha vs buy-and-hold (daily OLS, HAC t),
Hansen SPA (available), Holm and Benjamini-Hochberg for families of p-values.

## Robustness
* Cost stress: net Sharpe at 2x costs.
* Perturbation (`engine.research.perturbation`): one-at-a-time neighbours from `RunConfig.param_grid`;
  share with OOS Sharpe > 0 and dispersion.
* Regimes: optional `regime_labeler(index) -> labels`; Sharpe per regime. Positive in < 60% of
  regimes => flagged regime-specific (non-blocking).

## Promotion v2 (`config/promotion_rules_v2.yaml`, pre-registered 2026-10-10 after the batch_001 invalidation)
Same thresholds as v1. Changes (bug fixes, review 01): a degenerate PBO or a NaN PBO => INCONCLUSIVE
(never REJECT, never WATCH); the PBO > 0.5 hard reject applies only to a valid PBO. PROMOTE also needs
one-sided alpha p <= 0.05 vs buy-and-hold, and WATCH needs alpha > 0. Missing alpha => INCONCLUSIVE.
DSR N counts every trial. See the file's `changelog`.

## Promotion v1 (`config/promotion_rules.yaml`, pre-registered 2026-10-10; frozen, batch_001 only)
1. REJECT: leakage fail; OOS net Sharpe <= 0; 2x-cost Sharpe <= 0; PBO > 0.5.
2. INCONCLUSIVE: < 30 trades or < 180 OOS days.
3. PROMOTE (paper only): Sharpe >= 0.8, DSR >= 0.95, PBO <= 0.2, 2x-cost Sharpe >= 0.3,
   perturbation >= 0.7, HAC p <= 0.05. Missing/NaN metric fails its check.
4. WATCH: Sharpe >= 0.4 and DSR >= 0.5; otherwise INCONCLUSIVE.
5. Live eligibility additionally needs >= 60 paper-trading days with positive paper Sharpe.
`decide(results)` is deterministic and accepts no overrides; it verifies the rules file's date.
