# Lead-lag engine verdicts (data < H2_START 2025-10-01; H2 sealed, not opened)

Hourly bars are the finest resolution available: lags below 1h (where the literature locates the
BTC->alt effect) cannot be tested. Lags tested: 1, 2, 4, 8, 24h.

Tests: 1505 (pairs x lags x 7 methods), Benjamini-Hochberg at q <= 0.05: 984 rejections.
Tradability: expanding walk-forward, 6-month test folds, lag + beta selected on the training window
only, trade the follower 1h ahead when |forecast| > round-trip cost (engine.costs, fees+half-spread
+impact at $10k).

Verdict rule: EDGE EXISTS = >=1 BH-significant test AND OOS net HAC t > 2 AND >=60% folds net
positive; EDGE DOES NOT SURVIVE = OOS net total <= 0, or no BH significance and t <= 2;
INSUFFICIENT EVIDENCE = < 200 active OOS bars / < 3 folds, or mixed (significant but t <= 2, or t > 2
without BH significance).

Verdict counts: INSUFFICIENT EVIDENCE: 22, EDGE DOES NOT SURVIVE: 20, EDGE EXISTS: 1

## Per-pair verdicts

| pair | group | verdict | bh_sig_tests | n_tests | selected_lags | oos_ic | hit_rate | expectancy_bps | gross_sharpe | net_sharpe | net_hac_t | fold_pos_frac | n_trades | net_bps_by_trend |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC->ETH | BTC->alts | EDGE DOES NOT SURVIVE | 23 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0104 | 0.5235 | -6.7962 | -0.1323 | -1.0213 | -2.1752 | 0.6 | 1895 | bear:-0.88, bull:-0.28, sideways:+0.06 |
| BTC->BNB | BTC->alts | EDGE DOES NOT SURVIVE | 19 | 35 | 1,24,24,24,24,24,24,24,24,24 | -0.002 | 0.5353 | -20.005 | -0.7468 | -1.4196 | -2.8686 | 0.5 | 944 | bear:-1.13, bull:-0.10, sideways:-0.01 |
| BTC->SOL | BTC->alts | EDGE DOES NOT SURVIVE | 27 | 35 | 2,2,24,24,24,24,24,24 | 0.016 | 0.5073 | -1.6347 | 0.358 | -0.5799 | -1.2474 | 0.375 | 1455 | bear:-0.37, bull:-0.15, sideways:-0.04 |
| BTC->XRP | BTC->alts | EDGE DOES NOT SURVIVE | 19 | 35 | 1,1,1,24,24,24,24,24,24,24 | 0.0167 | 0.5171 | -1.0503 | 0.1874 | -0.2147 | -0.4693 | 0.3 | 425 | bear:-0.04, bull:+0.05, sideways:-0.14 |
| BTC->ADA | BTC->alts | EDGE EXISTS | 28 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.039 | 0.5934 | 33.5559 | 2.3089 | 1.4226 | 2.9779 | 0.9 | 674 | bear:+0.53, bull:+0.10, sideways:+0.14 |
| BTC->DOGE | BTC->alts | INSUFFICIENT EVIDENCE | 27 | 35 | 1,1,24,24,24,24,24,24,24 | 0.0254 | 0.5737 | 13.4043 | 1.1753 | 0.4028 | 0.9475 | 0.8889 | 899 | bear:+0.32, bull:-0.01, sideways:+0.04 |
| BTC->AVAX | BTC->alts | EDGE DOES NOT SURVIVE | 22 | 35 | 2,24,24,24,24,24,24,24 | 0.0222 | 0.5424 | 4.2549 | 1.0019 | -0.1686 | -0.3702 | 0.375 | 1550 | bear:-0.03, bull:-0.31, sideways:+0.15 |
| BTC->DOT | BTC->alts | INSUFFICIENT EVIDENCE | 20 | 35 | 2,2,24,24,24,24,24,24,24 | 0.0209 | 0.5612 | 11.4561 | 0.9965 | 0.2145 | 0.4316 | 0.6667 | 516 | bear:+0.08, bull:+0.10, sideways:-0.05 |
| BTC->LINK | BTC->alts | INSUFFICIENT EVIDENCE | 24 | 35 | 2,2,2,2,2,2,2,2,2,2 | 0.0238 | 0.5359 | 10.3918 | 0.5636 | 0.0975 | 0.2162 | 0.4 | 564 | bear:-0.06, bull:+0.04, sideways:+0.06 |
| BTC->LTC | BTC->alts | EDGE DOES NOT SURVIVE | 19 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0124 | 0.5141 | -17.9957 | -0.381 | -0.9307 | -2.0098 | 0.4 | 698 | bear:-0.81, bull:+0.06, sideways:-0.11 |
| BTC->BCH | BTC->alts | EDGE DOES NOT SURVIVE | 21 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0035 | 0.5326 | -6.2782 | 0.0785 | -0.5114 | -0.8817 | 0.5 | 829 | bear:-0.73, bull:+0.10, sideways:+0.02 |
| BTC->TRX | BTC->alts | INSUFFICIENT EVIDENCE | 21 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0073 | 0.4965 | -26.6452 | -0.7013 | -1.3574 | -2.5823 | 0.3 | 270 | bear:-0.44, bull:+0.03, sideways:-0.04 |
| BTC->EOS | BTC->alts | INSUFFICIENT EVIDENCE | 19 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0179 | 0.5 | 49.949 | 0.2716 | 0.1366 | 0.3519 | 0.2 | 24 | bear:+0.02, bull:+0.03, sideways:-0.01 |
| ETH->BNB | ETH->alts | EDGE DOES NOT SURVIVE | 19 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0031 | 0.5174 | -17.772 | -0.7415 | -1.5099 | -2.5502 | 0.5 | 1132 | bear:-1.17, bull:-0.10, sideways:-0.05 |
| ETH->SOL | ETH->alts | EDGE DOES NOT SURVIVE | 24 | 35 | 2,2,24,24,24,24,24,24 | 0.0107 | 0.5135 | -0.6362 | 0.5342 | -0.5922 | -1.2068 | 0.5 | 1989 | bear:-0.42, bull:-0.22, sideways:-0.02 |
| ETH->XRP | ETH->alts | INSUFFICIENT EVIDENCE | 20 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0332 | 0.5879 | 22.5587 | 1.2409 | 0.6637 | 1.5071 | 0.7 | 315 | bear:+0.03, bull:-0.01, sideways:+0.15 |
| ETH->ADA | ETH->alts | INSUFFICIENT EVIDENCE | 24 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0386 | 0.5273 | 15.3683 | 1.5758 | 0.5134 | 0.9854 | 0.6 | 928 | bear:+0.44, bull:-0.13, sideways:+0.07 |
| ETH->DOGE | ETH->alts | EDGE DOES NOT SURVIVE | 27 | 35 | 2,1,1,24,24,1,2,24,24 | 0.0105 | 0.5723 | 2.2817 | 0.4837 | -0.2244 | -0.5171 | 0.5556 | 898 | bear:+0.04, bull:-0.02, sideways:-0.15 |
| ETH->AVAX | ETH->alts | EDGE DOES NOT SURVIVE | 20 | 35 | 24,24,24,24,24,24,24,24 | 0.028 | 0.5105 | 4.1868 | 1.0195 | -0.1927 | -0.4018 | 0.25 | 1516 | bear:-0.05, bull:-0.25, sideways:+0.11 |
| ETH->DOT | ETH->alts | EDGE DOES NOT SURVIVE | 23 | 35 | 24,24,24,24,24,24,24,24,24 | 0.0269 | 0.5385 | 6.1317 | 1.0558 | -0.0785 | -0.1598 | 0.4444 | 900 | bear:+0.15, bull:-0.10, sideways:-0.05 |
| ETH->LINK | ETH->alts | EDGE DOES NOT SURVIVE | 25 | 35 | 2,24,2,24,24,24,24,2,24,24 | 0.0118 | 0.5382 | 6.7367 | 0.4393 | -0.0142 | -0.0359 | 0.3 | 597 | bear:-0.00, bull:-0.13, sideways:+0.10 |
| ETH->LTC | ETH->alts | EDGE DOES NOT SURVIVE | 23 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0119 | 0.5045 | -15.503 | -0.3584 | -1.0186 | -2.1012 | 0.3 | 983 | bear:-1.10, bull:-0.06, sideways:+0.03 |
| ETH->BCH | ETH->alts | INSUFFICIENT EVIDENCE | 22 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0326 | 0.5514 | 11.4431 | 0.8247 | 0.1817 | 0.3983 | 0.7 | 828 | bear:+0.15, bull:-0.09, sideways:+0.11 |
| ETH->TRX | ETH->alts | INSUFFICIENT EVIDENCE | 17 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0043 | 0.4875 | -45.7337 | -0.8353 | -1.1918 | -1.6358 | 0.3 | 294 | bear:-0.76, bull:-0.02, sideways:+0.00 |
| ETH->EOS | ETH->alts | INSUFFICIENT EVIDENCE | 19 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.032 | 0.6 | 57.3597 | 0.6101 | 0.3524 | 0.7566 | 0.4 | 29 | bear:-0.00, bull:+0.00, sideways:+0.04 |
| BTC:perp->spot | perp->spot | INSUFFICIENT EVIDENCE | 20 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0096 | 0.5854 | 13.4519 | 0.4444 | -0.0012 | -0.0028 | 0.1 | 81 | bear:-0.10, bull:+0.08, sideways:-0.00 |
| BTC:spot->perp | spot->perp | EDGE DOES NOT SURVIVE | 22 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0076 | 0.5509 | -1.4224 | 0.3051 | -0.4737 | -1.042 | 0.5 | 1043 | bear:-0.43, bull:+0.02, sideways:+0.05 |
| ETH:perp->spot | perp->spot | INSUFFICIENT EVIDENCE | 23 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0056 | 0.5327 | -17.32 | -0.0791 | -0.5051 | -0.8786 | 0.4 | 193 | bear:-0.37, bull:+0.03, sideways:+0.03 |
| ETH:spot->perp | spot->perp | INSUFFICIENT EVIDENCE | 25 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0331 | 0.5445 | 7.4234 | 1.1806 | 0.2492 | 0.5423 | 0.6 | 1755 | bear:+0.51, bull:-0.24, sideways:+0.03 |
| BNB:perp->spot | perp->spot | INSUFFICIENT EVIDENCE | 21 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0205 | 0.5824 | -17.7988 | 0.0168 | -0.4058 | -1.0667 | 0.3 | 165 | bear:-0.29, bull:+0.02, sideways:-0.02 |
| BNB:spot->perp | spot->perp | EDGE DOES NOT SURVIVE | 24 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0009 | 0.5411 | -5.1548 | 0.1114 | -0.9671 | -2.1516 | 0.5 | 1891 | bear:-1.15, bull:+0.04, sideways:+0.02 |
| SOL:perp->spot | perp->spot | INSUFFICIENT EVIDENCE | 25 | 35 | 24,1,24,24,24,24,24,24,24 | 0.0129 | 0.375 | -145.4166 | -0.2166 | -0.2881 | -0.5654 | 0.1111 | 16 | bear:-0.14, bull:+0.00, sideways:-0.00 |
| SOL:spot->perp | spot->perp | EDGE DOES NOT SURVIVE | 27 | 35 | 2,24,24,24,24,24,24,24 | 0.0103 | 0.5141 | -13.0446 | -0.223 | -0.5987 | -1.2171 | 0.25 | 507 | bear:-0.47, bull:-0.09, sideways:+0.01 |
| XRP:perp->spot | perp->spot | INSUFFICIENT EVIDENCE | 23 | 35 | 1,1,1,1,24,1,24,24,24,24 | 0.0234 | 0.5833 | 88.2901 | 0.5673 | 0.3727 | 0.9501 | 0.3 | 85 | bear:-0.03, bull:+0.22, sideways:+0.03 |
| XRP:spot->perp | spot->perp | INSUFFICIENT EVIDENCE | 25 | 35 | 1,1,1,1,24,24,24,24,24,24 | 0.0214 | 0.5489 | 10.292 | 0.6564 | 0.135 | 0.319 | 0.6 | 906 | bear:-0.57, bull:+0.46, sideways:+0.11 |
| DOGE:perp->spot | perp->spot | EDGE DOES NOT SURVIVE | 30 | 35 | 1,24,24,24,24,24,24,24,24,24 | 0.0273 | 0.5481 | 4.6408 | 0.5097 | -0.2575 | -0.7617 | 0.4 | 854 | bear:-0.16, bull:-0.16, sideways:-0.18 |
| DOGE:spot->perp | spot->perp | EDGE DOES NOT SURVIVE | 27 | 35 | 24,24,24,24,24,24,24,24,24 | 0.0351 | 0.5228 | 4.2241 | 1.9931 | -0.2087 | -0.3896 | 0.1111 | 5084 | bear:+0.40, bull:-0.33, sideways:-0.23 |
| LARGE5->ZEC | basket->smallcap | INSUFFICIENT EVIDENCE | 25 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0301 | 0.5556 | 23.988 | 0.5868 | 0.2244 | 0.4877 | 0.4 | 67 | bear:+0.02, bull:+0.01, sideways:+0.01 |
| LARGE5->XTZ | basket->smallcap | INSUFFICIENT EVIDENCE | 26 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0379 | 0.5888 | 20.1496 | 1.1016 | 0.3673 | 0.7359 | 0.4 | 344 | bear:+0.11, bull:+0.02, sideways:+0.04 |
| LARGE5->IOTA | basket->smallcap | INSUFFICIENT EVIDENCE | 23 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0371 | 0.5783 | 28.005 | 1.0003 | 0.378 | 0.7106 | 0.6 | 148 | bear:+0.05, bull:+0.01, sideways:+0.04 |
| LARGE5->VET | basket->smallcap | EDGE DOES NOT SURVIVE | 23 | 35 | 24,24,24,24,24,24,24,24,24,24 | 0.0423 | 0.5476 | 8.9958 | 0.9117 | -0.0425 | -0.08 | 0.4 | 612 | bear:+0.07, bull:-0.00, sideways:-0.06 |
| LARGE5->THETA | basket->smallcap | INSUFFICIENT EVIDENCE | 23 | 35 | 24,24,24,24,24,24,24,24,24 | 0.0353 | 0.5879 | 29.0995 | 1.3706 | 0.6368 | 1.1083 | 0.6667 | 294 | bear:+0.21, bull:+0.01, sideways:+0.05 |
| LARGE5->ALGO | basket->smallcap | INSUFFICIENT EVIDENCE | 20 | 35 | 24,24,24,24,24,24,24,24,24 | 0.0348 | 0.5309 | 10.8436 | 0.9567 | 0.0631 | 0.1213 | 0.4444 | 427 | bear:-0.16, bull:-0.00, sideways:+0.13 |

## BH rejections by method

| method | sum | count |
|---|---|---|
| granger | 156 | 215 |
| mutual_info | 215 | 215 |
| ols_hac | 94 | 215 |
| rolling_stability | 56 | 215 |
| transfer_entropy | 214 | 215 |
| var_irf | 94 | 215 |
| xcorr | 155 | 215 |

## BH rejections by lag

| lag_h | sum | count |
|---|---|---|
| 1 | 191 | 301 |
| 2 | 215 | 301 |
| 4 | 142 | 301 |
| 8 | 160 | 301 |
| 24 | 276 | 301 |

## Decay by lag (median across pairs, OOS, no lag selection)

| lag_h | oos_ic | oos_gross_bps_per_bar | oos_net_bps_per_bar |
|---|---|---|---|
| 1 | 0.0079 | 0.0169 | -0.0792 |
| 2 | 0.0142 | 0.0343 | 0.0106 |
| 4 | -0.0047 | 0.0 | 0.0 |
| 8 | -0.0064 | -0.0045 | -0.0066 |
| 24 | 0.0305 | 0.141 | 0.033 |
