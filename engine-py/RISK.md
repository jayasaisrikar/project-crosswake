# RISK — ensemble, edge, NO TRADE and portfolio risk (`engine.ensemble`)

The pipeline goes from model `Prediction`s to target weights. Prediction and risk are kept separate:
models forecast; the risk engine sizes.

```
models -> calibration -> combine (admission, weights, disagreement) -> apply_edge -> no_trade.gate
       -> risk.target_weights -> execution (engine.live.paper)
```

## 1. Calibration (`calibration.py`)
- `IsotonicCalibrator`: isotonic regression using a numpy pool-adjacent-violators routine (`pav`). `PlattCalibrator`: a logistic fit by Newton-Raphson on Platt-smoothed targets.
- Both calibrators fit only on walk-forward OOS `(score, sign-correct)` pairs. `walk_forward_calibrate` fits the value at row i on rows `[0, i)` only, so each outcome must be realized before the row that uses it.
- When there are fewer than `min_samples` pairs (default 200), confidence is set to NaN, which the contract treats as uncalibrated. By default the NO TRADE gate refuses NaN confidence.
- Diagnostics: `reliability_table`, `brier_score` and `expected_calibration_error` (10 equal-width bins).

## 2. Net edge (`edge.py`)
`net = |ER| - (fees + spread + slippage + impact + funding + adverse_buffer)`. Every term is a round-trip fraction of notional.
- Fees, half-spread and square-root impact come from `engine.costs.CostModel.trade_cost`, used unchanged (same `config/experiment.yaml` costs and the same stress multiplier). Each is counted twice, once for entry and once for exit.
- Slippage is `slippage_bps` per side times the stress multiplier.
- Funding (perp only) is `direction * funding_rate_per_8h * horizon / 8`. It is floored at 0, so expected funding is never credited.
- `apply_edge` returns direction 0 with `reason="insufficient_edge: ..."` when `net < min_net_edge` or `net <= 0`.

## 3. Combination (`combine.py`)
- Diagnostics: signal correlation, return correlation, drawdown overlap (Jaccard of periods where the drawdown exceeds a threshold) and regime overlap (Jaccard of the regimes where each model's mean OOS return is positive).
- Weights: inverse variance of the OOS forecast error, shrunk toward equal weight (`shrinkage` λ). `regime_weights` gives one weight set per regime and falls back to the unconditional weights when a regime has too few observations.
- Admission (`select_models`) is greedy, in order of standalone OOS Sharpe. A candidate is rejected if its |return corr| or |signal corr| with any admitted model is above `corr_cap`. It is also rejected unless it raises the equal-weight combo Sharpe by more than `min_sharpe_gain` and its alpha t-stat, orthogonal to the combo, is above `min_t`. An exact duplicate model is therefore rejected.
- Disagreement: `sign_dispersion = 1 - |weighted mean sign|`. Confidence is shrunk toward 0.5 in proportion to the dispersion. If dispersion is above `max_disagreement`, the result is NO TRADE.

## 4. NO TRADE (`no_trade.py`)
`evaluate` runs every check and reports all of the ones that fail. The enumerated reasons are: `insufficient_edge`, `excessive_spread`, `poor_liquidity`, `model_disagreement`, `uncertain_regime`, `stale_data`, `risk_limits` (from `engine.live.risk.check_risk(...).halt`), `poor_model_health`, `excessive_correlation` and `insufficient_confidence`. `gate` sets direction 0 and writes the joined reasons into `reason`.

## 5. Risk engine (`risk.py`)
`target_weights(RiskInputs, RiskConfig) -> RiskResult(weights, binding, stats)`. The steps run in this order:
1. Halt from the live risk check: go flat.
2. Drawdown at or above `dd_hard`: go flat. `dd_hard` defaults to `RiskLimits.max_drawdown`, the same level as the live kill switch.
3. Vol targeting: `alpha / vol`, scaled so the portfolio vol (from the covariance) equals `target_vol_annual / sqrt(periods_per_year)`.
4. Per-asset cap `max_asset_weight`.
5. Liquidity cap: `|w| * equity <= max_adv_fraction * ADV`.
6. Correlation-aware concentration: the gross exposure of each cluster (assets with |corr| ≥ `cluster_corr`) is capped at `max_cluster_gross`.
7. Sector and exchange gross caps.
8. Historical-scenario CVaR cap (`cvar_alpha`, `max_cvar`). CVaR is positively homogeneous, so the book is scaled down.
9. Drawdown throttle: scale falls linearly from 1 at `dd_soft` to 0 at `dd_hard`.
10. Net leverage cap (shrinks only the dominant side), then the gross leverage cap. Gross defaults to `RiskLimits.max_gross_leverage`.

Every step after vol targeting can only shrink exposure, so the caps applied earlier still hold at the end. Each step that changed the weights adds an entry to `binding`. `RiskConfig.from_limits(RiskLimits.from_config(live_cfg))` ties the config to `config/live.yaml`.

## 6. Live veto layer (`engine.live.ensemble_hook.apply_ensemble`, OFF by default)
The paper loop does NOT re-size the frozen sleeves with `target_weights` (that would silently be a
different strategy). With `ensemble.enabled: true` in `config/live.yaml` it acts as a veto/multiplier:
- Proposal = Σ sleeve allocation × health `size_multiplier` × sleeve weight (the sleeves' own sizing).
- Calibration from the prediction ledger, per sleeve, causal (resolved rows with expiry ≤ t only):
  `E[r_1h] = β·w`, no intercept, shrunk `β_post = n·β̂/(n + prior_n)`; confidence = hit rate shrunk to
  0.5 the same way. Below `min_samples` (30) the sleeve is uncalibrated → **shadow mode**.
- Horizon: the sleeve's holding horizon (`ensemble.horizon_hours`, trend 168 h, carry 24 h):
  `E[r_h] = β·w·h`.
- Edge is tested on the weight CHANGE (`edge.marginal_edge`): one-way cost of `|Δw|·equity` vs
  `sign(Δw)·E[r_h]`. An unchanged position costs nothing and is never vetoed.
- NO TRADE (`no_trade.gate`, data age measured from the bar CLOSE) on a change ⇒ that asset **holds its
  current weight**; a risk halt ⇒ the whole current book is held; an unreadable `model_health.json` ⇒
  hold. The layer never produces an empty (flatten) target by itself.
- It only runs on versions frozen with a pinned `live_hash` that includes the ensemble block
  (`engine.track.versions`), so enabling it means freezing a new version — never mutating v001/v002.

## Wiring still needed (outside this package)
- (done differently, see section 6) the paper loop logs each NO TRADE `reason` and the calibration into the signal ledger; `target_weights` remains a research tool.
- The research runner should feed matured OOS pairs into the calibrators and `select_models`.
- Optional `config/live.yaml` keys: `ensemble.risk` (the `RiskConfig` fields) and `ensemble.no_trade` (the `NoTradeConfig` fields).
