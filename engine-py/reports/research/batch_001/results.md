# Research batch 001 — results

Plan: `reports/research/batch_001/plan.yaml` (created 2026-10-10T07:33:27.422920+00:00, spec_sha 5fb1e8d5d72a3e37). Data 2020-01-01 .. < H2_START 2025-10-01 (H2 sealed, not opened). Rules: config/promotion_rules.yaml (pre-registered, unchanged). Runtime 0.6 min.

No parameter was changed after results were seen; no reruns.

## Experiments

| EXP | hypothesis | model | universe | OOS net Sharpe | 2x-cost Sharpe | DSR | PBO | stability (frac nbrs > 0) | HAC p | BH q (batch) | regime-specific | decision | reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EXP-000001 | H-0001 | tsmom | majors | 0.78 | 0.77 | 0.956 | 0.17 | 1.00 | 0.0939 | 0.3347 | no | WATCH | failed: hac_p; failed: oos_sharpe |
| EXP-000002 | H-0001 | donchian | majors | 0.95 | 0.95 | 0.975 | 1.00 | 1.00 | 0.0348 | 0.2088 | no | REJECT | PBO 1.00 > 0.5 |
| EXP-000003 | H-0002 | xs_mom | pit_top_n | 0.57 | 0.56 | 0.905 | 1.00 | 1.00 | 0.1797 | 0.3347 | no | REJECT | PBO 1.00 > 0.5 |
| EXP-000004 | H-0002 | residual_mom | pit_top_n | 0.55 | 0.54 | 0.894 | 1.00 | 1.00 | 0.1953 | 0.3347 | no | REJECT | PBO 1.00 > 0.5 |
| EXP-000005 | H-0004 | vol_managed_tsmom | pit_top_n | 0.57 | 0.52 | 0.908 | 1.00 | 1.00 | 0.1781 | 0.3347 | no | REJECT | PBO 1.00 > 0.5 |
| EXP-000006 | H-0008 | funding_reversion | pit_top_n | 0.59 | 0.58 | 0.911 | 0.71 | 1.00 | 0.1674 | 0.3347 | no | REJECT | PBO 0.71 > 0.5 |
| EXP-000007 | H-0010 | basis_reversion | pit_top_n | 0.18 | 0.05 | 0.518 | 0.33 | 1.00 | 0.6765 | 0.8118 | yes | INCONCLUSIVE | failed: cost_stress; failed: dsr; failed: hac_p; failed: oos_sharpe; failed: pbo; regime-specific: positive in 33% of regimes |
| EXP-000008 | H-0011 | st_reversal | majors | - | - | - | - | - | - | 1.0000 | no | INCONCLUSIVE | crash: InsufficientData: st_reversal: 0 training pairs < 50 |
| EXP-000009 | H-0011 | zscore_reversal | majors | 0.52 | 0.38 | 0.875 | 0.39 | 1.00 | 0.2786 | 0.4179 | no | WATCH | failed: dsr; failed: hac_p; failed: oos_sharpe; failed: pbo |
| EXP-000010 | H-0013 | voladj_reversal | pit_top_n | 0.31 | 0.09 | 0.707 | 0.34 | 1.00 | 0.4059 | 0.5412 | yes | INCONCLUSIVE | failed: cost_stress; failed: dsr; failed: hac_p; failed: oos_sharpe; failed: pbo; regime-specific: positive in 33% of regimes |
| EXP-000011 | H-0020 | ridge | pit_top_n | - | - | - | - | - | - | 1.0000 | no | INCONCLUSIVE | crash: timeout: H-0020/ridge killed after ~100 min of computation (not hung, CPU-bound; >6x slowest other run); stopped per coordinator instruction, not rerun |
| EXP-000012 | H-0014 | leadlag_engine:BTC->ADA | BTC->ADA | 1.42 | 0.60 | 0.548 | 0.03 | 0.50 | 0.0063 | 0.0751 | no | WATCH | failed: dsr; failed: perturbation |

## Decision counts

- REJECT: 5
- INCONCLUSIVE: 4
- WATCH: 3

## Multiple testing across the batch (12 trials)

Benjamini-Hochberg at q <= 0.05 over each trial's daily HAC p-value (NaN -> 1): 0 rejection(s). Holm (FWER) rejections: 0.

## Lead-lag BTC->ADA candidate under multiple testing

The lead-lag engine labelled BTC->ADA 'EDGE EXISTS' using only per-test BH on the statistics layer; its tradability t-stat (OOS net HAC t) was not corrected for picking the best of 43 pairs.

- Pairs re-run with unchanged engine code: 43
- BTC->ADA hourly net HAC p = 0.0029, BH q (43 pairs) = 0.0886, Holm p = 0.1248, BH reject = no
- Pairs BH-significant on tradability (q <= 0.05): 0 (none)
- DSR vs 43 pair trials = 0.548; PBO over lag variants = 0.03; 2x-cost Sharpe = 0.60
- Pre-registered decision: **WATCH** — failed: dsr; failed: perturbation
- Full table: `reports/research/batch_001/leadlag_43_pairs.csv`

## Unmapped testable hypotheses (not run, not registered)

- H-0003: no conditional panic-state scaling model in engine.models
- H-0005: volatility-forecast QLIKE comparison, not a trading signal (runner measures PnL)
- H-0006: same model (vol_managed_tsmom, HAR sizing) as H-0004; not run twice (duplicate trial)
- H-0007: delta-neutral carry needs spot+perp legs + funding PnL; runner is single-leg, no funding
- H-0009: cross-sectional funding carry needs funding PnL; runner PnL excludes funding
- H-0012: conditional abnormal-move model not implemented
- H-0014: no lead-lag SignalModel in registry; assessed via the lead-lag engine BTC->ADA trial
- H-0015: regime-conditional lead-lag model not implemented
- H-0016: perp->spot lead-lag model not implemented (lead-lag engine verdict: no edge)
- H-0017: transfer-entropy model not implemented
- H-0018: HMM-conditioned trend model not implemented
- H-0019: BOCPD exposure overlay not implemented
- H-0021: intraday time-of-day model not implemented
- H-0022: long-horizon reversal model not implemented; history too short for 1y lookbacks
- H-0023: meta-hypothesis: answered by this batch's DSR/PBO/BH outputs, not a separate model

## Verdicts

- H-0001 / tsmom (EXP-000001): **WATCH**
- H-0001 / donchian (EXP-000002): **REJECT**
- H-0002 / xs_mom (EXP-000003): **REJECT**
- H-0002 / residual_mom (EXP-000004): **REJECT**
- H-0004 / vol_managed_tsmom (EXP-000005): **REJECT**
- H-0008 / funding_reversion (EXP-000006): **REJECT**
- H-0010 / basis_reversion (EXP-000007): **INCONCLUSIVE**
- H-0011 / st_reversal (EXP-000008): **INCONCLUSIVE**
- H-0011 / zscore_reversal (EXP-000009): **WATCH**
- H-0013 / voladj_reversal (EXP-000010): **INCONCLUSIVE**
- H-0020 / ridge (EXP-000011): **INCONCLUSIVE**
- H-0014 / leadlag_engine:BTC->ADA (EXP-000012): **WATCH**

PROMOTE/WATCH: EXP-000001 (WATCH), EXP-000009 (WATCH), EXP-000012 (WATCH)

## Caveats (declared in plan)

- perp PnL excludes funding payments
- square-root impact not applied (runner)
- position_mode=sign for every model (model-side scaling not used)
- xs models rank across all dataset columns, PIT mask applied to predictions

## Run log

```
finish phase 2026-10-10T10:37:47.480682+00:00: timeout: H-0020/ridge killed after ~100 min of computation (not hung, CPU-bound; >6x slowest other run); stopped per coordinator instruction, not rerun
EXP-000001 H-0001/tsmom: WATCH
EXP-000002 H-0001/donchian: REJECT
EXP-000003 H-0002/xs_mom: REJECT
EXP-000004 H-0002/residual_mom: REJECT
EXP-000005 H-0004/vol_managed_tsmom: REJECT
EXP-000006 H-0008/funding_reversion: REJECT
EXP-000007 H-0010/basis_reversion: INCONCLUSIVE
EXP-000008 H-0011/st_reversal: INCONCLUSIVE
EXP-000009 H-0011/zscore_reversal: WATCH
EXP-000010 H-0013/voladj_reversal: INCONCLUSIVE
EXP-000011 H-0020/ridge: INCONCLUSIVE
EXP-000012 H-0014/leadlag BTC->ADA: WATCH
```

## Addendum: run history (written by hand after the finish phase)

- The `run` phase started 13:05 local time and registered EXP-000001..EXP-000010, about 3h of compute in total; per-experiment runtimes were 105 s to 1471 s. The "Runtime 0.6 min" in the header covers only the `finish` phase.
- EXP-000008 (st_reversal) crashed inside the original run (InsufficientData, 0 training pairs in the first fold). It was registered as INCONCLUSIVE and not rerun.
- H-0020/ridge was still CPU-bound after ~100 min with no result, so it was killed on coordinator instruction. `finish` registered it as a crash (EXP-000011), then ran the lead-lag trial (EXP-000012) and wrote this file and the leaderboard. No experiment was rerun and no parameter was changed.
- Caution on the statistics: PBO = 1.00 together with perturbation 1.00 (EXP-000002..000005) means the parameter neighbours are near-identical and the base config is never the in-sample best in CSCV. That PBO is degenerate rather than proof of overfitting. These REJECTs follow the pre-registered rule as written and were not overridden.
