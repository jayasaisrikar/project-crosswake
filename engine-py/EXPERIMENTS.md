# Experiments (Phase 3 research lab)

All Phase-3 research runs through `engine.research.runner.run_experiment` and is logged to
`experiments/exp_registry.jsonl` (append-only). The legacy strategy registry
(`experiments/registry.jsonl`) is untouched.

## Workflow
1. Write the hypothesis in `research/hypotheses_seed.yaml` (id, research_ids, statement, features,
   target, conditions, data_required, family, testable_now; optional `params`).
   Load with `engine.research.hypothesis.load_hypotheses()` (returns `[]` if the file is absent).
2. Implement a `SignalModel` (`engine/research/contract.py`) and a factory `params -> model`.
3. Build a `ResearchDataset(data, returns, name, market, feature_versions)` using ONLY data
   `< H2_START` (2025-10-01 UTC). Anything later raises `H2Violation`.
4. `run_experiment(hypothesis, model_factory, dataset, cost_model, params=None, config=RunConfig(...),
   regime_labeler=None)` -> `ExperimentResult(exp_id, decision, results, net_returns, predictions)`.
5. The decision (REJECT / INCONCLUSIVE / WATCH / PROMOTE) comes from `promotion.decide()` using the
   pre-registered `config/promotion_rules_v2.yaml` (2026-10-10, after batch_001 was invalidated; bug
   fixes from review 01). `decide_v1()` reproduces the frozen v1 rules (`config/promotion_rules.yaml`)
   that batch_001 was decided under. There is no override.

## What each registry record contains
`id` (EXP-000001.., immutable, monotonic), `registered_at`, `git_commit`, `git_dirty`, `versions`
(python + numpy/pandas/scipy/statsmodels/arch/pyyaml), `hypothesis_id`, `family`,
`family_trial_number`, `model_version`, `params`, `seed`, `dataset_hash`, `feature_versions`,
`periods` (data span, OOS span, every fold's train_end/test_start/test_end, H2 start),
`cost_model`, `results`, `stats`, `decision`, `rejection_reason`, `reasons`, `notes`.

## Rules
* Never edit or delete a line. Corrections are new records. `ResearchRegistry.verify()` fails on gaps.
* Every run counts as a trial, including failures. Since rules v2, DSR deflates against N = every
  registry record (all families and batches, batch_001 and crashes included) + every parameter
  neighbour evaluated + 1. V[SR] comes from the finite Sharpe values on record (review 01 #4).
* `register=False` is for unit tests only.
* H2 may only be opened with `holdout_guard.open_h2(reason)`; the count is `h2_open_count()`.
  H1 (2024-07-01) is consumed: it is ordinary walk-forward OOS for new hypotheses, never a holdout.

## Execution / cost model inside the runner
Decision at bar close t, filled at the open of t+1 when `ResearchDataset.open_returns` is given (the old
position earns the close->open gap, the new one earns open->close). Held until the next decision (every
`horizon_hours`). Perp funding is charged when `ResearchDataset.funding` is given: a long pays positive
funding (review 01 #7). Positions: `sign` (direction), `vol_target` (direction x target_vol_h / risk,
capped), or `edge` (trade only if |expected_return| - expected_cost > threshold). Equal weight across
the assets predicted at t. Benchmark: buy-and-hold (`benchmark_weights`, or equal weight over valid
assets) with funding. Results carry `benchmark_sharpe`, `excess_sharpe_vs_benchmark`, `alpha_ann`,
`beta_vs_benchmark`, `alpha_t` and a one-sided `alpha_p`.
Cost per unit turnover = (taker fee + half-spread) from `engine.costs.CostModel`. Square-root
impact is not applied (research is notional-free); the 2x cost-stress gate is the buffer.

## Batches
* batch_001 (EXP-000001..000012): **invalidated**. See `reports/research/batch_001/INVALIDATED.md`. It
  measured buy-and-hold beta, and its PBO was degenerate. The records are kept and still count as trials.
* batch_002: `uv run python -m engine.research.batch plan|run|finish` writes `reports/research/batch_002/`
  (pre-registered `plan.yaml`, then `results.md`, `leadlag_pairs_delayed.csv`) under rules v2. Plan-time
  validation: an xs model needs a universe of >= 3 assets, and every experiment needs >= 5 distinct
  variants (base + one-at-a-time neighbours).
