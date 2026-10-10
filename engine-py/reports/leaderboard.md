# MODEL_LEADERBOARD

Ranked by composite = mean percentile rank over: oos_sharpe, live_sharpe, max_dd, expectancy, calibration_ece, cost_robustness, regime_robustness, param_stability, health_score. Return is NOT a ranking criterion. Missing values count as neutral (0.5).

| rank | model_id | status | health | composite | oos_sharpe | live_sharpe | live_return | max_dd | expectancy | calibration_ece | cost_robustness | regime_robustness | param_stability | health_score | n_live | exp_id | hypothesis_id | decision |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | sleeve.trend | RESEARCH | RESEARCH | 0.593 | - | 1.942 | 0.017 | -0.177 | 0.000 | - | - | - | - | 24.580 | 160.000 |  |  |  |
| 2 | v002/sleeve.trend | REDUCED | REDUCED | 0.593 | - | - | 0.000 | -0.000 | 0.000 | - | - | - | - | 37.500 | 72.000 |  |  |  |
| 3 | xs_mom|H-0002 | WATCH | UNTRACKED | 0.556 | 0.917 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000015 | H-0002 | WATCH |
| 4 | vol_managed_tsmom|H-0004 | REJECT | UNTRACKED | 0.548 | 0.570 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000005 | H-0004 | REJECT |
| 5 | residual_mom|H-0002 | INCONCLUSIVE | UNTRACKED | 0.540 | 0.467 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000016 | H-0002 | INCONCLUSIVE |
| 6 | v001/sleeve.trend | ACTIVE | ACTIVE | 0.537 | - | - | 0.000 | -0.000 | 0.000 | - | - | - | - | - | 26.000 |  |  |  |
| 7 | voladj_reversal|H-0013 | REJECT | UNTRACKED | 0.532 | 0.264 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000022 | H-0013 | REJECT |
| 8 | basis_reversion|H-0010 | REJECT | UNTRACKED | 0.524 | 0.164 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000018 | H-0010 | REJECT |
| 9 | zscore_reversal|H-0011 | REJECT | UNTRACKED | 0.516 | 0.074 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000020 | H-0011 | REJECT |
| 10 | funding_reversion|H-0008 | REJECT | UNTRACKED | 0.508 | 0.027 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000017 | H-0008 | REJECT |
| 11 | tsmom|H-0001 | REJECT | UNTRACKED | 0.500 | -0.160 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000013 | H-0001 | REJECT |
| 12 | donchian|H-0001 | REJECT | UNTRACKED | 0.492 | -0.234 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000014 | H-0001 | REJECT |
| 13 | leadlag_engine:BTC->ADA|H-0014 | REJECT | UNTRACKED | 0.484 | -0.310 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000025 | H-0014 | REJECT |
| 14 | logit_sign|H-0020 | REJECT | UNTRACKED | 0.476 | -0.696 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000024 | H-0020 | REJECT |
| 15 | ridge|H-0020 | REJECT | UNTRACKED | 0.468 | -0.745 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000023 | H-0020 | REJECT |
| 16 | ar|H-0011 | REJECT | UNTRACKED | 0.460 | -1.326 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000021 | H-0011 | REJECT |
| 17 | st_reversal|H-0011 | REJECT | UNTRACKED | 0.452 | -3.956 | - | - | - | - | - | - | - | - | - | 0.000 | EXP-000019 | H-0011 | REJECT |
