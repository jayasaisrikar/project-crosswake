# Trial Ledger

This file lists every material research and design decision and every experiment that could have
shaped the reported results. Its purpose is to make the multiple-testing burden explicit so that
the Deflated Sharpe Ratio (DSR), PBO and SPA results can be read against an honest trial count.
Sources: `docs/REVIEW_FOR_CHATGPT.md`, `experiments/registry.jsonl` (26 rows),
`experiments/holdout_log.jsonl` (2 rows), `config/experiment.yaml`, and
`experiments/dsr_sensitivity.py` (output: `experiments/dsr_sensitivity.json`).

## 1. Research-stage choices (before any backtest; literature-driven)

Each of these was chosen from published evidence, not by backtesting this dataset. They still count
as implicit trials, because the literature itself is a filtered set of strategies that worked
(publication bias), and because we chose among them.

| # | Decision | Alternatives considered | How chosen |
|---|---|---|---|
| R1 | Reject BTC to altcoin lead-lag as the core strategy | lead-lag, TSMOM, carry, XS-momentum, pairs, DL | Web research (5 passes); edge is HFT-only or stale-price artifact |
| R2 | Time-series momentum (TSMOM) family | XS-momentum, breakout, MA-cross | Moskowitz-Ooi-Pedersen 2012; Liu-Tsyvinski 2021; Han-Kang-Ryu |
| R3 | Sign-of-return ensemble over lookbacks {20, 60, 120} d | single lookback, MA-cross, continuous score | Literature horizons (1 to 6 months) |
| R4 | Inverse-vol risk parity across assets | equal weight, cap weight | Standard TSMOM construction |
| R5 | Portfolio vol target 20%, 30-day vol window | 10/15/25/30% | Common CTA convention |
| R6 | Caps: 25% per asset, 2.0x gross; long/short allowed | long-only, other caps | Convention, not tuned |
| R7 | Daily rebalance at 00:00 UTC | 1h, 8h, weekly | Convention |
| R8 | Funding carry (long spot, short perp) | none, basis-only | BitMEX research; positive historical funding |
| R9 | Carry thresholds: enter at 10% APR, exit at 2% APR, 72h mean | other thresholds | Judgement from funding history (look-ahead risk: chosen knowing 2021 funding levels) |
| R10 | 50/50 sleeve allocation, no inter-sleeve rebalancing | risk parity, optimisation | Simplicity |
| R11 | Universe: 16 hand-picked coins incl. LUNA, FTT, EOS | PIT rule-based universe | Chosen in 2026 with hindsight (survivorship). PIT replacement: `engine.universe` |
| R12 | Costs: VIP0 taker fees, 0.5/2 bp half-spread, sqrt impact 0.7 | | Exchange schedule and literature |
| R13 | Split: dev to 2024-06-30, holdout 2024-07-01 to 2026-09 | | Pre-declared |

## 2. Backtest experiments (on this dataset)

| # | Experiment | What was observed | Effect on design |
|---|---|---|---|
| E1 | Trend v1: each asset vol-targeted separately and the results summed | 112% portfolio vol, -91% drawdown | **Bug fix 1**: moved to portfolio-level ex-ante vol scaling (v2). This is a correction, but it was found by looking at backtest output. |
| E2 | Carry v1: no basis guard | FTT spot hedged against a different FTT perp; -23% in 2025 | **Bug fix 2**: basis guard `abs(spot/perp - 1) <= 2%` plus a regression test. Found by inspecting holdout-period P&L. |
| E3 | 9-variant trend grid, development period (registry rows 1-9, 39,432 h) | Sharpe 0.92 to 1.07 | Feeds DSR/PBO (dev). The baseline was **not** reselected; it is the pre-declared one. |
| E4 | Development portfolio runs (rows 10-13) | Combined 1.00, Trend 1.08, Carry 0.14, BTC 1.05 | |
| E5 | Same grid, full period with holdout (rows 14-22, 59,160 h) | Sharpe 0.56 to 1.03 | Feeds DSR/PBO/SPA (full) |
| E6 | Full-period portfolio runs (rows 23-26) | Combined 0.94, Trend 1.02, Carry -0.32, BTC 0.90 | |
| E7 | Cost stress 1.5x and 2.0x | Combined Sharpe 0.69 and 0.46 | Reporting only |
| E8 | Walk-forward (24m train / 3m test, fixed params) | 12 of 19 windows positive | Reporting only |

**Holdout unlocks** (`experiments/holdout_log.jsonl`):
1. 2026-10-09 15:00 UTC: first final evaluation after the portfolio-vol bug fix (params frozen).
2. 2026-10-09 15:03 UTC: re-run after the carry basis-guard fix (E2), with no parameter tuning.
   The second fix was found **because** the holdout was viewed. The holdout is therefore
   contaminated for carry and partly for the combined portfolio. Trend parameters were not changed.

**Work in progress after this ledger was written** (seen in `config/experiment.yaml` and
`signals/registry.py`; not yet in the registry). Each of these adds trials and must be added to
this ledger when it is run:
- Carry v2: daily rebalance, max 5 positions, no-trade band, cost-aware entry (14-day hold,
  2x cost margin), measured spreads. This is a re-specification made **after** seeing that carry
  v1 lost money, including in the holdout. It is a new trial family, at least 5 new knobs.
- New strategy families: `breakout` (Donchian), `xsmom`, `trend_regime`. Even if these are
  disabled, each one evaluated is a trial.
- PIT universe (`engine.universe`, `top_n`, `min_history_days`) adds at least 2 to 4 more
  configurations if it is compared against the 16-coin universe.

## 3. Effective number of trials

**Explicit:** 9 grid variants. This is the N used for DSR in the reports.

**Correlation-adjusted (eigenvalue method on the 9 grid trials, full-period daily returns,
`experiments/dsr_sensitivity.json`):** the mean pairwise correlation is 0.82. The eigenvalues are
7.53, 0.81, 0.64 and then less than 0.011 for the rest. The effective N is 1.4 by participation
ratio and 1.8 by entropy effective rank. The grid is really about 2 to 3 independent bets: one
for each lookback set, with vol target almost irrelevant because it is only a leverage scaling.
So **N = 9 overstates the independent trials inside the grid**, but it understates the search
as a whole.

**Implicit:** we count the independent decisions that could have been made differently
after looking at data or at the literature:
- Strategy-family selection (R1, R2, R8, plus XS-mom, pairs and DL rejected): about 5 families.
- Signal construction choices R3 to R7: about 5 binary or ternary choices, roughly 2 to 3
  independent alternatives each, mostly literature-fixed.
- Carry thresholds R9: about 2 to 3.
- Universe R11: 1 large hindsight choice. Its effect is not a trial count but a bias, now
  addressed by the PIT universe.
- Bug fixes E1 and E2 found through backtest output: 2. Holdout views: 2.
- Grid: 9 (about 2 to 3 effective).

**Honest estimate: N_eff is about 20 to 50** for the trend result. The lower end assumes the
literature choices are genuinely ex-ante. The upper end treats every literature choice as a
selected trial and adds the carry re-specifications now in progress. N = 100 is a conservative
bound if all new strategy families (breakout, xsmom, trend_regime, carry v2) are evaluated
and the best is reported.

## 4. DSR sensitivity (trend, selected config L = [20, 60, 120], vol target 20%)

These figures come from `uv run python experiments/dsr_sensitivity.py`. The 9 trend variants were
re-run with the current code on the full period, 2020-01-01 to 2026-09-30 (2,465 days, 1x costs).
The selected config has an annual Sharpe of 1.02. The observed trial Sharpes are 0.57 to 1.03,
with a standard deviation of 0.19 (annual). For N > 9, the synthetic trial Sharpe sets are normal
quantiles rescaled to the observed mean and standard deviation. The row for N = 9 uses the real
trial Sharpes.

| N | E[max SR] (annual), sd as observed | DSR | DSR, sd x2 | DSR, sd x3 |
|---|---|---|---|---|
| 9 | 0.29 | **0.971** | 0.873 | 0.650 |
| 20 | 0.36 | **0.956** | 0.777 | 0.428 |
| 50 | 0.43 | **0.936** | 0.651 | 0.229 |
| 100 | 0.48 | **0.918** | 0.554 | 0.131 |

**How to read this.** The DSR depends on N only through E[max SR], which is roughly proportional
to (dispersion of trial Sharpes) x sqrt(2 ln N). Our grid's dispersion is small (sd 0.19),
because the variants are highly correlated. Under that dispersion the trend result survives even
N = 100 (DSR 0.92). That conclusion holds **only if** the broader implicit search had trial
dispersion similar to the grid. Searches across strategy families typically show 2 to 3 times
more dispersion. At that level, the DSR falls below 0.95 at every N, and below 0.5 for N >= 20
when sd is tripled. **Conclusion:** report DSR at N = 9 as a ceiling, not an estimate. At the
honest range N of about 20 to 50 with family-level dispersion (sd x2), the DSR is 0.65 to 0.78.
That is suggestive, not significant at 95%. A clean answer requires forward or paper-trading
data or a new holdout.

## 5. Rules going forward

1. Every backtest run on any data goes into `experiments/registry.jsonl`. This includes
   discarded strategy families and carry v2.
2. Report DSR at N = max(registry trial count, 20), with the dispersion of all registered
   trials, not just the grid.
3. The holdout (2024-07 to 2026-09) is spent. Any new design must be judged on forward data
   from 2026-10 onward, or on the PIT-universe re-run declared before it is viewed.
