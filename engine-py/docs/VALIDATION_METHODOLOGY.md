# VALIDATION_METHODOLOGY — bias prevention & statistical validation

Master-prompt §6 and §11. How this engine prevents look-ahead and research bias, and how it decides whether a
measured effect (e.g. the lead-lag event study) is real rather than a backtest artifact. Written 2026-10-09,
from the repo's code and configs; no code was changed authoring this doc.

**Verification legend:** [V] = source URL checked this session (2026-10-09); [K] = established method the
repo's `docs/research/03_*` already cites. Numeric results quoted are our own, reproducible from
`reports/leadlag/` and `experiments/`.

---

## 1. Look-ahead prevention (master-prompt §6, mandatory)

Enforced at three layers; each has a code anchor and, where present, a test.

### 1.1 Causal signal construction
- **Impulse threshold** uses trailing vol over the *previous* 720 bars with `.shift(1)` — the impulse bar is
  excluded from its own threshold (`leadlag/events.py::trailing_vol`, `detect_impulses`).
- **Rolling beta** is a trailing OLS of alt-on-BTC, also `.shift(1)` (`rolling_beta`), so the response estimate
  at bar *t* uses only data < *t*.
- **Forward-return labels** (`forward_sum`, `raw_h`, `abn_h`) are explicitly documented as *research labels
  that are never fed back as signals*; the tradable `LeadLagStrategy` imports only `detect_impulses`, not the
  forward panel (`signals/leadlag.py` docstring and imports).
- **Synthesized bars masked:** `log_returns` nulls any return touching an `is_filled` bar, so stale/forward-
  filled prices cannot create a fake move (`events.py::log_returns`).

### 1.2 Execution timing (no intrabar look-ahead)
The backtester decides weights from bar *t*'s close and **executes at the open of bar *t+1*** — nothing inside
the impulse bar is traded (`engine.backtest.engine.run_backtest`, steps 2; module docstring). Candle high/low
are never used as fill prices. Fills on stale (`is_filled`) bars are skipped and retried
(`meta["n_skipped_stale"]`). This is covered by `tests/test_no_lookahead.py` and `tests/test_time_axis.py`.

### 1.3 Chronological separation
- **Split** (`config/experiment.yaml`): dev ≤ **2024-06-30**, holdout starts **2024-07-01**. The holdout is
  *locked* — only an explicit `--unlock-holdout` / `--full` flag reads past `dev_end`
  (`leadlag/backtest_leadlag.py` truncates at `dev_end` by default).
- **Walk-forward** config: 24-month train / 3-month test / **168-bar (1-week) embargo** between train and test
  to purge overlap (`walk_forward` block; `engine.validation.walkforward`). Embargo matters here because the
  24h forward horizons create overlapping label windows.

---

## 2. Multiple-testing & overfitting control (master-prompt §6, §11)

The lead-lag study examines many cells: k∈{2,3} × horizons{1,2,4,8,24} × {dev, holdout, 7 years}, plus a
6-variant backtest grid at 3 cost multipliers. That is a large family, so significance is discounted
accordingly.

- **Pre-registration.** `config/leadlag.yaml` and `docs/LEADLAG.md` fix the hypothesis, universe, thresholds,
  horizons, split and the **go/no-go gate (dev forward outcome positive at t>2)** *before* results are viewed.
  The gate failed, so — per the pre-registration — the family is not promoted. [K]
- **Event clustering, not per-observation t-stats.** `summarize` first averages the outcome across alts within
  each event timestamp, *then* computes a **Newey–West HAC** t-stat over events with `maxlags = h`
  (`events.py::hac_mean`, `summarize`). This prevents the ~14-alt cross-section and the h-bar overlap from
  inflating the effective sample size. [K]
- **Higher factor hurdle.** New-factor t-stat bar is ≈3, not 2 (Harvey, Liu & Zhu, *RFS* 2016). [K]
  https://doi.org/10.1093/rfs/hhv059 — our best *forward* cell never reaches even |t|=2 positive in dev.
- **Deflated Sharpe Ratio (DSR)** and **Probability of Backtest Overfitting (PBO/CSCV)** (Bailey &
  López de Prado; Bailey et al.) are the engine's tools for the *production* sleeves — `experiments/
  dsr_sensitivity.py`, `experiments/holdout_log.jsonl`. [K]
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551 · https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
  For lead-lag they are **not computed**, and deliberately so: DSR is a correction to a *positive* Sharpe, and
  every lead-lag variant has a negative Sharpe even at 0× cost — there is nothing to deflate.
- **White's Reality Check / Hansen SPA** are the appropriate tools *if* a large candidate family produced a
  positive best-performer to test against the data-snooping null. Not triggered here (no positive candidate). [K]
- **Experiment registry.** Every run appends strategy, params hash, git SHA and full metrics to
  `experiments/registry.jsonl` (64 rows; 12 lead-lag) — a permanent, machine-readable record of what was tried,
  which is itself the raw material for any multiple-testing correction. [K]

---

## 3. Spurious-lead-lag diagnostics (the crypto-specific trap)

Because asynchronous trading can *manufacture* lagged correlation (Epps effect — arXiv physics/0701110,
0704.1099 [V]), a positive lagged cross-correlation is treated as *suspect until shown otherwise*:
- Same-venue sampling (Binance USDT-M only) and `is_filled` masking remove the most common asynchrony source
  (cross-exchange stale prints, halted contracts).
- The decisive check is **direction and executability**, not just significance: our lag-1 correlation is
  *negative* and the in-bar `gap` is *un-executable*, so even the statistically-significant pieces cannot be a
  tradable edge. See `docs/LEAD_LAG_RESEARCH_REVIEW.md` §2–§3.

---

## 4. Other bias checks already in the engine
- **Survivorship:** the universe keeps **LUNA** and **FTT** (collapsed) rather than today's survivors;
  `data/clean.py` detects ticker-reuse discontinuities and FTX-era *frozen* bars and marks them `is_filled`
  (`truncate_at_discontinuity`, the `frozen` mask). The lead-lag study itself excludes LUNA/FTT from the
  *followers* because their collapses are not information-diffusion events — a documented, defensible choice.
- **Reconciliation:** ledger-vs-equity identity and funding reconciliation have tests
  (`tests/test_reconcile.py`, `reports/audit/reconcile_*`), so reported PnL traces to simulated cash flows.
- **Cost stress:** base / 1.5× / 2× / (lead-lag also 0×) runs are first-class, not afterthoughts
  (`backtest_leadlag.py`, `CostModel.with_multiplier`). A strategy must survive 2× to be taken seriously. [K]

---

## 5. What is reproducible vs. what is asserted
- **Reproducible now:** event study + xcorr (`uv run python -m engine.leadlag.study`), the 6-variant +
  cost-grid backtest (`... engine.leadlag.backtest_leadlag`), and the registry entries. All figures in the
  lead-lag docs come from these artifacts.
- **Asserted (inference, not run):** that a 1-minute re-test would recover the literature's seconds-scale
  effect; that Granger/VAR would be uninformative at 1h. These are reasoned predictions, flagged as such.

## 6. Open gaps
- **No automated test pins the event-study numbers.** `tests/test_leadlag_signal.py` (sibling-owned) checks the
  *signal* causality; add a regression test that asserts the dev gate outcome (so a future refactor can't
  silently flip the verdict). Flagged for the code owner — not edited here.
- **DSR/PBO are wired for production sleeves, not for a would-be positive lead-lag cell.** If the 1m re-test
  produces a positive candidate, DSR+PBO+Reality-Check must be run on it *before* any promotion.
- **Holdout contamination:** the lead-lag holdout has now been viewed (this research). Per §6, if lead-lag is
  ever revisited for model *selection*, a fresh untouched period must be carved out.

## Sources
- https://doi.org/10.1093/rfs/hhv059
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253
- https://arxiv.org/abs/physics/0701110
- https://arxiv.org/pdf/0704.1099
