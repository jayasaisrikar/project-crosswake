# Research batch_002 — results

Plan: `reports/research/batch_002/plan.yaml` (created 2026-10-10T11:42:02.803067+00:00, spec_sha 1f4a0abe0d159b19). Data 2020-01-01 .. < H2_START 2025-10-01 (H2 sealed, not opened). Rules: config/promotion_rules_v2.yaml (pre-registered 2026-10-10 after batch_001 invalidation). Runtime 20.2 min.

No parameter was changed after results were seen; no reruns. batch_001 is invalidated (reports/research/batch_001/INVALIDATED.md) but its trials still count.

## Experiments

| EXP | hypothesis | model | universe | OOS net Sharpe | buy&hold Sharpe | alpha ann | alpha p | 2x-cost Sharpe | DSR | PBO | distinct variants | stability | HAC p | BH q | Holm p | decision | reason | runtime s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EXP-000013 | H-0001 | tsmom | majors | -0.16 | 0.76 | -0.140 | 0.6944 | -0.22 | 0.010 | 0.39 | 5.00 | 0.25 | 0.7009 | 0.9112 | 1.0000 | REJECT | OOS net Sharpe -0.160 <= 0; Sharpe at 2.0x costs -0.215 <= 0 | 5 |
| EXP-000014 | H-0001 | donchian | majors | -0.23 | 0.76 | -0.207 | 0.7849 | -0.28 | 0.007 | 0.36 | 5.00 | 0.50 | 0.5559 | 0.8029 | 1.0000 | REJECT | OOS net Sharpe -0.234 <= 0; Sharpe at 2.0x costs -0.283 <= 0 | 4 |
| EXP-000015 | H-0002 | xs_mom | pit_top_n | 0.92 | 0.47 | 0.270 | 0.0076 | 0.85 | 0.528 | 0.04 | 5.00 | 0.50 | 0.0273 | 0.1185 | 0.3008 | WATCH | failed: dsr; failed: perturbation | 50 |
| EXP-000016 | H-0002 | residual_mom | pit_top_n | 0.47 | 0.47 | 0.130 | 0.1391 | 0.39 | 0.223 | 0.36 | 5.00 | 0.75 | 0.3016 | 0.6534 | 1.0000 | INCONCLUSIVE | failed: alpha_vs_benchmark; failed: dsr; failed: hac_p; failed: oos_sharpe; failed: pbo | 65 |
| EXP-000017 | H-0008 | funding_reversion | pit_top_n | 0.03 | 0.47 | -0.029 | 0.5907 | -0.06 | 0.020 | 0.81 | 5.00 | 0.50 | 0.9438 | 0.9438 | 1.0000 | REJECT | Sharpe at 2.0x costs -0.057 <= 0; PBO 0.81 > 0.5 | 46 |
| EXP-000018 | H-0010 | basis_reversion | pit_top_n | 0.16 | 0.47 | 0.028 | 0.4502 | -0.20 | 0.044 | 0.49 | 5.00 | 0.25 | 0.7769 | 0.9182 | 1.0000 | REJECT | Sharpe at 2.0x costs -0.202 <= 0 | 61 |
| EXP-000019 | H-0011 | st_reversal | pit_top_n | -3.96 | 0.47 | -1.186 | 1.0000 | -8.78 | 0.000 | 0.02 | 5.00 | 0.00 | 0.0000 | 0.0000 | 0.0000 | REJECT | OOS net Sharpe -3.956 <= 0; Sharpe at 2.0x costs -8.780 <= 0 | 98 |
| EXP-000020 | H-0011 | zscore_reversal | majors | 0.07 | 0.76 | 0.069 | 0.3960 | -0.36 | 0.000 | 0.15 | 5.00 | 0.50 | 0.8918 | 0.9438 | 1.0000 | REJECT | Sharpe at 2.0x costs -0.356 <= 0 | 29 |
| EXP-000021 | H-0011 | ar | majors | -1.33 | 0.76 | -0.850 | 0.9997 | -3.23 | 0.000 | 0.10 | 5.00 | 0.00 | 0.0007 | 0.0044 | 0.0082 | REJECT | OOS net Sharpe -1.326 <= 0; Sharpe at 2.0x costs -3.230 <= 0 | 20 |
| EXP-000022 | H-0013 | voladj_reversal | pit_top_n | 0.26 | 0.47 | 0.108 | 0.3561 | -0.08 | 0.000 | 0.69 | 5.00 | 0.75 | 0.5374 | 0.8029 | 1.0000 | REJECT | Sharpe at 2.0x costs -0.082 <= 0; PBO 0.69 > 0.5 | 139 |
| EXP-000023 | H-0020 | ridge | pit_top_n | -0.74 | 0.47 | -0.255 | 0.9721 | -1.48 | 0.000 | 0.14 | 5.00 | 0.25 | 0.0655 | 0.2130 | 0.6555 | REJECT | OOS net Sharpe -0.745 <= 0; Sharpe at 2.0x costs -1.479 <= 0 | 411 |
| EXP-000024 | H-0020 | logit_sign | pit_top_n | -0.70 | 0.47 | -0.256 | 0.9771 | -1.40 | 0.000 | 0.06 | 5.00 | 0.25 | 0.0912 | 0.2371 | 0.8208 | REJECT | OOS net Sharpe -0.696 <= 0; Sharpe at 2.0x costs -1.401 <= 0 | 200 |
| EXP-000025 | H-0014 | leadlag_engine:BTC->ADA | BTC->ADA | -0.31 | 0.66 | -0.042 | 0.7758 | -0.86 | 0.000 | 0.48 | 5.00 | 0.40 | 0.5004 | 0.8029 | 1.0000 | REJECT | OOS net Sharpe -0.310 <= 0; Sharpe at 2.0x costs -0.862 <= 0 | - |

## Decision counts

- REJECT: 11
- WATCH: 1
- INCONCLUSIVE: 1

## Multiple testing across the batch (13 trials)

Benjamini-Hochberg at q <= 0.05 over each trial's daily HAC p-value (NaN -> 1): 2 rejection(s). Holm (FWER) rejections: 2.

### Total trial count (disclosure)

- Registry records after this batch (all batches, crashes included): 25 (batch_001: 12, batch_002: 13)
- Parameter neighbours evaluated in batch_002: 48
- Lead-lag pairs re-tested in batch_002: 43
- Total trials tried: **116** (this N, not the batch size, deflates DSR)

## Lead-lag BTC->ADA with one bar of execution delay

- Pairs re-run with unchanged engine code, re-priced with +1 bar latency: 43
- BTC->ADA hourly net HAC p = 0.4291, BH q (pairs) = 0.6590, Holm p = 1.0000
- Pairs BH-significant (q <= 0.05): 1 (DOGE:spot->perp)
- Net total: zero-latency 0.9339 vs delayed -0.1902; leakage (truncation re-run) pass
- Pre-registered decision: **REJECT** — OOS net Sharpe -0.310 <= 0; Sharpe at 2.0x costs -0.862 <= 0
- Full table: `reports/research/batch_002/leadlag_pairs_delayed.csv`

## Unmapped testable hypotheses (not run, not registered)

- H-0003: no conditional panic-state scaling model in engine.models
- H-0004: vol_managed_tsmom only rescales |score|; in the pre-registered sign mode the scale is discarded, so the runner cannot test exposure scaling (batch_001 EXP-000005 measured trend sign only)
- H-0005: volatility-forecast QLIKE comparison, not a trading signal (runner measures PnL)
- H-0006: same model as H-0004 (HAR sizing); not testable in sign mode for the same reason
- H-0007: delta-neutral carry needs spot+perp legs; runner is single-leg
- H-0009: no cross-sectional funding-carry SignalModel in engine.models (funding PnL now exists)
- H-0012: conditional abnormal-move model not implemented
- H-0015: regime-conditional lead-lag model not implemented
- H-0016: perp->spot lead-lag model not implemented (lead-lag engine verdict: no edge)
- H-0017: transfer-entropy model not implemented
- H-0018: HMM-conditioned trend model not implemented
- H-0019: BOCPD exposure overlay not implemented
- H-0021: intraday time-of-day model not implemented
- H-0022: long-horizon reversal model not implemented; history too short for 1y lookbacks
- H-0023: meta-hypothesis: answered by this batch's DSR/PBO/BH outputs, not a separate model
- H-0030: funding sign-flip event model not implemented

## Verdicts

- H-0001 / tsmom (EXP-000013): **REJECT**
- H-0001 / donchian (EXP-000014): **REJECT**
- H-0002 / xs_mom (EXP-000015): **WATCH**
- H-0002 / residual_mom (EXP-000016): **INCONCLUSIVE**
- H-0008 / funding_reversion (EXP-000017): **REJECT**
- H-0010 / basis_reversion (EXP-000018): **REJECT**
- H-0011 / st_reversal (EXP-000019): **REJECT**
- H-0011 / zscore_reversal (EXP-000020): **REJECT**
- H-0011 / ar (EXP-000021): **REJECT**
- H-0013 / voladj_reversal (EXP-000022): **REJECT**
- H-0020 / ridge (EXP-000023): **REJECT**
- H-0020 / logit_sign (EXP-000024): **REJECT**
- H-0014 / leadlag_engine:BTC->ADA (EXP-000025): **REJECT**

PROMOTE/WATCH (stats vs buy-and-hold): EXP-000015 xs_mom WATCH Sharpe 0.92 vs B&H 0.47, alpha 0.270/yr p=0.0076, BH q=0.1185

## Caveats (declared in plan)

- square-root impact not applied (runner)
- position_mode=sign for every model (model-side scaling not used)
- dataset columns = union of PIT members ever; ranks and predictions are PIT at t

## Run log

```
run started 2026-10-10T12:10:56.718914+00:00
data loaded in 30s; PIT union members=124: ['1000BONK', '1000FLOKI', '1000PEPE', '1000RATS', '1000SATS', '1000SHIB', 'AAVE', 'ADA', 'ALGO', 'ALICE', 'ALPACA', 'APE', 'APT', 'ARB', 'ARK', 'ARPA', 'ATOM', 'AUCTION', 'AVAX', 'AXS', 'BAND', 'BCH', 'BEL', 'BIGTIME', 'BIO', 'BLUR', 'BLZ', 'BNB', 'BNT', 'BNX', 'BOME', 'BTC', 'CFX', 'CHZ', 'COMP', 'CRV', 'CTSI', 'DASH', 'DOGE', 'DOT', 'DYDX', 'ENA', 'ENJ', 'EOS', 'ETC', 'ETH', 'FARTCOIN', 'FET', 'FIL', 'FLM', 'FTM', 'FUN', 'GALA', 'GMT', 'HBAR', 'HIGH', 'ICP', 'INJ', 'IOST', 'JASMY', 'KNC', 'LEND', 'LINA', 'LINK', 'LPT', 'LRC', 'LTC', 'LUNA', 'MANA', 'MASK', 'MATIC', 'MKR', 'MOODENG', 'MTL', 'MYX', 'NEAR', 'NEIRO', 'NEO', 'NOT', 'OM', 'OMG', 'OP', 'ORDI', 'PENGU', 'PEOPLE', 'PERP', 'PNUT', 'POPCAT', 'PUMP', 'REEF', 'RNDR', 'RUNE', 'RVN', 'SAND', 'SEI', 'SOL', 'STORJ', 'SUI', 'SUSHI', 'SXP', 'THETA', 'TIA', 'TOMO', 'TON', 'TRB', 'TRUMP', 'TRX', 'TURBO', 'UNFI', 'UNI', 'UXLINK', 'VET', 'VIRTUAL', 'WAVES', 'WIF', 'WLD', 'XLM', 'XMR', 'XRP', 'XTZ', 'YFI', 'YFII', 'ZEC', 'ZIL']
EXP-000013 H-0001/tsmom: REJECT (4.7s)
EXP-000014 H-0001/donchian: REJECT (3.9s)
EXP-000015 H-0002/xs_mom: WATCH (49.7s)
EXP-000016 H-0002/residual_mom: INCONCLUSIVE (65.0s)
EXP-000017 H-0008/funding_reversion: REJECT (46.0s)
EXP-000018 H-0010/basis_reversion: REJECT (61.0s)
EXP-000019 H-0011/st_reversal: REJECT (98.2s)
EXP-000020 H-0011/zscore_reversal: REJECT (29.1s)
EXP-000021 H-0011/ar: REJECT (20.5s)
EXP-000022 H-0013/voladj_reversal: REJECT (138.8s)
EXP-000023 H-0020/ridge: REJECT (411.4s)
EXP-000024 H-0020/logit_sign: REJECT (199.7s)
EXP-000025 H-0014/leadlag BTC->ADA (+1 bar delay): REJECT
```

## Addendum: reading the BH/Holm rejections (written by hand after the run; no number changed)

The HAC p-values are two-sided. The 2 BH and Holm rejections are EXP-000019 (st_reversal, Sharpe -3.96) and
EXP-000021 (ar, Sharpe -1.33). Both are significantly **negative** after costs. At 4-hour rebalancing the
reversal and AR books lose to turnover costs. So no trial shows significantly positive net returns after
multiple-testing correction. The only WATCH is EXP-000015 (xs_mom). Its alpha vs buy-and-hold is 0.27/yr
(one-sided p 0.0076), but the batch BH q is 0.12, Holm p is 0.30, DSR is 0.53 (N=116 trials) and only
50% of the neighbours are positive. It is not proven.
