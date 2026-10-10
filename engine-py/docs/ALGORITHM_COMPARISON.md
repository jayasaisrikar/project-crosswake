# ALGORITHM_COMPARISON — lead-lag candidate families & scorecard

Master-prompt §4 and §11. Which algorithm *families* were considered for the BTC→altcoin lead-lag
hypothesis, which were implemented, how they are evaluated on a common scorecard, and the verdict for each.
Written 2026-10-09. Read alongside `docs/LEAD_LAG_RESEARCH_REVIEW.md` (evidence) and
`docs/VALIDATION_METHODOLOGY.md` (how significance and overfitting are controlled).

All numbers below are reproduced from this repo:
- `uv run python -m engine.leadlag.study` → `reports/leadlag/event_study.csv`, `xcorr_by_year.csv`
- (removed 2026-10-10: `engine.leadlag.research_predictive` was unreachable dead code; its outputs `reports/leadlag/predictive_granger.csv`, `rolling_lag.csv`, `predictive_oos.csv` remain as historical files; the canonical stack is `engine.leadlag.engine`/`methods`)
- `uv run python -m engine.leadlag.backtest_leadlag` → `reports/leadlag/strategy_comparison.csv`, `scorecard.csv`

Scope note: this doc covers the **lead-lag research track**. The engine's production sleeves (trend, carry,
breakout, xsmom) and their comparison live in `docs/research/` and the engine reports; they appear here only
as **baselines**.

---

## 1. Common interface (so candidates are comparable)
Every candidate implements the same `Strategy` protocol (`src/engine/contracts.py`): a `target_weights(data)
-> TargetWeights(spot, perp)` method returning causal weights indexed by decision-bar open. All candidates are
then priced by the **same** event-driven backtester (`engine.backtest.engine.run_backtest`) and the **same**
cost model (`engine.costs.CostModel`): identical data, identical fills (enter at next-bar open), identical
fees/spread/impact/funding. See `docs/DATA_AND_EXECUTION_MODEL.md`.

---

## 2. Candidate families (master-prompt §4 A–H) and disposition

| § | Family | Implemented? | Where | Disposition on 1h data |
|---|---|---|---|---|
| A | Cross-correlation & lag analysis | **Yes** | `leadlag/events.py::lagged_xcorr`, `study.py` | L=0 ≈ 0.64–0.75 every year; L≥1 ≈ 0 / slightly negative. No usable lead at 1h. |
| B | Event study (BTC impulse → alt response) | **Yes** | `leadlag/events.py`, `study.py` | In-bar under-reaction significant; **all forward cells ≤ 0 in dev**. Not tradable. |
| C | Granger-style predictive test | **Yes** | `leadlag/predictive.py::granger_table` | Lagged BTC, controlling own lags, HAC inference, BH-FDR @0.10: **0 of 13 followers reject**; β-sums mostly negative. |
| D | VAR / multivariate | **No** (documented) | — | Not built: contemporaneous ρ≈0.7 with zero stable lagged signal makes a 1h VAR lead-term uninformative. Reserved for 1m data. |
| E | Dynamic rolling lag estimation | **Yes** | `leadlag/predictive.py::rolling_lag_stability` | Modal best-lag = **0 for all 13** followers (share≈1.0, lag_std≈0): the lead is contemporaneous, not a stable positive lag. |
| F | Relative-response / residual (abnormal return) | **Yes** | `abn_h` in `event_panel`; `leadlag` `direction=reversion` | `abn_*` forward cells ≤ 0 in dev; the reversion (overreaction) strategy also loses (Sharpe −2.95). No profitable convergence. |
| G | Regularized / ML / OOS predictor | **Yes (OOS R²)** | `leadlag/predictive.py::oos_predictive_r2` | Walk-forward incremental OOS R² of adding BTC lags is **negative for all 13** followers. §11: complexity unjustified. |
| H | Baselines | **Yes** | trend sleeve, BTC buy&hold, single-asset `BtcImpulseFollow` | Comparison floor (see scorecard). |

**Tradable strategy form built:** `LeadLagStrategy` (`src/engine/signals/leadlag.py`) — impulse-following,
`direction` ∈ {continuation, reversion}: on a signed BTC impulse at bar *t*, target an equal-weight basket of
eligible followers in `sign(r_BTC)` (continuation) or the opposite sign (reversion), enter at open *t+1*, hold
`hold_hours`, then flat. Causal by construction (forward labels never used). Pre-registered grid: k∈{2,3} ×
hold∈{1,2,4}, plus the headline cell at 0×/1×/2× cost and a reversion variant. `BtcImpulseFollow` is the
single-asset §4.H baseline (trade only BTC in its own impulse direction). All logged to
`experiments/registry.jsonl`.

---

## 3. Scorecard (master-prompt §11) — development period (≤ 2024-06-30), net of costs unless noted

Source: `reports/leadlag/strategy_comparison.csv` and `reports/leadlag/scorecard.csv`.

| Strategy (dev) | Total ret | CAGR | Ann vol | Sharpe | Sortino | Max DD | Ann. turnover | n trades | HAC t |
|---|---|---|---|---|---|---|---|---|---|
| LL k2 h1 | −99.95% | −81.8% | 0.38 | **−4.23** | −5.28 | −99.95% | 102× | 49,146 | −8.4 |
| LL k2 h1 **0×cost (gross)** | −80.1% | −30.2% | 0.38 | **−0.74** | −0.96 | −87% | 247× | 49,164 | — |
| LL k2 h1 2×cost | −100.0% | −95.1% | 0.40 | −7.40 | −8.89 | −100.0% | 66× | 49,161 | — |
| LL k2 h2 | −99.95% | −81.9% | 0.46 | −3.45 | −4.55 | −99.96% | 100× | 51,969 | −7.2 |
| LL k2 h4 | −99.94% | −80.9% | 0.57 | −2.60 | −3.62 | −99.95% | 110× | 56,718 | −5.6 |
| LL k3 h1 | −95.8% | −50.5% | 0.32 | −2.05 | −2.49 | −96.4% | 99× | 18,837 | −4.7 |
| LL k3 h2 | −97.2% | −54.8% | 0.36 | −2.01 | −2.46 | −97.7% | 78× | 20,660 | −4.0 |
| LL k3 h4 | −98.5% | −60.6% | 0.45 | −1.83 | −2.39 | −99.0% | 83× | 24,117 | −3.7 |
| LL k2 h1 **reversion** | −99.6% | −70.1% | 0.38 | −2.95 | −4.37 | −99.6% | 425× | 49,304 | −6.3 |
| **btc_impulse baseline** (§4.H) | −94.3% | −47.0% | 0.27 | −2.23 | −3.02 | −94.3% | 179× | 3,706 | −4.8 |
| **trend baseline** | +149.1% | +22.5% | 0.21 | **+1.08** | 1.51 | −24.4% | 139× | 16,012 | +2.3 |
| **BTC buy-&-hold** | +771% | +61.8% | 0.68 | +1.05 | 1.47 | −77.5% | 0.2× | 1 | +2.3 |

**Automated verdict (`scorecard.verdict`): `NO EDGE: no candidate cleared the pre-registered rejection gate on the dev window`.**

### Reading of the scorecard (the §11 dimensions)
- **Net return / CAGR / Sharpe / Sortino:** every lead-lag variant is strongly negative; both baselines are
  strongly positive on the identical window. The sign is unambiguous.
- **Incremental value over baselines (decisive):** *none.* Every lead-lag variant is worse than cash, worse
  than trend, worse than buy-&-hold on every return and risk-adjusted metric.
- **Cost sensitivity:** monotone and fatal (−0.74 gross → −4.23 at 1× → −7.40 at 2×). The key point: it is
  **already negative at 0× cost**, so this is a *signal* problem, not a cost problem. Both directions
  (continuation and reversion) lose — there is no sign of the basket that wins.
- **Turnover / capacity:** ~100× annual turnover, tens of thousands of trades — a basket re-struck on every
  impulse. Even a real gross edge would struggle to survive this churn; there is none.
- **Statistical uncertainty:** daily-return HAC (Newey-West) t-stats are −3.7 to −8.4 for the lead-lag family
  (reliably *below* zero). Deflated-Sharpe is 0.0 for every candidate (vs ~0.22–0.24 for the baselines).
- **Walk-forward / OOS / regime:** incremental OOS R² of BTC lags is negative for all 13 followers; event-study
  forward cells alternate sign across years with |t| mostly < 1.5 → no stable regime where it works.
- **Operational complexity / data:** the 1-hour resolution cannot see the documented seconds-scale effect
  (`LEAD_LAG_RESEARCH_REVIEW.md` §1), so complexity cannot be traded for edge here.

---

## 4. Decision (master-prompt §11 rejection rule)
**Reject the lead-lag family for live/paper deployment at 1-hour resolution.** Rejection criteria (`scorecard.REJECTION`)
were fixed in code *before* examining the holdout: a candidate passes only if it clears **all** of
{net Sharpe > 0, net total return > 0, gross Sharpe > 0, incremental Sharpe over the best baseline > 0,
|HAC t| > 2 in the right direction, 2×-cost-stress Sharpe > 0}. Every candidate fails the first criterion.
The family is retained as a **research module only**, with `enabled: false` in `config/experiment.yaml`. This
is the master-prompt's explicitly-sanctioned outcome: a working research pipeline that **recommends no live
lead-lag strategy**.

Baselines retained for the engine's actual production decision: **trend** (positive, cost-robust, matches the
momentum literature) and **carry** (threshold-gated, decayed post-2024) — their comparison is in `docs/research/`.

## 5. Open gaps / what would change the verdict
- **Resolution (the one decisive experiment).** The literature's tradable effect is at 1-minute/seconds
  (`LEAD_LAG_RESEARCH_REVIEW.md` §1). Re-running this exact scorecard + predictive suite on **1-minute klines**
  (and aggTrades/bookTicker for second-level response curves) on a small-cap universe is the single experiment
  that could overturn the reject. No 1m data is downloaded here (documented blocker: volume/time, not capability).
- **VAR / state-space / ML (§4.D, §4.G beyond OOS R²)** are not built as full models — justified by §11
  (no simple-baseline edge exists to improve on) and by the negative incremental OOS R². If the 1m re-test
  finds a gross edge, both should be coded with stationarity/lag-selection diagnostics before any trading claim.
