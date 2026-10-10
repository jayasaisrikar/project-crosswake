# engine.models — Phase 4 signal library

Every model implements `engine.research.contract.SignalModel`:

* `fit(data, end)` — uses `data.truncate(end)` only. Forward targets are computed on the truncated data, so a
  pair (score_t, fwd_ret_{t,t+h}) is used only if `t + h <= end`. Pooled across assets, sampled every
  `fit_stride` bars (default `min(h, 24)`), targets winsorised at 0.5 % / 99.5 %.
* Calibration: pooled OLS `fwd_ret = a + b * score`. Since 2026-10-10 (review 01 #1),
  `expected_return = b * score_t` is the forecast in excess of the training drift `a`. For cross-sectional
  models (`xs = True`, or `cross_sectional: true` on the pooled L2 models) it is also demeaned across the
  assets predicted at t, so the sign book is dollar-neutral. The intercept never sets direction:
  `features["calib_a"]` and `features["er_with_drift"] = a + b*s` keep the raw values. Linear and AR scores
  exclude their own fitted intercept, and the logit score is `P - P(base rate)`. `uncertainty` is the
  residual stdev of the fit.
* Cross-sectional models need >= 3 assets (`DataUnavailable` at fit). With a `pit_mask` attached, they rank
  only over the PIT universe members at t (review 01 #5, #9).
* `predict_many(data, times)` computes the score, tradable mask and vol panels once and reads the rows.
  It must equal `predict(truncate(data, t), t)`; the runner checks this. The stale mask is vectorised
  (`stale_run_length_fast`) (review 01 #6).
* `predict(data, t)` recomputes the score on `[t - warmup_hours, t]` only. `direction = sign(expected_return)`,
  or 0 (NO TRADE, with a reason) if `|expected_return| <= min_abs_return`. `confidence = NaN` (another
  module calibrates it). `risk = trailing hourly vol (vol_hours, stale bars excluded) * sqrt(h)`.
  Assets that are not tradable at t (NaN close, or stale for more than 24 bars) are skipped.
* Common params: `horizon_hours` (24), `market` (`perp`), `vol_hours` (720), `min_abs_return` (0),
  `fit_stride` (0 = auto), `winsor` (0.005).

Registry: `engine.models.REGISTRY[model_id]` gives a `ModelSpec` (factory, defaults, grid). `build_model(id, **kw)`
builds a model and `param_grid(id)` returns the perturbation grid merged over the defaults.
Research hypothesis IDs are still to be assigned; the **Family** column is the link key for now.

Notation: `P` = perp close, `r` = hourly simple return (NaN on synthesized bars), `sigma_h` = trailing hourly
stdev over `vol_hours`, `L` = lookback in hours, `rank_xs` = cross-sectional percentile rank, demeaned to
[-0.5, 0.5] (NaN if fewer than 3 assets).

## BASELINE_V0 adapters (`baseline.py`) — existing `engine.signals` logic, unchanged

| model_id | Family | Score | Default params | Grid |
|---|---|---|---|---|
| baseline_trend | BASELINE_V0 | TrendStrategy perp weight, held between rebalances | config `trend` block | lookbacks_days |
| baseline_breakout | BASELINE_V0 | BreakoutStrategy perp weight | config `breakout` block | lookbacks_days |
| baseline_xsmom | BASELINE_V0 | XSMomStrategy perp weight | config `xsmom` block | formation_days, skip_days |
| baseline_carry | BASELINE_V0 | CarryStrategy spot weight | config `carry` block | entry_funding_annual, funding_lookback_hours |

For `baseline_carry`, the target is the hedged trade: `spot_ret - perp_ret + funding received over (t, t+h]`.
`warmup_days` (150 / 150 / 75 / 30) sets the predict window. Path-dependent state (carry hysteresis, breakout
channel state) restarts at the window start, so values can differ slightly from a full-history run. Predictions
stay causal.

## Level 1 rule families (`rules.py`)

| model_id | Family | Score formula | Defaults | Grid |
|---|---|---|---|---|
| tsmom | TS_MOMENTUM | mean_L log(P_t/P_{t-L}) / (sigma_h sqrt(L)) | lookbacks 7/30/90 d | lookbacks, horizon 24/72 |
| trend_accel | TREND_ACCELERATION | [r(t-L,t) - r(t-2L,t-L)] / (sigma_h sqrt(L)) | window 7 d | 3/7/14 d |
| donchian | DONCHIAN_BREAKOUT | mean_L 2(P - mid_L)/(hi_L - lo_L), in [-1, 1] | 20/55 d | 10/20, 20/55, 55/100 |
| xs_mom | XS_MOMENTUM | rank_xs log(P_{t-skip}/P_{t-skip-F}) | F 30 d, skip 1 d | F 14/30/60, skip 0/1 |
| residual_mom | RESIDUAL_MOMENTUM | rank_xs sum_F (r_i - beta_i r_BTC); beta = rolling cov/var over beta_days | F 30 d, beta 60 d | F, beta_days |
| st_reversal | SHORT_TERM_REVERSAL | -rank_xs log(P_t/P_{t-L}) | L 24 h | L 4/24/72, h 4/24 |
| zscore_reversal | ZSCORE_REVERSAL | -(log P - mean_N)/std_N | N 72 h | 24/72/168 |
| voladj_reversal | VOL_ADJUSTED_REVERSAL | -r(t-L,t)/(sigma_s sqrt(L)) * clip(sigma_s/sigma_l, 0, 3) | L 24 h, short vol 72 h | L, short vol |
| funding_reversion | FUNDING_EXTREME_REVERSION | -z * 1{\|z\|>thr}, z = z-score (30 d) of the trailing funding APR | APR 72 h, thr 1.5 | APR hours, thr |
| funding_accel | FUNDING_ACCELERATION | (APR_24h - APR_168h) / std_30d | 24 h / 168 h | short, long |
| basis_reversion | BASIS_REVERSION | z-score of (P_spot/P_perp - 1) over 168 h; \|basis\| > 2 % dropped | z 168 h | 72/168/336 |
| vol_regime | VOLATILITY_EXPANSION_CONTRACTION | sign(mom_7d) * (sigma_HAR / sigma_m - 1) | mom 7 d | 3/7/14 d |
| vol_managed_tsmom | VOL_MANAGED_SCALING | mean_L sign(mom_L) * clip(target_daily_vol / sigma_HAR, 0, max_scale) | 7/30 d, 3 %, 2.0 | target vol, max_scale |

HAR-RV (Corsi 2009), used by vol_regime and vol_managed_tsmom: `RV_{t+1d} = c + b_d RV_d + b_w RV_w + b_m RV_m`,
where RV_d is the 24 h sum of r², RV_w is the 7 d daily mean and RV_m is the 30 d daily mean. It is fit as a pooled
OLS inside `fit`, on training data only, sampled daily. If there are fewer than 30 rows, it falls back to RV_m
persistence. `sigma_HAR = sqrt(max(forecast, 1e-10))`.

Funding is binned to the hourly bar at or after each event (ceil). An event stamped 08:00:00.003 therefore counts
from the 09:00 bar on, so a bar never sees a later event. `APR_L` is the sum of events in (t-L, t] times 8760/L.

## Level 2 statistical (`statistical.py`, numpy only)

Features (vol-normalised and causal): `log(P_t/P_{t-k}) / (sigma_h sqrt(k))` for k in `lags_hours`
(1/4/24/72/168), the funding-APR z-score (72 h APR, 30 d z) and the basis z-score (168 h). Missing funding and
basis values are filled with 0. Features are standardised with the train mean and std. Coefficients come from the
training window only.

| model_id | Family | Model | Defaults | Grid |
|---|---|---|---|---|
| ridge | STAT_RIDGE | linear fwd return on features, L2 (intercept unpenalised) | ridge 10 | ridge 1/10/100, h 4/24 |
| ols | STAT_OLS | same as ridge, with no penalty | — | h 4/24 |
| logit_sign | STAT_LOGISTIC | P(fwd>0) = sigmoid(w·z), IRLS + L2; score = P - 0.5, mapped to a return by the calibration | ridge 1 | ridge 0.1/1/10, h 4/24 |
| ar | STAT_AR | pooled AR(p) on non-overlapping h-hour log returns | p 3 | p 1/3/5, h 4/24 |

sklearn and lightgbm are not needed: the linear, logistic (IRLS) and AR fits are written in numpy. A tree or
boosting model would need a new dependency and is not included.

## Unavailable families (`stubs.py`)

| model_id | Family | Needs |
|---|---|---|
| oi_divergence | OPEN_INTEREST | historical open interest |
| liquidation_cascade | LIQUIDATIONS | liquidation events |
| orderbook_imbalance | ORDER_BOOK | L2 order book snapshots |

`fit` and `predict` raise `DataUnavailable`. No data is fabricated.

## Tests (`tests/test_models.py`)

For every live model, the tests check:

* `predict(data, t) == predict(data.truncate(t), t)`, with full record equality.
* `score_panel(data).loc[t] == score_panel(data.truncate(t)).loc[t]`.
* The fit is invariant to scrambling every price and funding value after `end`.
* The Prediction schema is valid: finite expected_return, direction matches its sign, NaN confidence, risk > 0,
  and the expiry is correct.

They also check registry and grid completeness, that the stubs raise, that residual_mom without BTC raises,
that predicting before fit raises, and that a planted momentum signal gives a positive calibrated slope.

No performance evaluation was run on any data, and nothing on or after the 2025-10-01 H2 holdout was touched.
