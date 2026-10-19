# RESEARCH — index and summary

Literature and practitioner survey for the systematic crypto engine (Binance 1h spot + perp, 16 large coins,
2020-2026). Written 2026-10-09. Full detail is in `docs/research/`:

| File | Contents |
|---|---|
| [research/01_signals.md](research/01_signals.md) | Ranked signals: reported Sharpe, cost sensitivity, decay, citations and URLs |
| [research/02_feasible_recipes.md](research/02_feasible_recipes.md) | Signals computable from our data only, with published recipes |
| [research/03_overfitting_and_expectations.md](research/03_overfitting_and_expectations.md) | Overfitting mechanisms, realistic live Sharpe, guardrails |
| [research/04_commercial_engines.md](research/04_commercial_engines.md) | Freqtrade, Jesse, Hummingbot, 3Commas, Cryptohopper, signal groups |

Legend: [V] = verified by web search this session; [K] = prior knowledge, re-check the PDF before quoting.

## 1. Ranked signals (short form)
1. **Vol-scaled multi-lookback trend / Donchian ensemble.** Sharpe > 1.5 net of fees on the top-20 coins
   (Zarattini, Pagani & Barbon 2025) [V] https://ideas.repec.org/p/chf/rpseri/rp2580.html
2. **TSMOM survives realistic costs; CSMOM does not** (Han, Kang & Ryu) [V]
   https://acfr.aut.ac.nz/__data/assets/pdf_file/0009/918729/Time_Series_and_Cross_Sectional_Momentum_in_the_Cryptocurrency_Market_with_IA.pdf
3. **1-4 week market momentum** (Liu & Tsyvinski, RFS 2021) [K] https://www.nber.org/papers/w24877
4. **Vol-targeting overlay** (Moreira & Muir 2017; Harvey et al. 2018) [K]. A risk tool that raises Sharpe modestly.
5. **Funding carry, threshold-gated only.** BIS WP 1087 [V] https://www.bis.org/publ/work1087.htm . Carry Sharpe
   fell from 6.45 (2020-25) to 4.06 (2024 on) and turned negative in 2025 (arXiv 2510.14435) [V]. This strong
   decay matches our -0.32.
6. Cross-sectional momentum and reversal: weak in large caps after costs (LTW JF 2022 [V]; Han-Kang-Ryu [V]).
7. OI, liquidation and on-chain signals: not in our data, and weak peer-reviewed evidence.

## 2. Feasible with our data
- Trend: TSMOM 20/60/120d, a Donchian ensemble, and 7d/28d short lookbacks.
- A vol overlay.
- Threshold-gated carry.
- Volume and trade count: liquidity filter and impact model only, not alpha.
- Recipes are in 02.

## 3. Overfitting and expectations
- Methods: Deflated Sharpe and PBO (Bailey & Lopez de Prado).
- Decay: McLean-Pontiff measure ~58% after publication.
- Backtest-to-live gap: the 888-algorithm Quantopian study.
- Expect **live Sharpe of about 0.5**, roughly half the backtest's 0.94-1.02, with multi-year flat stretches.

## 4. Recommended ensemble design
- Sleeves:
  - (a) TSMOM sign ensemble over {20, 60, 120}d.
  - (b) Donchian breakout ensemble with the published lookbacks.
  - (c) Carry, switched on only when expected funding exceeds round-trip cost.
- Within each trend sleeve: equal-weight the lookbacks (nothing fitted) and size each coin by inverse vol.
- Across sleeves: **equal risk**, i.e. scale each sleeve to the same ex-ante vol. Then apply one portfolio vol
  target with a gross-leverage cap. No optimiser and no per-coin parameters.
- Turnover: trade only when the weight change is larger than a no-trade buffer derived from costs.
- Report a long/flat variant next to long/short, since the short leg is the weakest part of crypto trend.
- Free parameters: the lookback sets (taken from papers), the vol target and the leverage cap. Nothing else.

- [research/05_engine_results.md](research/05_engine_results.md) — dev-period results of this build (new signals, rebuilt carry)
