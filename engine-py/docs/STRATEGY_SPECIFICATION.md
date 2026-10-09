# STRATEGY_SPECIFICATION — signal pipeline, parameters, and decisions

Master-prompt §8 / §11. The transparent, reproducible specification of each strategy in the engine: the
lead-lag family that was the primary research target (now rejected at 1h) and the production sleeves that the
engine actually recommends. Every rule here is implemented in code and priced by the common backtester.
Written 2026-10-09.

---

## 1. Lead-lag strategy (primary research target) — `src/engine/signals/leadlag.py`

### 1.1 Hypothesis
When BTC prints a large signed return at the close of hour *t*, eligible altcoins **continue** in the same
direction over the next few hours by enough to beat costs (the tradable form of the §4.B event study). A
`reversion` variant tests the opposite (overreaction) hypothesis.

### 1.2 Signal pipeline (maps to §8 steps 1–10)
1. **Detect BTC event.** `r_BTC[t] = Δlog(close_BTC)`, masked where the bar or its predecessor is `is_filled`.
   Trailing vol `σ[t]` = std of the previous `vol_lookback_bars` (720 = 30d) returns, `shift(1)` (excludes *t*).
   Impulse `= sign(r_BTC[t])` when `|r_BTC[t]| > k·σ[t]`, else 0. **Causal** (only data ≤ *t*).
2. **Estimate expected response.** Equal-weight basket of all eligible followers (the engine does not rely on a
   per-alt beta forecast for the tradable rule, because the §4.C/E/G tests show lagged BTC carries no stable
   predictive beta — see `docs/ALGORITHM_COMPARISON.md`).
3. **Reliability / eligibility filter.** `tradable_mask` (shared with trend): valid close **and** not stale for
   more than 24 consecutive bars. The leader (BTC) is never traded by `LeadLagStrategy`.
4. **Rank / size.** Equal weight `w_each = min(gross / n_eligible, max_weight_per_asset)`, signed by the impulse
   direction (× −1 for `reversion`). Gross target = `gross` (default 1.0), per-asset cap `max_weight_per_asset`
   (0.25).
5. **Entry / exit / holding time.** Decision at close of *t* → **fill at open of t+1** (backtester invariant;
   no intrabar fills). Hold `hold_hours` decision bars, then flat. No stop/target beyond the time exit (the
   effect, if any, is horizon-bounded).
6. **Decisions are logged** to `experiments/registry.jsonl`; the pre-registered grid is k∈{2,3} × hold∈{1,2,4}.

### 1.3 Parameters (`config/experiment.yaml::strategies.leadlag`, `config/leadlag.yaml`)
`market=perp, leader=BTC, k=2.0, vol_lookback_bars=720, hold_hours=1, gross=1.0, max_weight_per_asset=0.25,
allow_short=true, direction=continuation`. Followers: 13 large-caps (FTT/LUNA excluded — collapsed).

### 1.4 Baseline — `BtcImpulseFollow` (§4.H)
Single-asset control: trade only BTC in its own impulse direction, held `hold_hours`. Isolates how much of any
basket result is just BTC return-autocorrelation (answer on 1h data: it loses too, Sharpe −2.2).

### 1.5 Decision
**Not deployed.** Pre-registered rejection gate (`scorecard.REJECTION`) returns `NO EDGE`: every variant has
negative net *and* gross Sharpe on dev, negative incremental value vs baselines, HAC t ≪ 0, and negative
incremental OOS R². `enabled: false` in production config. Retained as a reproducible research module and as
the template for a future 1-minute re-test.

---

## 2. Trend (production core) — `src/engine/signals/trend.py`

- **Idea:** time-series momentum (Moskowitz–Ooi–Pedersen 2012). Daily decision at 00:00 UTC.
- **Score:** mean of `sign(close/close.shift(L·24) − 1)` over lookbacks L ∈ {20,60,120} days → [−1,+1].
- **Sizing:** inverse-vol risk parity per asset, then the whole row scaled so ex-ante portfolio vol (proposed
  weights on the trailing `vol_lookback_days`=30 window) = `vol_target_annual`=0.20. Caps last:
  `max_weight_per_asset`=0.25, `max_gross_leverage`=2.0. `allow_short=true`.
- **Eligibility:** `tradable_mask` + sufficient history + positive vol. Causal (truncation-invariant; tested in
  `tests/test_no_lookahead.py`).
- **Decision:** the engine's recommended sleeve — positive, cost-robust, literature-grounded (see §4 below).

## 3. Carry (optional overlay) — `src/engine/signals/carry.py`

- **Idea:** spot-long / perp-short to harvest funding when it more than pays for round-trip costs.
- **Rules:** enter when trailing funding APR > 10% and `14·APR/365 > margin·round-trip cost`; exit < 2% APR;
  ≤ 5 positions; skip if `|spot/perp − 1| > 2%`; daily rebalance with a 0.25·w no-trade band.
- **Decision:** kept, but structurally quiet since 2024 (funding decayed) — trades only when it pays.

## 4. Portfolio construction & risk (shared)
- **Allocation** (`config/experiment.yaml::strategies.allocation`): sleeves combined at fixed capital weights
  (default trend 0.5 / carry 0.5), each sleeve **re-run at its exact capital** (impact is non-linear in size).
- **Risk limits:** per-asset weight cap, gross leverage cap, portfolio vol target; live adds a 20% peak-to-
  trough kill switch, 5% daily-loss halt, stale-data and exchange-error halts (`docs/OPERATIONS_AND_RISK.md`).
- **Exits compared:** time-based (lead-lag), signal flip (trend), funding-threshold (carry), forced exit on
  delisting (all, at 2× cost on the last real close).

## 5. Production recommendation
Deploy **trend** (optionally + carry) to paper trading; **do not** deploy any lead-lag strategy. The trend edge
is not yet *statistically proven* out-of-sample (wide Sharpe CI including zero; see
`docs/VALIDATION_METHODOLOGY.md`), so live paper-trading evidence — not further backtests on the contaminated
holdout — is the gate for any real-money consideration.
