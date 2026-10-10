# Regime summary (data < H2_START = 2025-10-01, sealed holdout untouched)

Bars: 50400 hourly, 2020-01-01 00:00:00+00:00 -> 2025-09-30 23:00:00+00:00.
Universe: BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK, LTC, BCH, TRX.
All labels causal (row t uses bars <= t); thresholds are expanding quantiles of past values;
HMM = 2-state Gaussian on daily BTC log returns, monthly expanding refits,
FILTERED (forward-only) probabilities;
CUSUM on daily variance. Daily labels apply from the next UTC day.

Next-bar BTC return by state is descriptive (ex-post) and NOT a trading result.

## trend

Coverage: 95.7% of bars labelled.

| trend | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| bear | 0.2289 | -0.4426 | 75.8459 |
| bull | 0.3719 | 0.9381 | 64.9015 |
| sideways | 0.3992 | 0.876 | 56.3716 |

Transition matrix (hourly, row = from):

| from | bear | bull | sideways | share | mean_spell_bars |
|---|---|---|---|---|---|
| bear | 0.9871 | 0.0 | 0.0129 | 0.2289 | 77.7676 |
| bull | 0.0 | 0.9879 | 0.0121 | 0.3719 | 82.6728 |
| sideways | 0.0073 | 0.0113 | 0.9814 | 0.3992 | 53.6435 |

## vol

Coverage: 95.5% of bars labelled.

| vol | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| high | 0.3575 | 1.1036 | 85.6256 |
| low | 0.6425 | 0.2917 | 48.681 |

Transition matrix (hourly, row = from):

| from | high | low | share | mean_spell_bars |
|---|---|---|---|---|
| high | 0.9927 | 0.0073 | 0.3575 | 136.6429 |
| low | 0.004 | 0.996 | 0.6425 | 245.5476 |

## funding

Coverage: 100.0% of bars labelled.

| funding | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| high | 0.1089 | 0.0345 | 82.6417 |
| negative | 0.1368 | 2.5815 | 86.9059 |
| neutral | 0.7543 | 0.2545 | 61.4146 |

Transition matrix (hourly, row = from):

| from | high | negative | neutral | share | mean_spell_bars |
|---|---|---|---|---|---|
| high | 0.9738 | 0.0 | 0.0262 | 0.1089 | 38.1111 |
| negative | 0.0001 | 0.9437 | 0.0561 | 0.1368 | 17.7655 |
| neutral | 0.0038 | 0.0102 | 0.9861 | 0.7543 | 71.5989 |

## correlation

Coverage: 95.0% of bars labelled.

| correlation | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| breakdown | 0.0003 | -4.7457 | 129.0179 |
| high | 0.2281 | 0.3808 | 75.0828 |
| low | 0.3556 | 1.3914 | 63.4462 |
| mid | 0.4159 | 0.0187 | 58.476 |

Transition matrix (hourly, row = from):

| from | breakdown | high | low | mid | share | mean_spell_bars |
|---|---|---|---|---|---|---|
| breakdown | 0.7333 | 0.0 | 0.2 | 0.0667 | 0.0003 | 3.75 |
| high | 0.0 | 0.9922 | 0.0 | 0.0078 | 0.2281 | 128.5059 |
| low | 0.0002 | 0.0 | 0.9956 | 0.0042 | 0.3556 | 224.0395 |
| mid | 0.0001 | 0.0043 | 0.0037 | 0.992 | 0.4159 | 125.2516 |

## leadership

Coverage: 99.3% of bars labelled.

| leadership | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| alt_led | 0.4393 | 0.0665 | 64.4267 |
| btc_led | 0.5607 | 0.8622 | 70.7172 |

Transition matrix (hourly, row = from):

| from | alt_led | btc_led | share | mean_spell_bars |
|---|---|---|---|---|
| alt_led | 0.9846 | 0.0154 | 0.4393 | 64.8496 |
| btc_led | 0.012 | 0.988 | 0.5607 | 82.7611 |

## panic

Coverage: 99.2% of bars labelled.

| panic | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| normal | 0.9788 | 0.5184 | 63.8828 |
| panic | 0.0212 | 0.3331 | 173.0956 |

Transition matrix (hourly, row = from):

| from | normal | panic | share | mean_spell_bars |
|---|---|---|---|---|
| normal | 0.9987 | 0.0013 | 0.9788 | 741.7576 |
| panic | 0.0613 | 0.9387 | 0.0212 | 16.3077 |

## hmm_state

Coverage: 82.5% of bars labelled.

| hmm_state | share | next_1h_btc_mean_bps | next_1h_btc_vol_bps |
|---|---|---|---|
| high_vol | 0.1114 | 0.776 | 92.9633 |
| low_vol | 0.8886 | 0.2711 | 60.4145 |

Transition matrix (hourly, row = from):

| from | high_vol | low_vol | share | mean_spell_bars |
|---|---|---|---|---|
| high_vol | 0.9674 | 0.0326 | 0.1114 | 30.6755 |
| low_vol | 0.0041 | 0.9959 | 0.8886 | 243.1579 |

## CUSUM change points

Vol-up alarms: 30, vol-down alarms: 50 over 2098 days.

Dates (vol-up): 2020-03-09, 2020-03-13, 2021-01-14, 2021-01-22, 2021-02-09, 2021-05-13, 2021-05-20, 2021-05-22, 2021-05-25, 2021-06-22, 2021-09-08, 2022-01-22, 2022-02-05, 2022-03-01, 2022-05-10, 2022-06-14, 2022-06-20, 2022-08-20, 2022-09-14, 2022-11-09, 2022-11-10, 2023-03-14, 2023-10-24, 2024-02-29, 2024-03-06, 2024-03-21, 2024-08-09, 2024-11-12, 2025-03-03, 2025-03-04
