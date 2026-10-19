# Review 01 — research validity & statistics (read-only)

Date: 2026-10-10. Scope: `src/engine/research/**`, `src/engine/validation/**`, `src/engine/models/**`,
`src/engine/leadlag/{engine,methods}.py`, `src/engine/regimes/**`, `src/engine/ensemble/calibration.py`,
`config/promotion_rules.yaml`, `reports/research/batch_001/*`. No source, config or data file was edited.
Only data before H2_START (2025-10-01) was read; `holdout_guard.open_h2` was never called.
`uv run pytest -q` gives 375 passed. Reproduction scripts were run from the session scratchpad.

## Summary

| # | Sev | Finding |
|---|---|---|
| 1 | BLOCKER | In `sign` mode every ScoreModel is mostly a long-only beta bet. `direction = sign(a + b*s)`, and the intercept `a` (the drift in the training window) outweighs `b*s`. Donchian's OOS Sharpe is 0.95, exactly the same as buy-and-hold BTC/ETH (0.95). |
| 2 | BLOCKER | The cause of PBO = 1.00: the neighbour return series are identical (consequence of #1), and `pbo_cscv` breaks ties so the in-sample "best" config always gets OOS rank 1. |
| 3 | HIGH | PBO is biased upward for a small N. With the `logit <= 0` convention, a no-skill PBO is about 0.62 at N=3 (measured), which is above the hard REJECT limit of 0.5. |
| 4 | HIGH | The DSR is effectively just the PSR. n_trials is 1–2 per family. It ignores the parameter neighbours, the 12 batch trials and crashed trials. |
| 5 | HIGH | `st_reversal` crash: the cross-sectional model was run on a 2-asset universe, and `xs_demean_rank` needs at least 3 assets. |
| 6 | HIGH | The `ridge` runtime hotspot is that `predict()` rebuilds every feature (plus a per-column groupby for the stale mask) over a 2232-hour window, on 125 columns, at every decision. The `horizon_hours=4` neighbour makes 6x as many decisions. |
| 7 | HIGH | Perp PnL leaves out funding, even though the strategies are about 85–97% long. Sharpe is overstated. |
| 8 | MEDIUM | `decide()` gaps: no benchmark or beta gate, no tie or degeneracy guard on PBO, a NaN PBO passes the hard gate, and leakage_pass is hard-coded True for lead-lag. |
| 9 | MEDIUM | The cross-sectional universe is the union of every asset that was ever top-15. Picking that set uses hindsight, and it is used for the ranks at time t. |
| 10 | MEDIUM | The leakage checks are tautological: `boundary_ok` is always true by construction, and the causality check cannot detect fit-time leakage. |
| 11 | MEDIUM | Lead-lag assumes the follower fills at the same close that reveals the leader's move, so it has no execution latency. |
| 12 | LOW | Fill at close t rather than open t+1 (README rule 4). Log and simple returns are mixed in the lead-lag daily stats. In `xs` sign mode the book is not market-neutral. |

---

## 1. BLOCKER — "signals" are buy-and-hold beta (sign mode + calibrated intercept)

**Where:** `src/engine/models/base.py:255-257` (OLS with intercept), `:284-287` (`direction = sign(a + b*s)`), and `src/engine/research/runner.py:102-106` (`sign` mode uses `p.direction`). The batch runs every model with `position_mode=sign` (`batch.py:82`).

**Evidence:** I fitted each model at three train ends and measured how often the training-window forecast is long (scratchpad `p1.py`):

| model | a (intercept) | b | frac long |
|---|---|---|---|
| donchian (2023-01 / 2024-06) | 0.0022 / 0.0023 | 0.0021 / 0.0014 | 95% / 97% |
| tsmom | 0.0021 / 0.0021 | 0.0019 / 0.0014 | 88% / 93% |
| zscore_reversal (h=4) | 0.0004 | -0.0002 | 96–98% |
| xs_mom / residual_mom / vol_managed (2021-06) | ~0.009 | 0.003–0.007 | 26–28% (with \|s\| ≤ 0.5 the sign is mostly set by `a`) |

Buy-and-hold equal-weight BTC/ETH perp over the same OOS span (2020-12-16 to 2025-09-30), hourly annualised Sharpe:
**0.95**. Model results: donchian **0.95**, tsmom 0.78, zscore_reversal 0.52. EXP-000002 is effectively the market.
The `xs_*` models are not cross-sectional either. Every asset gets the same sign whenever |a| > |b|·0.5.

**Fix:** In `sign` and `edge` modes, size on the de-meaned forecast: `sign(er - a)` (that is, `sign(b*s)`). Alternatively,
fit the calibration on excess return (fwd − cross-sectional or market mean), with no intercept used for direction.
For cross-sectional models, demean `expected_return` across assets at t before taking the sign, so the book is
dollar-neutral. Add a benchmark (buy-and-hold) Sharpe and the residual alpha t-stat to `results`, and gate on them (see #8).
Re-run batch_001 as a new, dated batch. The registry is append-only, so do not rewrite the old rows.

## 2. BLOCKER — PBO = 1.00 root cause: identical variants plus tie handling

**Where:** `src/engine/validation/stats.py:117-126`.
`best = is_perf.argmax(axis=1)` picks column 0 on ties. Then `rank = (oos_perf < oos_best).sum()+1` gives **1** when all
columns are equal. That makes w = 1/(N+1), so logit < 0 in every combination and PBO = 1.0.

**Evidence:** The registry's neighbour Sharpes are exactly equal: EXP-000004 `[0.5478, 0.5478, 0.5478]` and EXP-000005
`[0.5696, 0.5696, 0.5696]` (EXP-000003 has 2 of 3 equal). With an always-long direction (#1), changing a parameter does
not change the positions. Reproduction: `pbo_cscv` on 3 identical columns returns `pbo = 1.0` (`p2.py`).
`perturbation_frac_positive = 1.00` happens for the same reason.

**Fix (in this order):**
1. Fix #1. This is the real cause.
2. In `pbo_cscv`, deduplicate columns that are identical to tolerance first. If fewer than 2 distinct columns remain, return
   `pbo = NaN` and `degenerate = True`.
3. Use mid-ranks for ties: `rank = (oos < b).sum() + 0.5*((oos == b).sum() - 1) + 1`. In the IS argmax, break ties at random
   or average over the tied set.
4. In the runner, record `n_distinct_variants`. `decide()` should treat a degenerate PBO as missing, which means
   INCONCLUSIVE, not REJECT.

## 3. HIGH — PBO null bias for small N (the `logit <= 0` convention)

**Where:** `stats.py:121-126`. With an odd N, the median rank gives w = 0.5, so logit = 0, and that counts as "overfit".
I simulated i.i.d. no-skill configs (40 reps, S=10): **N=2: 0.46, N=3: 0.62, N=4: 0.52, N=7: 0.60**. The batch neighbourhoods
have N = 3–5. The hard gate `max_pbo: 0.5` therefore rejects a coin-flip strategy more than half the time.
EXP-000006 was rejected at 0.71.

**Fix:** Use `logits < 0` (strict). Also require N ≥ 5 distinct variants before PBO is computed or used as a hard gate.
This is an implementation fix, not a change to the threshold. Note that changing what PBO means does not change the
rules file, but the change still needs to be documented and dated in the decision log.

## 4. HIGH — DSR does not deflate

**Where:** `runner.py:216` (`reg.trial_sharpes(hypothesis.family)`), `registry.py:272-278`, `multiple_testing.py:75`,
`stats.py:65-69`.
- `expected_max_sharpe` returns 0 when n < 2. The first trial in each family therefore gets DSR = PSR(0). In the registry,
  `n_trials` = 1 for EXP-000001, 003, 005, 006 and 009, and 2 for the others.
  EXP-000001 "DSR 0.956" passes the 0.95 PROMOTE bar with no deflation at all.
- The parameter neighbours were evaluated, and they shape the stability and PBO verdict, but they are never counted
  as trials.
- Crashed trials (EXP-000008 and 011) store no `sharpe_daily`, so they drop out of the count. EXP-000009 shows
  `n_trials=1` but `family_trial_number=2`.
- The `family` key is the coarse hypothesis family ("trend", "reversal"). That is fine, but the batch's 12 trials across
  families are never pooled.

**Fix:** Set N = max(registered family trials incl. crashes, …) + number of neighbours evaluated, or use the batch-wide
N (12 + neighbours). When fewer than 2 Sharpe values are observed, use the standard Bailey/LdP formula with
`V[SR]` estimated from the neighbour Sharpes and with the trial count N, rather than returning 0.

## 5. HIGH — `st_reversal` "0 training pairs": root cause

**Where:** `src/engine/models/rules.py:151` → `base.py:171-176` (`xs_demean_rank(..., min_assets=3)` sets every row with
fewer than 3 valid assets to NaN). The batch plan (`batch.py:56-57`) runs `st_reversal`, a **cross-sectional** rank, on
`universe: majors` = BTC and ETH only. Every score is NaN, so there are 0 training pairs.
Reproduced: `build_model("st_reversal", lookback_hours=4, horizon_hours=4).fit(majors…)` raises
`InsufficientData: 0 training pairs < 50`.
This is not a data bug and it is not specific to the first fold.

**Fix:** Map H-0011/st_reversal to `pit_top_n`, or give ScoreModel a `min_assets` precondition that raises
`DataUnavailable("cross-sectional model needs >= 3 assets")` at fit. Add an `xs: bool` attribute on the cross-sectional
models and have `plan_spec()` reject an xs model paired with a universe of fewer than 3 assets. Register the new run as
a new trial.

## 6. HIGH — `ridge` taking more than 100 min: hotspot

**Where:** `runner.py:146-153` calls `model.predict(truncate(ds.data, t), t)` at every decision. `base.py:267-276`
recomputes on a `[t − warmup, t]` window:
- the full feature stack (5 lag features plus funding z and basis z, using rolling 720-hour std and z-scores),
- `tradable_mask`, which goes to `stale_run_length` (`signals/trend.py:21-29`) and runs a **python per-column groupby cumsum**,
- `trailing_vol` again.

`ridge.warmup_hours` = 792 + 2·720 = 2232 bars, and the `pit_top_n` dataset has **125 columns**.

**Measured** (cProfile, `p1.py`): ridge takes **0.45 s per predict**, of which `features` is 0.20 s and `stale_run_length`
0.17 s. tsmom takes 0.24 s.
The decision count comes from `step = h`. At h=24 there are about 1,750 OOS decisions per run, so about 13 min.
The grid `{"ridge":[1,10,100], "horizon_hours":[4,24]}` adds 2 more h=24 runs (+26 min) and one **h=4 run, about 10,500
decisions, so about 80 min**. Five folds of `truncate` plus the `w.loc[t, asset]` scalar sets add more. The total is
about 2 h, which matches the kill at 100 min.

**Fix:** For each fold, call `score_panel` once on `truncate(data, test_end)`. Do the same for the tradable mask and the
vol. Then read rows at the decision times. Causality is unchanged because every feature is trailing, and the existing
causality test still guards it. Vectorise `stale_run_length` (`cumsum − cummax-reset` in numpy), and assign weights with
one `DataFrame` build rather than per-cell `.loc`. These changes should give about 100x.

## 7. HIGH — funding excluded from perp PnL

**Where:** `runner.py:161-167`. This is declared as a caveat in `plan.yaml`, but its impact is large, given #1: the
strategies are 85–97% long perps, and in 2021 and 2024 the funding paid by longs was often 10–30% APR. Gross
Sharpe is therefore overstated, and cost stress at 2x does not cover it, because funding is not a turnover cost.

**Fix:** Add `- w_{t-1} · funding_hourly` (sign: longs pay positive funding) to `net_returns`, using
`base.funding_hourly` (ceil-binned, causal).

## 8. MEDIUM — `decide()` logic gaps (`src/engine/research/promotion.py`)
- `:382`: a NaN PBO skips the hard REJECT. It is caught later only as a PROMOTE failure, so it can still become WATCH.
  A degenerate PBO (#2) is not distinguishable from a real 1.0.
- There is no benchmark or market-beta criterion. A strategy equal to buy-and-hold (EXP-000002) can PROMOTE if it
  passes everything else. Add `excess_vs_benchmark_sharpe` / `alpha_hac_p` to results, and add a gate. This is a new
  dated version of the rules file, which is allowed by the rules header.
- The WATCH tier relies on `dsr ≥ 0.5`. With #4, that is PSR ≥ 0.5, which means any positive Sharpe.
- `batch.py:333`: `leakage_pass: True` is hard-coded for the lead-lag trial.
- `n_trades` (`runner.py:214`) counts cell-level weight changes, so PIT membership flips count as trades.

## 9. MEDIUM — hindsight universe for cross-sectional ranks

**Where:** `batch.py:211-214`. The `ds_top` columns are every symbol that was **ever** in the top 15 through 2025-09.
At time t, `xs_demean_rank` ranks across all of them, including coins that only became large later. The PIT mask
only filters predictions. The ranks themselves, and so each asset's score, depend on a set chosen with knowledge of
the future (survivorship in the reference set).

**Fix:** In the xs models, apply the PIT mask to the score inputs, for example `close.where(mask)` before the rank.

## 10. MEDIUM — leakage tests cannot fail
- `runner.py:143`: `train_end + h < test_start` holds by construction of `walk_forward` (`label_end < ts − embargo`).
  It is always True.
- `runner.py:177-188`: `ScoreModel.predict` slices the data to `[t − warmup, t]` itself, so predict(full) == predict(trunc)
  is trivially true. The check does not test `fit` at all. Fit itself is correct: `forward_return` on truncated data,
  `base.py:179-181,238-246`.

**Fix:** Add a fit-time test. Fit on `truncate(data, end)` and on `data` with `end` passed in, and assert that the coefficients
are equal. Also perturb the data after `t` (shuffle or NaN it) and assert that the predictions do not change.

## 11. MEDIUM — lead-lag latency

`leadlag/engine.py:140-148`: the position is decided from `x_t` (the leader's bar-t close) and earns `y_{t+1}`
measured from the follower's bar-t close. That is the same timestamp, so there is zero latency. The economics are
optimistic, because the literature locates the effect at seconds to minutes, so it decays inside the first bar.

**Fix:** Earn from the follower's open of t+1 plus a delay (for example, the first 1–5 min are lost), or test with `y.shift(-2)`
as a robustness check.

## 12. LOW
- The runner's execution is "fill at close t" (`runner.py:161-163`, close-to-close `r[t+1]`). README rule 4 says
  open of t+1. On a 24/7 hourly grid the difference is tiny, but the docstring and README should match.
- `batch.py:311` and `multiple_testing._to_daily` compound **log** returns (from the lead-lag) as if they were simple.
  This has a negligible effect at hourly size.
- In `xs` models in sign mode, `n_assets` normalisation (`runner.py:138,153`) divides by every column (125), so the
  gross is tiny. Sharpe does not change, but `mean_turnover` and `total_net_return` are not interpretable.

---

## Checked and found correct
- **Walk-forward purge and embargo** (`splits.py:485-506`): train = obs whose label end is < test_start − embargo.
  This is AFML-consistent. `purged_kfold` overlap and embargo logic are correct.
- **Fit targets** never look past `end`: `forward_return` runs on truncated data, which gives NaN when t+h > end
  (`base.py:179-181, 238-246`). The ridge, logit and AR `_fit_inner` all use the truncated `train`.
- **Feature standardisation** (ridge) uses train-window mean and std only (`statistical.py:84-87`). There is no
  full-sample normalisation.
- **Position timing**: weights decided at t earn `r[t+1]` (`shift(1)`). Cost is charged on turnover at t. The 2x stress
  multiplies fees and half-spread (`runner.py:97-99, 205-206`). There is no double counting.
- **Annualisation** is consistent everywhere: hourly √8760 (`runner._ann_sharpe`, lead-lag 24·365) and daily √365
  (`strategy_stats`). No 252 is used anywhere in scope.
- **HAC**: Newey-West on daily returns with lags ⌊4(T/100)^{2/9}⌋, which is about 7 for T≈1750. That is adequate for holds of up to 72h.
  The lead-lag uses a fixed 24 hourly lags. That is reasonable.
- **Bootstrap**: stationary bootstrap with the Politis-White block length (`stats.py:38-51`). This is correct.
- **PSR formula** (non-excess kurtosis, `kurt−1)/4`) and **E[max SR]** (Euler-Mascheroni) match Bailey & LdP. Only the
  N fed to them is wrong (#4).
- **BH and Holm** (`multiple_testing.py`, `leadlag/methods.py`): step-up and step-down are correct, monotone, and handle NaN.
- **Regime labelers**: the expanding quantiles are `shift(1)`, so they use bars < t. The HMM is refit monthly on days
  before the month and uses forward filtering only. Daily labels are applied on day d+1. CUSUM uses `shift(1)` on the
  expanding variance. Funding labels: the event is ffilled onto the grid at or after its timestamp, and
  `funding_hourly` ceil-bins it. I found no look-ahead.
- **Calibration** (`ensemble/calibration.py`): `walk_forward_calibrate` fits on `[0, i)`. PAV and Platt are correct. The
  maturity lag for horizon h is documented as the caller's responsibility, and that is acceptable.
- **Lead-lag tradability**: lag and beta are selected on train only (`s − 1h`). The cost comes from train-window
  liquidity. The per-pair BH plus the 43-pair re-test in batch_001 is correctly reported as non-significant (q=0.089).
- **PIT universe mask** (`universe.py`): it uses only the bars before each boundary.
- **H2 guard**: data and prediction timestamps are asserted < H2_START (`runner.py:149,197-198`).
