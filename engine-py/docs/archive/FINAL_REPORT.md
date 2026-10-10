> **Historical snapshot (archived 2026-10-10), superseded by `docs/LEADLAG_ENGINE.md` + `reports/leadlag/engine/verdicts.md` (lead-lag) and `README.md` section 7.** Kept unedited below for the
> record; facts here may be out of date. See `docs/INDEX.md`.

# FINAL_REPORT — BTC → altcoin lead-lag engine

Master-prompt §13 / §12 Stage 10. The honest, evidence-based conclusion on whether a BTC→altcoin lead-lag
edge exists and is tradable, what was built, what was verified, and what remains blocked or unproven.
Written 2026-10-09. Every number is reproducible from this repo (commands in each section).

---

## 1. Verdict

**There is no tradable BTC→altcoin lead-lag edge at 1-hour resolution.** Five independent lines of evidence
agree, and the single automated verdict (`scorecard.verdict`) is **`NO EDGE`**. The BTC→altcoin relationship
at hourly frequency is **contemporaneous**, not predictive: alts move *with* BTC inside the same hour and there
is nothing left to trade by the next bar. This is the master-prompt's explicitly-sanctioned outcome — a
complete, working research + paper-trading application that **recommends no live lead-lag strategy.**

The engine's *production* recommendation is unchanged and separate: **trend** (time-series momentum) is the
only sleeve with a positive, cost-robust, literature-grounded result, and even it is not yet statistically
proven out-of-sample — so the gate to real money is live paper-trading evidence, not more backtests.

---

## 2. What was tested (algorithms)

| § | Family | Form | Result on 1h data |
|---|---|---|---|
| A | Lagged cross-correlation | `lagged_xcorr` | L=0 ≈ 0.64–0.75; L≥1 ≈ 0 / slightly negative |
| B | Event study (impulse → response) | `event_panel` | in-bar `gap` significant (dev k=3: +31.6 bps, HAC-t 5.2); all forward cells ≤ 0 |
| C | Granger (HAC + BH-FDR) | `predictive.granger_table` | 0 of 13 followers reject; β-sums mostly negative |
| E | Rolling best-lag stability | `predictive.rolling_lag_stability` | modal lag = 0 for all 13 (stable) |
| F | Relative-response / reversion | `leadlag direction=reversion` | also loses (Sharpe −2.95) |
| G | Walk-forward OOS R² | `predictive.oos_predictive_r2` | incremental BTC-lag R² negative for all 13 |
| H | Baselines | trend, BTC buy&hold, `BtcImpulseFollow` | see scorecard |
| — | **Executable strategy** | `LeadLagStrategy` k∈{2,3}×hold∈{1,2,4} | all negative net *and* gross |

Reproduce: `uv run python -m engine.leadlag.study`, `... research_predictive`, `... backtest_leadlag`.

## 3. Headline numbers (development period, ≤ 2024-06-30, net of costs unless noted)

| Strategy | Sharpe | Total return | Ann. turnover | HAC t |
|---|---|---|---|---|
| Lead-lag k2/h1 | **−4.23** | −99.95% | 102× | −8.4 |
| Lead-lag k2/h1 **gross (0× cost)** | **−0.74** | −80.1% | 247× | — |
| Lead-lag k2/h1 2× cost | −7.40 | −100.0% | 66× | — |
| Lead-lag (best variant, k3/h4) | −1.83 | −98.5% | 83× | −3.7 |
| Lead-lag reversion | −2.95 | −99.6% | 425× | −6.3 |
| btc_impulse baseline (§4.H) | −2.23 | −94.3% | 179× | −4.8 |
| **trend baseline** | **+1.08** | +149.1% | 139× | +2.3 |
| **BTC buy-&-hold** | +1.05 | +771% | 0.2× | +2.3 |

**The decisive fact:** the lead-lag basket is **negative even at zero trading cost** (gross Sharpe −0.74). This
is a *signal* failure, not a cost failure — costs merely deepen a loss that already exists. Both directions
(continuation and reversion) lose, and the single-asset BTC baseline loses too, so no reframing of the basket
rescues it. The in-bar under-reaction (`gap`) is real and significant but is realized *inside* the bar that
defines the event, so it is un-executable at hourly resolution.

## 4. Dataset coverage
- Source: Binance public archive (`data.binance.vision`), checksum-verified. 1-hour bars, spot + USDT-M perp +
  funding, **Jan 2020 – Sep 2026** (~59k hours/coin for the full-history coins).
- Universe: 16 coins including the collapsed **LUNA** and **FTT** (survivorship-bias control).
- Lead-lag followers: 13 large-caps (FTT/LUNA excluded as collapsed).
- Quality: no duplicate/invalid OHLC rows; gaps forward-filled and flagged `is_filled`; **frozen halted-contract
  bars now flagged stale** (see §6). Resolution caveat: 1h cannot resolve the seconds-to-minutes lead the
  literature documents (`docs/LEAD_LAG_RESEARCH_REVIEW.md`).

## 5. Costs & robustness
- Taker fees (spot 10 bps, perp 5 bps), measured/estimated half-spread (p75), √-law market impact, funding,
  forced-exit at 2× on delisting. Applied identically to every candidate and recomputed independently by
  `validation/reconcile.py`. Stress: 1×/1.5×/2× costs (lead-lag fails at all three, and at 0×).
- Statistics: block-bootstrap Sharpe CI, HAC (Newey-West) t-stats, deflated Sharpe over the registry trial
  count, PBO/CSCV, SPA vs BTC. Assumption caveats (PBO iid, SPA stationarity) in `docs/VALIDATION_METHODOLOGY.md`.

## 6. Defects found and fixed
- **CRITICAL (fixed & tested):** frozen post-collapse FTT bars were treated as real, inflating the 2022 dev
  result. Fixed in `data/clean.py`; data regenerated — FTT's last real perp bar is now 2022-11-14; liquid coins
  unaffected. Full write-up + remaining findings in `docs/archive/CURRENT_ENGINE_AUDIT.md`.
- Live/paper trading audited: shared signal path, idempotent restarts, no real-order path, safe credentials,
  working kill-switch/daily-loss/leverage/stale/exchange-error controls — all confirmed (minor documented
  caveat: `day_start_equity` baseline precision).

## 7. Experiment count & reproducibility
- Automated tests: **159 pass** (`uv run pytest -q`); `ruff`/`mypy` clean.
- Experiments logged to `experiments/registry.jsonl` (lead-lag grid, reversion, scorecard verdict, engine
  sleeves). Artifacts in `reports/leadlag/` (`event_study.csv`, `xcorr_by_year.csv`, `predictive_*.csv`,
  `rolling_lag.csv`, `strategy_comparison.csv`, `scorecard.csv`) and `reports/data_integrity.json`.
- Holdout integrity: the locked 2024-07 → 2026-09 period is **not** read by the lead-lag runners (dev-only by
  default); the engine pipeline still gates it behind `--unlock-holdout` with an append-only view log.

## 8. Failures, limitations, and what remains blocked
- **Resolution blocker (not capability):** the one experiment that could overturn the reject is a 1-minute
  (and aggTrades/bookTicker) re-test on a small-cap universe. That data is not downloaded here (volume/time).
  All code (`predictive.py`, `backtest_leadlag.py`) is resolution-agnostic and ready for it.
- **VAR / state-space / full ML** not built — justified by §11 (no simple-baseline edge to improve on) and the
  negative incremental OOS R². Would only be warranted if a 1m gross edge appears.
- **Trend is not statistically proven** out-of-sample (Sharpe CI includes zero; holdout already inspected).
  Only forward live paper-trading counts as new evidence.
- The engine's **full HTML report was not regenerated** on the new data to avoid touching the locked holdout;
  the dev-only report is safe to refresh (`uv run engine backtest`).

## 9. Recommendation
1. **Do not deploy any lead-lag strategy.** Keep it `enabled: false`; it is a reproducible research artifact.
2. **Paper-trade trend** (optionally + carry) and accumulate a forward track record before any real-money
   discussion. Real execution stays disabled by default and gated behind the checklist in
   `docs/OPERATIONS_AND_RISK.md`.
3. If lead-lag is to be revisited, do the **1-minute small-cap re-test** — it is the only path that can change
   the verdict, and the harness is ready.
