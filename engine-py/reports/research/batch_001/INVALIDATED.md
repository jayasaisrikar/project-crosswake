# batch_001 — INVALIDATED (2026-10-10)

batch_001 (EXP-000001 … EXP-000012) stays recorded exactly as it was run: `plan.yaml`, `results.md`,
`leadlag_43_pairs.csv` and the registry rows were not edited. Its decisions are not evidence of any
edge (or lack of one), for these reasons from `reports/review/01_research.md`:

1. **It measured buy-and-hold, not signals (review 01 #1, BLOCKER).** Every ScoreModel set
   `direction = sign(a + b*s)`. The intercept `a` (the training-window drift) was larger than `b*s`, so the
   models were long 85–98% of the time. Donchian's OOS Sharpe (0.95) equals equal-weight buy-and-hold
   BTC/ETH over the same span (0.95). The `xs_*` models were not cross-sectional either, because every asset
   got the same sign. The WATCH on `tsmom` (0.78) and `zscore_reversal` (0.52) mostly reflects market beta.
2. **The PBO = 1.00 rejections were artefacts (review 01 #2, BLOCKER; #3).** Since positions did not
   depend on parameters (#1), the neighbour return series were identical. `pbo_cscv` broke ties toward
   column 0 and counted `logit <= 0` as overfit, which gives PBO = 1.0 on identical columns. At N = 3–5 a
   no-skill strategy also got PBO ≈ 0.6 under that rule.

Other defects that affected batch_001 (review 01): the DSR had almost no deflation (n_trials 1–2, #4).
`st_reversal` crashed because it ran a cross-sectional model on 2 assets (#5). `ridge` was killed for
runtime (#6). Funding was left out of perp PnL (#7). There was no benchmark gate (#8). The
cross-sectional universe used hindsight (#9). The leakage checks could not fail (#10). Lead-lag assumed
zero latency (#11).

## What this means

- Do not cite batch_001 as evidence for or against any hypothesis.
- **Its 12 trials still count.** The registry is append-only. batch_002 deflates its DSR against every
  registry record, batch_001 and its crashes included, plus every parameter neighbour.
- The fixes are in code, and the rule-level bug fixes are in `config/promotion_rules_v2.yaml`
  (pre-registered 2026-10-10, after this invalidation). `config/promotion_rules.yaml` (v1) is frozen,
  and `engine.research.promotion.decide_v1` still reproduces the batch_001 decisions.
- The re-test is `reports/research/batch_002/`. It has a new pre-registered plan, new EXP ids and v2 rules.
