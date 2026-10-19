# BASELINE V0 — frozen reference point

**This directory (`reports/baseline_v0/`) must NEVER be overwritten or edited.** It is the
reference against which every later change of the adaptive research engine is compared. New
baselines go into a new directory (`baseline_v1/`, ...).

## Provenance
- Git commit: `8afa30870b3586c0a628a512ac4cada6c035830b` plus the uncommitted working tree listed in
  `git_status.txt`.
- Config snapshot: `experiment.yaml` (identical copy of `config/experiment.yaml` at capture).
- Experiment registry snapshot: `registry.jsonl` (88 rows); holdout log snapshot: `holdout_log.jsonl` (5 views).
- Metrics: `stats.json` (identical to `reports/stats.json` at capture), produced by the last
  `engine backtest --unlock-holdout` run (holdout view #4 in the log).

## Quality gates
| Gate | Result | File |
|---|---|---|
| pytest | 184 passed in 71.89 s | `pytest.txt` |
| ruff | All checks passed | `ruff.txt` |
| mypy | Success: no issues found in 59 source files | `mypy.txt` |

## Periods
- DEVELOPMENT: 2020-01-01 -> 2024-06-30 (1643 days).
- "HOLDOUT ONLY" (H1 as used by the old pipeline): 2024-07-01 -> 2026-09-30 (822 days).
  **Warning:** this window also contains H2 (from 2025-10-01). H1 is consumed (5 views) and H2 has
  been displayed inside those views; see `AUDIT_REPORT.md` §7.1, §9.
- FULL: 2020-01-01 -> 2026-09-30 (descriptive only).

## Per-strategy metrics (1x costs)

| Strategy | Period | Total ret | CAGR | Vol | Sharpe | Sortino | Max DD | % pos months |
|---|---|---|---|---|---|---|---|---|
| Combined (50/50) | Dev | 94.2% | 15.9% | 12.5% | 1.24 | 1.75 | -16.1% | 61.1% |
| Trend | Dev | 153.1% | 22.9% | 20.8% | 1.10 | 1.53 | -24.2% | 55.6% |
| Carry | Dev | 35.3% | 6.9% | 1.7% | 4.01 | 6.11 | -1.5% | 59.3% |
| BTC buy&hold | Dev | 771.1% | 61.7% | 68.1% | 1.05 | 1.47 | -77.5% | 57.4% |
| Combined (50/50) | H1+H2 | 31.4% | 12.9% | 14.1% | 0.93 | 1.32 | -12.6% | 63.0% |
| Trend | H1+H2 | 47.9% | 19.0% | 20.8% | 0.94 | 1.33 | -18.7% | 63.0% |
| Carry | H1+H2 | 0.7% | 0.3% | 0.2% | 1.36 | 1.93 | -0.2% | 14.8% |
| BTC buy&hold | H1+H2 | 33.4% | 13.6% | 46.2% | 0.51 | 0.72 | -53.9% | 55.6% |
| Combined (50/50) | Full | 155.2% | 14.9% | 13.1% | 1.13 | 1.59 | -16.1% | 61.7% |

(Sleeve total returns are on sleeve capital; Trend/Carry sleeves each run at 50k.)

## Robustness statistics
| Statistic | Dev | H1+H2 | Full |
|---|---|---|---|
| Combined HAC t (daily mean) | 2.59 | 1.43 | 2.93 |
| Combined bootstrap Sharpe 95% CI | [0.35, 2.16] | [-0.34, 2.26] | [0.38, 1.87] |
| Combined PSR | 0.997 | 0.917 | 0.998 |
| Trend HAC t | 2.34 | 1.44 | 2.75 |
| Carry HAC t | 7.10 | 1.77 | 6.67 |
| DSR (trend, 9 trials only) | 0.985 | 0.630 | 0.978 |
| PBO (trend 9-config grid) | 0.938 | 0.558 | 0.373 |
| SPA p-value vs BTC | 0.921 | 0.530 | 0.902 |

## Cost stress (Combined)
| Multiplier | Dev Sharpe / CAGR / MaxDD | H1+H2 Sharpe / CAGR / MaxDD |
|---|---|---|
| 1.0x | 1.24 / 15.9% / -16.1% | 0.93 / 12.9% / -12.6% |
| 1.5x | 1.09 / 13.6% / -17.8% | 0.78 / 10.2% / -12.7% |
| 2.0x | 0.94 / 11.4% / -20.4% | 0.63 / 7.7% / -12.9% |

## Cost breakdown (USDT, 1x)
| | Gross P&L | Fees | Spread | Impact | Funding (+paid) | Net P&L | Turnover x/yr |
|---|---|---|---|---|---|---|---|
| Trend dev | 112,967 | 15,821 | 3,956 | 3,893 | 12,742 | 76,554 | 74.4 |
| Carry dev | 47 | 2,305 | 1,266 | 472 | -21,629 | 17,632 | 11.1 |
| Trend H1+H2 | 32,491 | 5,559 | 865 | 1,291 | 843 | 23,933 | 86.2 |
| Carry H1+H2 | 16 | 196 | 103 | 25 | -666 | 358 | 2.3 |

## Fixed-parameter walk-forward (Combined, quarterly test folds)
Dev folds (2022Q1-2024Q2) Sharpe: 0.26, 2.98, -4.30, 2.07, -1.03, -0.21, 0.67, 1.86, 3.53, -2.33.
H1 folds (2024Q3-2025Q3): -1.53, 3.23, 0.56, -1.41, 1.90.
H2 folds (2025Q4-2026Q3, already displayed): -0.00, 1.37, 2.27, 1.53.

## Lead-lag research baseline (dev only, `reports/leadlag/`)
All 7 lead-lag variants REJECTED by the pre-registered gate; headline k=2/h=1: net Sharpe -4.23,
gross Sharpe -0.74, 49,146 trades, HAC t -8.4. Granger incremental walk-forward OOS R2 negative
for the followers listed in `predictive_oos.csv`. Verdict: NO EDGE on hourly bars.

## Use
Any new model or engine change is compared to these numbers on data < 2025-10-01 only (H1 is
ordinary OOS now). H2 is opened once, via `holdout_guard.open_h2(reason=...)`, for a frozen candidate.
