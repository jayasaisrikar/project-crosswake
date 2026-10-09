# 03 — Why "highest return ever" backtests are overfit; realistic live Sharpe

## Mechanisms
1. **Multiple testing.** Bailey, Borwein, Lopez de Prado & Zhu, "Pseudo-Mathematics and Financial
   Charlatanism" (Notices AMS 2014): try enough configurations and a high in-sample Sharpe appears by chance alone.
   https://www.ams.org/notices/201405/rnoti-p458.pdf [K]
2. **Deflated Sharpe Ratio** (Bailey & Lopez de Prado 2014) corrects the observed Sharpe for the number of trials,
   skew, kurtosis and sample length. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551 [K]
3. **Probability of Backtest Overfitting / CSCV** (Bailey et al. 2017).
   https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253 [K]
4. **Backtest-to-live gap.** Wiecki et al. (2016), 888 Quantopian algorithms: in-sample Sharpe barely predicted
   out-of-sample Sharpe, and more backtesting meant a bigger gap.
   https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2745220 [K; a secondary source in search agreed]
5. **Harvey, Liu & Zhu (RFS 2016):** the t-stat hurdle for a new factor is about 3, not 2.
   https://doi.org/10.1093/rfs/hhv059 [K]
6. **Publication decay.** McLean & Pontiff (JF 2016): anomaly returns fall ~26% out-of-sample and ~58% after
   publication. https://doi.org/10.1111/jofi.12365 [K]
7. **Crypto-specific traps:**
   - Survivorship: dead coins dropped from the universe. Our universe keeps LUNA, FTT and EOS, which is correct.
   - One bull regime (2020-21) dominating CAGR.
   - Same-candle look-ahead in indicators.
   - Perp funding left out of PnL.
   - Fills assumed during crashes despite outages and ADL.
   - Compounded leverage that looks great until a single gap.

## Realistic expectations
- Diversified CTAs (SG Trend Index): long-run live Sharpe of roughly 0.3-0.6 [K].
- Crypto trend: live Sharpe above ~1.0 sustained across several cycles is rare. Plan for **0.5-1.0**, about **half
  the backtest Sharpe** (the McLean-Pontiff and Wiecki haircuts). Our 0.94-1.02 backtest implies roughly 0.5 live.
- Expect multi-year flat stretches. Our own combined returns for 2022-2025 were +3.0, +2.3, +10.9 and +1.2%.
- Carry: after 2024, expect about 0 net unless funding returns to 2021 levels.

## Guardrails (no new parameters)
- Log how many configurations were ever tried, and compute the DSR for the final pick.
- Keep one hold-out period untouched until the final run.
- Stress costs at 2x and 3x. The strategy must stay positive at 2x.
- Report a sub-period table and split PnL into long and short legs.
