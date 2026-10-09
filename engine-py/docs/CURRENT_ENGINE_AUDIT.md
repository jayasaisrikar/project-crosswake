# CURRENT_ENGINE_AUDIT — independent audit of the existing engine

Master-prompt §2 / §12 Stage 2. An independent re-inspection of the repository as it stood at handoff
(`8afa308`), with every material claim checked against the code and reproduced where possible. Findings use
the required format: **file**, **existing behavior**, **evidence**, **defect/limitation**, **severity**,
**recommended fix**, **fixed & tested?**. Written 2026-10-09.

Ground truth reproduced this session:
- `uv run pytest -q` → **159 passed** (134 pre-existing + 25 added this session).
- `ruff check src tests` and `mypy src` → clean (50 source files).
- Lead-lag study, predictive suite and strategy comparison reproduced (see `docs/ALGORITHM_COMPARISON.md`).

The engine is genuinely well-built: a causal `Strategy` protocol, an event-driven backtester with
next-bar-open fills, an independent reconciliation module, a locked holdout with an append-only view log,
and a paper-trading loop that shares the backtest's signal code. The audit confirms these claims. The one
**critical** defect found (and fixed) is a data-cleaning bug the README itself flagged as "planned".

---

## Critical / High

### F1 — Frozen (halted-contract) bars treated as real — CRITICAL — **FIXED & TESTED**
- **File:** `src/engine/data/clean.py` (`clean_bars`, was line 127).
- **Existing behavior:** a bar was marked `is_filled=True` (stale) only when its `close` was *missing* before
  the forward-fill. Bars that were *present in the archive* but carried no trading (volume 0, o=h=l=c equal to
  the prior close) were kept as `is_filled=False`, i.e. treated as executable.
- **Evidence:** after FTX collapsed (Nov 2022) Binance kept publishing flat zero-volume FTT perp bars. The
  original `audit/core.py::frozen_mask` already *detected* these, and the audit report documented 13 phantom
  FTT trades (2022-11-30…12-15). The backtester closed an FTT short at a price nobody could trade.
- **Defect:** look-ahead/executability violation inflating the 2022 development result (README: ≈ +8.9% vs
  ≈ +2.7% without FTT).
- **Fix:** mark a present bar stale when `volume==0 & o==h==l==c==prev_close` (the exact `frozen_mask`
  signature), in addition to missing bars. Conservative — the `h==l` test excludes genuinely quiet but
  tradable hours.
- **Fixed & tested?** **Yes.** `clean.py` patched; data regenerated from `data/raw`. FTT perp now has its last
  real bar at **2022-11-14 04:00 UTC**; the 1,124 Nov–Dec 2022 frozen bars are flagged stale, so
  `tradable_mask` (MAX_STALE_BARS=24) makes FTT untradable shortly after the halt (forced exit at the last real
  close). Liquid coins are essentially unaffected (BTC/ETH/DOGE perp `is_filled` ≈ 0.00%), confirming the rule
  does not over-flag. Regression tests added: `tests/test_data.py::test_frozen_zero_volume_flat_bars_marked_stale`
  and `::test_quiet_zero_volume_bar_with_range_stays_tradable`.

### F2 — PBO / CSCV assumes (near-)iid blocks — HIGH — documented caveat
- **File:** `src/engine/validation/stats.py` (`pbo_cscv`).
- **Existing behavior:** CSCV PBO splits the trial-return matrix into S combinatorial halves and compares
  in-/out-of-sample Sharpe ranks.
- **Evidence/limitation:** crypto hourly returns are serially dependent (funding cycles, rebalancing); CSCV's
  block comparison treats halves as exchangeable. The reported development PBO (README: 0.94) is therefore a
  *conservative/biased* figure, not a calibrated probability.
- **Recommended fix:** keep PBO as a qualitative overfitting flag; prefer the block-bootstrap Sharpe CI and the
  pre-registration discipline for the hard decision. Add the caveat to the report prose.
- **Fixed & tested?** Not a code bug; caveat recorded here and in `docs/VALIDATION_METHODOLOGY.md`. `test_validation.py`
  covers the estimator on synthetic data.

---

## Medium

### F3 — Deflated-Sharpe / SPA assumption surface — MEDIUM — reviewed
- **File:** `src/engine/validation/stats.py` (`deflated_sharpe`, `spa_test`), `pipeline.py`.
- **Review:** the pipeline feeds **daily** returns to all robustness stats consistently (`metrics.daily_returns`
  in `period_stats`, `_boot_ci`, `_psr`), so the earlier concern about mixed-frequency DSR does not materialize
  in the wired path. SPA uses the stationary bootstrap (Politis–Romano), which assumes weak stationarity; crypto
  regime shifts weaken it. **Recommended:** report SPA as directional evidence, not proof; retain the deflated
  Sharpe over the honest registry trial count.
- **Fixed & tested?** No code change required; documented.

### F4 — `day_start_equity` baseline semantics — MEDIUM — documented
- **File:** `src/engine/live/paper.py` (`day_start_equity`).
- **Behavior:** returns the last equity-log entry at/before UTC midnight, falling back to the first entry of the
  day. This can use the previous day's close rather than an exact 00:00 mark, so the daily-loss baseline is
  approximate on the first run of a day.
- **Severity/impact:** affects the daily-loss *trigger point* by at most one bar's drift; the kill-switch
  (peak-to-trough) is unaffected. **Recommended:** persist an explicit day-start snapshot at the first run after
  midnight. Documented in `docs/OPERATIONS_AND_RISK.md`; not fixed (no correctness failure, behavior is safe-side).

---

## Low / confirmed-correct

### F5 — Reconciliation is genuinely independent — LOW (confirmed PASS)
- **File:** `src/engine/validation/reconcile.py`. Recomputes fees/spread/impact from `CostModel` and live
  `rolling_adv_and_vol` (not from `result.costs`) and checks the per-bar identity
  Δequity = Δnotional − traded − costs − funding. `tests/test_reconcile.py` passes. Tolerance scales with
  position size (`risk.py` reconcile uses `tol*max(1,|y|)`) — acceptable given 1e-6 base tolerance.

### F6 — Walk-forward embargo/purge — LOW (confirmed PASS)
- **File:** `src/engine/validation/walkforward.py`. Train windows are purged of `embargo_bars` around each test
  window; splits are non-overlapping. `tests/test_validation.py` confirms.

### F7 — No real-order path; credentials safe — LOW (confirmed PASS)
- **Files:** `src/engine/live/*`. Only public Binance GET endpoints (`klines`, `fundingRate`) and the Telegram
  Bot API are called. No exchange order/withdrawal path, no SDK, no signed requests. Telegram token read from
  env only (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`), never hardcoded or logged to files. `close_prices` uses an
  unbounded ffill but is guarded by the 2-hour stale-data halt.

### F8 — Backtest ↔ paper signal parity — LOW (confirmed PASS)
- **Files:** `signals_live.py` and the backtest both build strategies via `signals/registry.build_strategies`
  and call `.target_weights`; the live path takes the last decision row. No divergent signal code.

---

## New infrastructure added this session (to close §2/§5 gaps)
- `src/engine/data/integrity.py` (`check_dataset`): timestamp monotonicity/duplication, bar-grid gaps, OHLC
  sanity, funding-event alignment to the hour and to the perp listing window, spot/perp basis. Writes
  `reports/data_integrity.json`. Tested in `tests/test_data_integrity.py` (deterministic + causal).
- `src/engine/leadlag/predictive.py` (§4.C/E/G: Granger with HAC + BH-FDR, rolling-lag stability, walk-forward
  OOS R²), tested in `tests/test_leadlag_predictive.py`.
- `src/engine/leadlag/scorecard.py` (§11 pre-registered rejection gate + honest verdict), tested in
  `tests/test_leadlag_scorecard.py`.
- `src/engine/signals/leadlag.py` (`LeadLagStrategy`, `BtcImpulseFollow`): the executable lead-lag family on the
  common interface, tested for causality in `tests/test_leadlag_signal.py`.

## Prioritized remediation list
1. **Done:** F1 frozen-bar fix + data regeneration + tests (critical).
2. **Reporting caveats (F2, F3):** add PBO-iid and SPA-stationarity caveats to generated report prose.
3. **Operational hardening (F4):** persist an explicit day-start equity snapshot.
4. **Re-run the full engine report** (`uv run engine backtest`) on the regenerated data to refresh the headline
   2022 numbers now that FTT phantom trades are removed (the holdout 2024–2026 numbers are unaffected). Not run
   here to avoid opening the locked holdout; the dev-only report is safe to regenerate.
