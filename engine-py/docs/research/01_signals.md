# 01 — Candidate signals: evidence, Sharpe, costs, decay

Verification legend: **[V]** = checked by web search in this session (2026-10-09); **[K]** = from prior
knowledge of the literature. The URL is the canonical location, but re-check numbers against the PDF before
quoting them externally. No number below was produced by our engine.

## Ranked list (evidence strength x cost robustness x feasibility with our data)

| # | Signal | Reported performance | Cost sensitivity | Decay since publication | Source |
|---|---|---|---|---|---|
| 1 | Time-series trend, vol-scaled, multi-lookback Donchian ensemble | Zarattini, Pagani & Barbon (2025): Sharpe > 1.5 net of fees, ~10.8% annual alpha vs BTC, rotating top-20 liquid coins [V] | Low turnover; the ensemble smooths signal flips | Recent paper; crypto trend is weaker in sideways years (2023, 2025) | [SFI RP 25-80](https://ideas.repec.org/p/chf/rpseri/rp2580.html), [Concretum summary](https://concretumgroup.com/catching-crypto-trends-a-tactical-approach-for-bitcoin-and-altcoins/) |
| 2 | TSMOM under realistic frictions | Han, Kang & Ryu: TSMOM evidence "strong", CSMOM "weak"; many significant momentum portfolios lose significance or get liquidated once costs and intraday swings are modelled; losers often rebound [V] | Explicitly cost-aware (that is the paper's point) | n/a | [PDF](https://acfr.aut.ac.nz/__data/assets/pdf_file/0009/918729/Time_Series_and_Cross_Sectional_Momentum_in_the_Cryptocurrency_Market_with_IA.pdf) |
| 3 | Market momentum, 1-4 week horizon | Liu & Tsyvinski, "Risks and Returns of Cryptocurrency" (RFS 2021): strong time-series momentum at 1-8 week horizons; investor attention predicts returns [K] | Weekly rebalance, so cheap | Reportedly weaker after 2021 [K] | [NBER w24877](https://www.nber.org/papers/w24877) |
| 4 | Volatility-managed exposure | Moreira & Muir (JF 2017) for factors; Harvey et al. (2018): vol targeting helps most in assets with vol clustering (crypto qualifies) [K] | Adds turnover; use a slow vol estimate plus buffers | Robust (risk management, not alpha) | [Moreira-Muir](https://doi.org/10.1111/jofi.12513), [Harvey et al.](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3175538) |
| 5 | Donchian / N-day breakout | Same family as #1 [V] | Low | Same as #1 | as #1 |
| 6 | Funding / basis carry (long spot, short perp) | Schmeling, Schrimpf & Todorov, BIS WP 1087: carry averages > 10% p.a. and spikes to 40-60%; crash risk from margin spikes and liquidations [V]. arXiv 2510.14435: carry Sharpe 6.45 over 2020-2025, 4.06 from 2024, **negative in 2025** [V] | High: four fee legs per round trip | **Strong decay** from basis-trade crowding (Ethena era) | [BIS WP 1087](https://www.bis.org/publ/work1087.htm), [arXiv 2510.14435](https://arxiv.org/pdf/2510.14435) |
| 7 | Cross-sectional momentum | Liu, Tsyvinski & Wu (JF 2022): market, size and momentum factors price crypto (broad universe, 2014-2018) [V] | High (long-short, weekly, small caps) | Weak in large-cap universes and after costs (Han-Kang-Ryu) [V] | [SSRN 3379131](https://papers.ssrn.com/abstract=3379131), [NBER w25882](https://www.nber.org/papers/w25882.pdf) |
| 8 | Short-term reversal (daily / intraday) | Documented gross in daily crypto data [K] | Very high; costs eat most of it for 16 large coins | Fast; an HFT domain | [LTW](https://papers.ssrn.com/abstract=3379131) |
| 9 | Open interest / liquidation | Practitioner research (Kaiko, Glassnode, Coinglass): OI build-ups plus extreme funding come before liquidation cascades; little peer-reviewed out-of-sample evidence [K] | Medium | Unknown; heavily data-mined by retail | [Kaiko](https://research.kaiko.com/), [Glassnode](https://insights.glassnode.com/) |
| 10 | On-chain (MVRV, SOPR, exchange flows, NVT) | Useful as regime context; predictive power at weekly horizons is weak and unstable [K] | Low turnover, low signal | Indicators re-parameterised after the fact; data revisions add look-ahead | [Glassnode](https://insights.glassnode.com/) |
| 11 | BTC-to-alt lead-lag | Real, but milliseconds-scale for liquid coins (already rejected in REVIEW_FOR_CHATGPT.md) | Prohibitive at 1h | Gone | — |

## Notes

### Trend (#1, #2, #5)
- Mechanism: crypto flows are retail, leveraged and driven by attention (Liu & Tsyvinski). That gives slow
  diffusion and overreaction, which shows up as serial correlation at 1-12 week horizons.
- The **short side is weak** in crypto trend: losers rebound (Han-Kang-Ryu) and short squeezes are common.
  Zarattini et al. are mainly long/flat. Our engine runs long-short on perps, so report short-leg PnL separately.
- General-case corroboration: Hurst, Ooi & Pedersen, "A Century of Evidence on Trend-Following Investing" (AQR)
  [K] https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing ;
  Moskowitz, Ooi & Pedersen (JFE 2012) https://doi.org/10.1016/j.jfineco.2011.11.003 [K].

### Carry (#6)
- Our backtest (Sharpe -0.32 net) is **consistent with the literature's post-2024 decay**. That alone does not
  prove a bug.
- Binance pays funding every 8 hours. Carry is worth running only when expected funding over the holding period
  exceeds the round-trip cost (both legs, entry and exit). That makes it a **threshold rule**, not always-on.
- Tail risk: the short perp leg of a delta-neutral book can be liquidated when margin spikes. Keep ample margin.

### Cross-sectional (#7, #8)
- Our universe is 16 large coins, and the evidence for these signals is concentrated in small caps. Keep them as
  research only.

### OI / on-chain (#9, #10)
- Not in our dataset, so excluded from the build list.
