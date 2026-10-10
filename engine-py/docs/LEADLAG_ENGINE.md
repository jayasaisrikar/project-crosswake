# LEADLAG_ENGINE — multi-method lead-lag study (`engine.leadlag.engine`, `engine.leadlag.methods`)

Phase 5. Run: `uv run python -m engine.leadlag.engine` (~40 min). Outputs in `reports/leadlag/engine/`:
`results.csv` (each pair x lag x method: stat, p, BH q, reject), `verdicts.md` / `verdicts.csv`,
`walkforward_folds.csv`, `decay_by_lag.csv`. Only data < H2_START (2025-10-01) is loaded.

## Scope
* Pairs (43): BTC->13 alts, ETH->12 alts, perp->spot and spot->perp for BTC/ETH/BNB/SOL/XRP/DOGE,
  and an equal-weight basket of the 5 large caps -> ZEC/XTZ/IOTA/VET/THETA/ALGO.
* Lags: 1, 2, 4, 8, 24 h. **Sub-hour lags cannot be tested.** Hourly bars are the finest data we have, and
  the literature (docs/LEAD_LAG_RESEARCH_REVIEW.md) puts the BTC->alt lag at seconds to minutes.
* Methods: lagged cross-correlation (Fisher z), lagged OLS with HAC t, Granger F (statsmodels), VAR(24)
  impulse response with asymptotic SE, rolling 90-day sign stability (binomial), binned mutual
  information and binned transfer entropy (199 shuffled surrogates each). BH at q <= 0.05 across all
  1505 tests.

## Tradability (no full-sample selection)
Expanding walk-forward with 6-month test folds and at least 1 year of training. On each training window
the lag with the largest |HAC t| and its OLS (a, b) are chosen. That fit then trades the next fold:
at bar close t, forecast y_{t+1} = a + b x_{t+1-L}. The engine takes the sign as its position only
when the forecast exceeds the round-trip cost. Costs come from `engine.costs.CostModel` (experiment.yaml:
fees + measured half-spread + sqrt impact at $10k) and use only training-window liquidity and volatility.
Reported: OOS IC, hit rate, expectancy, gross and net Sharpe, net HAC t, fraction of folds positive,
net bps by trend regime (`engine.regimes`), and per-lag OOS decay.

Verdict: **EDGE EXISTS** = at least one BH-significant test AND OOS net HAC t > 2 AND at least 60% of
folds positive. **EDGE DOES NOT SURVIVE** = OOS net total <= 0, or no BH significance with t <= 2.
**INSUFFICIENT EVIDENCE** = fewer than 200 active bars or 3 folds, or mixed evidence.

## Result (honest reading)
* Verdict counts: 1 EDGE EXISTS (BTC->ADA, lag 24h), 20 EDGE DOES NOT SURVIVE, 22 INSUFFICIENT EVIDENCE.
* Statistical "significance" is everywhere (1084/1505 BH rejections). It does not translate into tradable
  edge. MI and TE reject in about 100% of cells because binned dependence picks up shared volatility
  clustering, not direction. They show that dependence exists, not that it can be traded.
* Training-window selection overwhelmingly picks 24h. That is a daily-cycle / slow co-movement effect,
  not the fast lead-lag the literature documents. The OOS IC is about 0.01-0.04.
* Median OOS net bps per bar by lag is roughly 0 at every lag. 1h is negative net of costs.
* BTC->ADA (net Sharpe 1.42, HAC t 2.98, 9 of 10 folds positive) is 1 of 43 pairs. Every pair went
  through a selection step, so one survivor is roughly what chance and the family size predict. Treat it
  as a **candidate only**. It needs pre-registration and confirmation on H2 before any capital is used.
  No pair-level multiple-testing correction is applied to the OOS t-stats.
* Conclusion: there is no robust tradable BTC/ETH->alt, perp<->spot, or basket->small-cap lead-lag edge
  at hourly resolution.
