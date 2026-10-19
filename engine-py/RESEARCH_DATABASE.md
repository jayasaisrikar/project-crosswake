# RESEARCH_DATABASE

Broad literature/practitioner scan for the crypto systematic engine. Sources marked *verified* were located via web search during this session; sources marked *NOT re-verified* are well-known papers cited from prior knowledge (DOIs should be checked before external citation). No results were invented; uncertain details are flagged inline.

Evidence classes: Proven evidence / Hypothesis / Opinion / Marketing claim. Test status reflects src/engine/signals (trend, xsmom, carry, breakout, regime, leadlag) and src/engine/leadlag. Formal hypotheses: research/hypotheses_seed.yaml.


## R-001

- **Source:** https://www.nber.org/system/files/working_papers/w24877/w24877.pdf (verified via web search this session)
- **Author:** Y. Liu, A. Tsyvinski
- **Date:** 2018 (NBER w24877); RFS 34(6) 2021
- **Hypothesis:** Crypto returns show strong time-series momentum; attention proxies forecast returns
- **Market:** Spot
- **Asset:** BTC, ETH, XRP
- **Timeframe:** Daily/weekly
- **Data required:** Spot prices, Google/Twitter attention
- **Methodology:** Time-series predictive regressions
- **Reported result:** Strong TS momentum at 1-8 week horizons; little exposure to equity/macro factors
- **Known weaknesses:** Early sample (2011-2018), few coins, regime may have changed post-institutionalization
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Proven evidence (peer-reviewed, in-sample)
- **Test status:** PARTIALLY TESTED (signals/trend.py)

## R-002

- **Source:** https://www.nber.org/papers/w25882.pdf (verified via web search this session)
- **Author:** Y. Liu, A. Tsyvinski, X. Wu
- **Date:** 2019 (NBER w25882); J. Finance 2022 (DOI 10.1111/jofi.13119, journal not confirmed from primary source)
- **Hypothesis:** Market, size and momentum factors span the crypto cross-section
- **Market:** Spot
- **Asset:** Broad coin universe (>1,500 coins by 2018)
- **Timeframe:** Weekly
- **Data required:** Spot prices, market caps, volume
- **Methodology:** Portfolio sorts, factor model
- **Reported result:** Size and momentum long-short portfolios earn significant excess returns
- **Known weaknesses:** Small illiquid coins drive much of it; survivorship; costs
- **Crypto relevance:** High
- **Implementation difficulty:** Medium
- **Potential edge:** Medium (lower on liquid Binance universe)
- **Evidence class:** Proven evidence
- **Test status:** PARTIALLY TESTED (signals/xsmom.py)

## R-003

- **Source:** https://doi.org/10.1016/j.jfineco.2011.11.003 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** T. Moskowitz, Y. Ooi, L. Pedersen
- **Date:** 2012, JFE
- **Hypothesis:** Past 12m excess return predicts next-month return for futures (TSMOM)
- **Market:** Futures, multi-asset
- **Asset:** 58 futures
- **Timeframe:** Monthly
- **Data required:** Futures prices
- **Methodology:** Vol-scaled sign-of-past-return strategy
- **Reported result:** Significant TSMOM across asset classes; partial reversal at long horizons
- **Known weaknesses:** Not crypto; post-2012 performance weaker
- **Crypto relevance:** Medium (template)
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Proven evidence
- **Test status:** PARTIALLY TESTED (signals/trend.py)

## R-004

- **Source:** https://doi.org/10.1016/j.jfineco.2015.12.002 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** K. Daniel, T. Moskowitz
- **Date:** 2016, JFE
- **Hypothesis:** Momentum crashes occur in panic states after market declines with high vol; dynamic scaling mitigates
- **Market:** Equities (+other)
- **Asset:** US equities
- **Timeframe:** Monthly/daily
- **Data required:** Returns, market state, vol forecasts
- **Methodology:** Conditional regressions, dynamic weighting
- **Reported result:** Crashes partly predictable; dynamic momentum materially improves Sharpe
- **Known weaknesses:** Equities; crypto short side funding differs
- **Crypto relevance:** High
- **Implementation difficulty:** Medium
- **Potential edge:** Medium
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-005

- **Source:** https://doi.org/10.1111/jofi.12513 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** A. Moreira, T. Muir
- **Date:** 2017, J. Finance
- **Hypothesis:** Scaling exposure by inverse lagged realized variance raises Sharpe
- **Market:** Equities/factors
- **Asset:** Factor portfolios
- **Timeframe:** Monthly
- **Data required:** Daily returns
- **Methodology:** Vol-managed portfolios, alpha regressions
- **Reported result:** Positive alphas for vol-managed factors
- **Known weaknesses:** Later work (e.g. Cederburg et al.) finds OOS gains weak once implementable; turnover
- **Crypto relevance:** High (crypto vol clustering strong)
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Proven evidence (contested OOS)
- **Test status:** TESTED (signals/regime.py vol-managed trend)

## R-006

- **Source:** https://doi.org/10.1093/jjfinec/nbp001 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** F. Corsi
- **Date:** 2009, J. Fin. Econometrics
- **Hypothesis:** HAR-RV: daily/weekly/monthly RV components forecast future RV
- **Market:** Any
- **Asset:** FX/equity indices
- **Timeframe:** Intraday->daily
- **Data required:** Intraday returns
- **Methodology:** OLS cascade regression
- **Reported result:** Simple model rivals long-memory models
- **Known weaknesses:** Linear; jumps; crypto 24/7 calendar
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Indirect (sizing)
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-007

- **Source:** https://doi.org/10.1016/0304-4076(86)90063-1 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** T. Bollerslev
- **Date:** 1986, J. Econometrics
- **Hypothesis:** GARCH(1,1) captures volatility clustering
- **Market:** Any
- **Asset:** Any
- **Timeframe:** Daily
- **Data required:** Returns
- **Methodology:** MLE
- **Reported result:** Standard benchmark for vol forecasting
- **Known weaknesses:** Fat tails; HAR often beats on RV data
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Indirect (sizing)
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-008

- **Source:** https://www.bis.org/publ/work1087.pdf (verified via web search this session)
- **Author:** M. Schmeling, A. Schrimpf, K. Todorov
- **Date:** 2023 (BIS WP 1087; CEPR DP20719)
- **Hypothesis:** Crypto carry (futures-spot basis) is large and time-varying, driven by trend-chasing retail leverage and limited arbitrage capital; high carry linked to crash/liquidation risk
- **Market:** Futures/perps
- **Asset:** BTC, ETH
- **Timeframe:** Daily
- **Data required:** Futures, spot, funding
- **Methodology:** Carry measurement, predictive regressions
- **Reported result:** Carry up to 40-60% p.a. (figure differs between versions)
- **Known weaknesses:** Arb risk from margin spikes; exchange counterparty
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** High
- **Evidence class:** Proven evidence (working paper)
- **Test status:** TESTED (signals/carry.py)

## R-009

- **Source:** https://arxiv.org/abs/2212.06888 (verified via web search this session)
- **Author:** S. He, A. Manela, O. Ross, V. von Wachter
- **Date:** 2022-2024 (arXiv v6)
- **Hypothesis:** Perp deviations from no-arb price are large, comove, shrink over time; simple strategy has high Sharpe
- **Market:** Perps
- **Asset:** Major coins
- **Timeframe:** Daily/8h
- **Data required:** Perp, spot, funding
- **Methodology:** Random-maturity no-arb bounds; trading strategy
- **Reported result:** Large Sharpe even at highest Binance fee tier
- **Known weaknesses:** Edge decaying over time; author industry ties
- **Crypto relevance:** High
- **Implementation difficulty:** Medium
- **Potential edge:** High (decaying)
- **Evidence class:** Proven evidence (preprint)
- **Test status:** PARTIALLY TESTED (carry.py)

## R-010

- **Source:** https://doi.org/10.1093/jjfinec/nbt017 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** R. Cont, A. Kukanov, S. Stoikov
- **Date:** 2014, J. Fin. Econometrics
- **Hypothesis:** Order-flow imbalance at best quotes linearly drives short-horizon price changes
- **Market:** Equity LOB
- **Asset:** US stocks
- **Timeframe:** Seconds-minutes
- **Data required:** L1 order book
- **Methodology:** Linear regression of dP on OFI
- **Reported result:** High R^2; slope inversely related to depth
- **Known weaknesses:** Contemporaneous, not predictive; needs L1 book
- **Crypto relevance:** High (microstructure)
- **Implementation difficulty:** High
- **Potential edge:** Low at hourly
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED (no book data)

## R-011

- **Source:** https://doi.org/10.1111/j.1540-6261.1995.tb04054.x (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** J. Hasbrouck
- **Date:** 1995, J. Finance
- **Hypothesis:** Information shares measure where price discovery occurs across venues
- **Market:** Multi-venue
- **Asset:** Equities
- **Timeframe:** Intraday
- **Data required:** Synchronized prices
- **Methodology:** VECM information shares
- **Reported result:** Framework
- **Known weaknesses:** Needs synchronized tick data
- **Crypto relevance:** High (exchange lead-lag)
- **Implementation difficulty:** Medium
- **Potential edge:** Low-Medium
- **Evidence class:** Proven evidence (method)
- **Test status:** PARTIALLY TESTED (leadlag/)

## R-012

- **Source:** https://businessperspectives.org/journals/investment-management-and-financial-innovations/issue-421/a-tick-by-tick-level-measurement-of-the-lead-lag-duration-between-cryptocurrencies-the-case-of-bitcoin-versus-cardano (verified via web search this session)
- **Author:** B. Anderson et al. (co-authors not confirmed)
- **Date:** 2023, IMFI
- **Hypothesis:** BTC leads ADA by seconds
- **Market:** Spot
- **Asset:** BTC, ADA
- **Timeframe:** Tick
- **Data required:** Tick trades
- **Methodology:** Lead-lag cross-correlation
- **Reported result:** Lead 16-118s, mean ~57s (2019-2021)
- **Known weaknesses:** Lead is seconds -> invisible at hourly bars
- **Crypto relevance:** High
- **Implementation difficulty:** High
- **Potential edge:** Low at hourly
- **Evidence class:** Proven evidence (small journal)
- **Test status:** PARTIALLY TESTED (leadlag/ at hourly)

## R-013

- **Source:** https://research-api.cbs.dk/ws/portalfiles/portal/59795067/612646_High_Frequency_Lead_Lag_Relationships_in_The_Bitcoin_Market.pdf (verified via web search this session)
- **Author:** CBS master's thesis (author not confirmed)
- **Date:** 2019
- **Hypothesis:** Some BTC exchanges lag others by up to 15s
- **Market:** Spot, multi-exchange
- **Asset:** BTC
- **Timeframe:** Tick
- **Data required:** Tick data multiple exchanges
- **Methodology:** Lead-lag, directional prediction
- **Reported result:** Up to ~70% directional accuracy, profits eaten by fees/slippage
- **Known weaknesses:** Thesis; 2018 data
- **Crypto relevance:** Medium
- **Implementation difficulty:** High
- **Potential edge:** Low
- **Evidence class:** Hypothesis
- **Test status:** UNTESTED

## R-014

- **Source:** https://quanthedge.substack.com/p/when-bitcoin-zigs-and-altcoins-zag (verified via web search this session)
- **Author:** Quanthedge (Substack)
- **Date:** n.d.
- **Hypothesis:** BTC/alt lead direction varies by market cycle
- **Market:** Spot
- **Asset:** BTC, alts
- **Timeframe:** Daily
- **Data required:** Prices
- **Methodology:** Blog analysis
- **Reported result:** Lead-lag regime-dependent
- **Known weaknesses:** Not peer-reviewed
- **Crypto relevance:** Medium
- **Implementation difficulty:** Low
- **Potential edge:** Low
- **Evidence class:** Opinion
- **Test status:** UNTESTED

## R-015

- **Source:** https://doi.org/10.1103/PhysRevLett.85.461 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** T. Schreiber
- **Date:** 2000, PRL
- **Hypothesis:** Transfer entropy measures directed information flow beyond linear Granger
- **Market:** Any
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Time series
- **Methodology:** Information theory
- **Reported result:** Method
- **Known weaknesses:** Estimation noisy, needs lots of data
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium
- **Potential edge:** Low-Medium
- **Evidence class:** Proven evidence (method)
- **Test status:** UNTESTED

## R-016

- **Source:** https://doi.org/10.2307/1912791 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** C. Granger
- **Date:** 1969, Econometrica
- **Hypothesis:** Granger causality / VAR for predictive lead-lag
- **Market:** Any
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Time series
- **Methodology:** VAR F-tests
- **Reported result:** Method
- **Known weaknesses:** Predictive != tradable; multiple testing
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Low
- **Evidence class:** Proven evidence (method)
- **Test status:** TESTED (leadlag/predictive.py, reports/leadlag/predictive_granger.csv)

## R-017

- **Source:** https://doi.org/10.2307/1912559 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** J. Hamilton
- **Date:** 1989, Econometrica
- **Hypothesis:** Markov-switching (HMM) regimes in returns
- **Market:** Any
- **Asset:** Any
- **Timeframe:** Daily
- **Data required:** Returns
- **Methodology:** Regime-switching MLE
- **Reported result:** Method
- **Known weaknesses:** Regimes clear ex post; detection lag in real time
- **Crypto relevance:** High
- **Implementation difficulty:** Medium
- **Potential edge:** Medium
- **Evidence class:** Proven evidence (method)
- **Test status:** UNTESTED (regime.py is vol-scaling, not HMM)

## R-018

- **Source:** https://arxiv.org/abs/0710.3742 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** R. Adams, D. MacKay
- **Date:** 2007, arXiv
- **Hypothesis:** Bayesian online change-point detection
- **Market:** Any
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Time series
- **Methodology:** BOCPD
- **Reported result:** Method
- **Known weaknesses:** Hazard prior sensitivity
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium
- **Potential edge:** Low-Medium
- **Evidence class:** Proven evidence (method)
- **Test status:** UNTESTED

## R-019

- **Source:** https://doi.org/10.1145/2523813 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** J. Gama et al.
- **Date:** 2014, ACM CSUR
- **Hypothesis:** Concept-drift adaptation: sliding windows, detectors, ensembles
- **Market:** ML
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Any
- **Methodology:** Survey
- **Reported result:** Method
- **Known weaknesses:** Generic
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium
- **Potential edge:** Indirect
- **Evidence class:** Proven evidence (survey)
- **Test status:** UNTESTED

## R-020

- **Source:** https://jfqa.org/wp-content/uploads/2024/09/24955-trend-factor-cross-section-crypto-returns.pdf (verified via web search this session)
- **Author:** C. Fieberg, G. Liedtke, T. Poddig, T. Walker, A. Zaremba
- **Date:** 2025, JFQA
- **Hypothesis:** ML-combined technical signals (CTREND) predict crypto cross-section
- **Market:** Spot
- **Asset:** 3,000+ coins
- **Timeframe:** Weekly
- **Data required:** Prices, volume
- **Methodology:** 28 technical signals, ML aggregation
- **Reported result:** Survives costs; persists in big and liquid coins (2015-2022)
- **Known weaknesses:** Many signals -> multiple testing; sample ends 2022
- **Crypto relevance:** High
- **Implementation difficulty:** Medium
- **Potential edge:** Medium-High
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-021

- **Source:** https://docshare.wps.com/document/machine-learning-and-the-cross-section-of-cryptocurrency-returns/119387/_payload.json (verified via web search this session) (mirror only; publication status unknown)
- **Author:** N. Cakici, S. Shahzad, B. Bedowska-Sojka, A. Zaremba
- **Date:** 2024 WP
- **Hypothesis:** ML adds little over simple characteristics; alpha concentrated in hard-to-trade coins
- **Market:** Spot
- **Asset:** Broad
- **Timeframe:** Weekly
- **Data required:** Characteristics
- **Methodology:** Many ML models
- **Reported result:** Complexity gains limited; price, past alpha, illiquidity, momentum dominate
- **Known weaknesses:** Alpha in small illiquid volatile coins
- **Crypto relevance:** High (cautionary)
- **Implementation difficulty:** Medium
- **Potential edge:** Low on liquid universe
- **Evidence class:** Proven evidence (WP)
- **Test status:** UNTESTED

## R-022

- **Source:** https://cris.fau.de/publications/216708387 (verified via web search this session)
- **Author:** T. Fischer, C. Krauss, A. Deinert
- **Date:** 2019, JRFM
- **Hypothesis:** Random forest on lagged returns predicts 120-min cross-sectional outperformance
- **Market:** Spot
- **Asset:** 40 coins
- **Timeframe:** Minutes
- **Data required:** Minute bars
- **Methodology:** Random forest, OOS
- **Reported result:** ~7.1 bp/day after 15bp half-turn costs
- **Known weaknesses:** Very short OOS (Jun-Sep 2018); capacity
- **Crypto relevance:** Medium
- **Implementation difficulty:** High
- **Potential edge:** Low
- **Evidence class:** Hypothesis (weak OOS)
- **Test status:** UNTESTED

## R-023

- **Source:** https://research.birmingham.ac.uk/en/publications/bitcoin-intraday-time-series-momentum/ (verified via web search this session)
- **Author:** D. Shen, A. Urquhart, P. Wang
- **Date:** 2022, Financial Review
- **Hypothesis:** First half-hour return predicts last half-hour (volume-defined trading day)
- **Market:** Spot
- **Asset:** BTC
- **Timeframe:** 30-min
- **Data required:** Intraday prices and volume
- **Methodology:** Predictive regression
- **Reported result:** Significant intraday momentum, strongest in high vol/volume periods
- **Known weaknesses:** Session definition arbitrary in 24/7 market
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium
- **Potential edge:** Low-Medium
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-024

- **Source:** https://epub.ub.uni-muenchen.de/97651/ (verified via web search this session)
- **Author:** LMU Munich repository (authors not confirmed)
- **Date:** n.d.
- **Hypothesis:** Negative first-order autocorrelation at 1-4h horizons in BTC (mean reversion)
- **Market:** Spot
- **Asset:** BTC
- **Timeframe:** 1-4h
- **Data required:** Hourly bars
- **Methodology:** Autocorrelation, simple strategy
- **Reported result:** Systematic short-term mean reversion linked to overreaction and leveraged liquidations
- **Known weaknesses:** Details unverified; costs
- **Crypto relevance:** High (hourly data in repo)
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Hypothesis
- **Test status:** UNTESTED

## R-025

- **Source:** https://econpapers.repec.org/RePEc:eee:ecofin:v:57:y:2021:i:c:s1062940821000590 (verified via web search this session)
- **Author:** O. Borgards
- **Date:** 2021, NAJEF
- **Hypothesis:** Crypto momentum periods longer and more frequent than equities, inter- and intraday
- **Market:** Spot
- **Asset:** 20 coins
- **Timeframe:** Intraday/daily
- **Data required:** Prices
- **Methodology:** Dynamic momentum detection
- **Reported result:** Larger, longer momentum periods
- **Known weaknesses:** In-sample characterization
- **Crypto relevance:** Medium
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-026

- **Source:** https://essuir.sumdu.edu.ua/handle/123456789/82572 (verified via web search this session) (link-to-paper mapping uncertain)
- **Author:** G. Caporale, A. Plastun
- **Date:** 2020, FMPM
- **Hypothesis:** On abnormal-return days, hourly returns continue in the same direction (intraday momentum)
- **Market:** Spot
- **Asset:** BTC, ETH, LTC
- **Timeframe:** Hourly/daily
- **Data required:** Hourly bars
- **Methodology:** Event study on abnormal-return days
- **Reported result:** Momentum within abnormal days
- **Known weaknesses:** Mostly same-day effect; detection timing
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-027

- **Source:** https://www.hse.ru/en/news/research/559533243.html (verified via web search this session)
- **Author:** V. Dobrynskaya (HSE)
- **Date:** n.d.
- **Hypothesis:** Crypto momentum is short-lived and reverses at longer horizons
- **Market:** Spot
- **Asset:** Coins >$1M cap
- **Timeframe:** Weekly
- **Data required:** Prices
- **Methodology:** Many lookback/holding combos (1-12w holds)
- **Reported result:** Short-horizon momentum then reversal (per news summary; details unverified)
- **Known weaknesses:** News summary only
- **Crypto relevance:** Medium
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Hypothesis
- **Test status:** UNTESTED

## R-028

- **Source:** https://doi.org/10.21314/JCF.2016.322 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** D. Bailey, J. Borwein, M. Lopez de Prado, Q. Zhu
- **Date:** 2016/2017, J. Computational Finance
- **Hypothesis:** Probability of Backtest Overfitting via CSCV
- **Market:** Method
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** All strategy trial returns
- **Methodology:** Combinatorially symmetric CV
- **Reported result:** PBO estimator
- **Known weaknesses:** Requires every trial to be recorded
- **Crypto relevance:** High (process)
- **Implementation difficulty:** Low
- **Potential edge:** Process
- **Evidence class:** Proven evidence (method)
- **Test status:** CHECK src/engine/validation (outside this scan)

## R-029

- **Source:** https://doi.org/10.3905/jpm.2014.40.5.094 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** D. Bailey, M. Lopez de Prado
- **Date:** 2014, JPM
- **Hypothesis:** Deflated Sharpe Ratio corrects for multiple trials and non-normality
- **Market:** Method
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Trial SR stats
- **Methodology:** DSR
- **Reported result:** Method
- **Known weaknesses:** Needs trial count/variance
- **Crypto relevance:** High (process)
- **Implementation difficulty:** Low
- **Potential edge:** Process
- **Evidence class:** Proven evidence (method)
- **Test status:** CHECK src/engine/validation

## R-030

- **Source:** https://doi.org/10.1093/rfs/hhv059 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** C. Harvey, Y. Liu, H. Zhu
- **Date:** 2016, RFS
- **Hypothesis:** New factors need t-stat > ~3.0 given multiple testing
- **Market:** Equities
- **Asset:** Factors
- **Timeframe:** Any
- **Data required:** Factor returns
- **Methodology:** Multiple-testing adjustments
- **Reported result:** Many published factors likely false positives
- **Known weaknesses:** Hurdle depends on assumed number of tests
- **Crypto relevance:** High (process)
- **Implementation difficulty:** Low
- **Potential edge:** Process
- **Evidence class:** Proven evidence
- **Test status:** UNTESTED

## R-031

- **Source:** https://doi.org/10.1111/1468-0262.00152 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** H. White
- **Date:** 2000, Econometrica
- **Hypothesis:** Reality Check for data snooping
- **Market:** Method
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Strategy returns
- **Methodology:** Bootstrap
- **Reported result:** Method
- **Known weaknesses:** Conservative when poor models included
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Process
- **Evidence class:** Proven evidence (method)
- **Test status:** UNTESTED

## R-032

- **Source:** https://doi.org/10.1198/073500105000000063 (URL/DOI from prior knowledge, NOT re-verified this session)
- **Author:** P. Hansen
- **Date:** 2005, JBES
- **Hypothesis:** SPA test improves Reality Check power
- **Market:** Method
- **Asset:** Any
- **Timeframe:** Any
- **Data required:** Strategy returns
- **Methodology:** Studentized bootstrap
- **Reported result:** Method
- **Known weaknesses:** -
- **Crypto relevance:** High
- **Implementation difficulty:** Low
- **Potential edge:** Process
- **Evidence class:** Proven evidence (method)
- **Test status:** UNTESTED

## R-033

- **Source:** https://quantpedia.com/a-very-influential-paper-about-tether-bitcoin-relationship-manipulation/ (verified via web search this session)
- **Author:** J. Griffin, A. Shams (summary via Quantpedia)
- **Date:** 2018-2020 (J. Finance 2020 per prior knowledge)
- **Hypothesis:** Tether issuance follows BTC declines and supports prices
- **Market:** Spot/on-chain
- **Asset:** BTC, USDT
- **Timeframe:** Hourly/daily
- **Data required:** USDT flows on-chain
- **Methodology:** Flow clustering, regressions
- **Reported result:** Returns correlated with Tether creation (2017-2018)
- **Known weaknesses:** Contested (Wei 2018 VAR finds insignificant); old sample
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium
- **Potential edge:** Low-Medium
- **Evidence class:** Proven evidence (contested)
- **Test status:** UNTESTED

## R-034

- **Source:** https://www.blockchainresearchlab.org/wp-content/uploads/2020/05/The_Influence_of_Stablecoin_Issuances_on_Cryptocurrency_Markets_BRL_Working_Paper_No_11.pdf (verified via web search this session)
- **Author:** Blockchain Research Lab
- **Date:** 2020 WP No. 11
- **Hypothesis:** Stablecoin issuances follow downturns; positive abnormal returns +/-24h around issuance
- **Market:** Spot/on-chain
- **Asset:** Majors, 7 stablecoins
- **Timeframe:** Hourly/daily
- **Data required:** Mint events
- **Methodology:** Event study (565 events >= $1M)
- **Reported result:** Positive abnormal returns around issuance
- **Known weaknesses:** Anticipation ambiguous; WP
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium
- **Potential edge:** Medium
- **Evidence class:** Hypothesis
- **Test status:** UNTESTED

## R-035

- **Source:** https://studio.glassnode.com/charts/cc2701e8-b9f4-4508-4d71-af5a71c00683 (verified via web search this session)
- **Author:** Glassnode
- **Date:** ongoing
- **Hypothesis:** Exchange inflows (esp. short-term holders) signal selling pressure
- **Market:** On-chain
- **Asset:** BTC
- **Timeframe:** Daily
- **Data required:** Labeled exchange flows (vendor)
- **Methodology:** Descriptive metrics
- **Reported result:** No rigorous OOS claim
- **Known weaknesses:** Label coverage incomplete; vendor-dependent
- **Crypto relevance:** Medium
- **Implementation difficulty:** Medium (paid data)
- **Potential edge:** Low-Medium
- **Evidence class:** Marketing claim / Opinion
- **Test status:** UNTESTED

## R-036

- **Source:** https://blog.kaiko.com/sell-off-continues-following-liquidation-cascade-cb1a90ad8443 (verified via web search this session)
- **Author:** Kaiko Research
- **Date:** 2021-09
- **Hypothesis:** Rising OI raises cascade vulnerability; book depth vanishes in sell-offs
- **Market:** Perps/spot
- **Asset:** BTC
- **Timeframe:** Intraday
- **Data required:** OI, order book depth
- **Methodology:** Descriptive
- **Reported result:** Qualitative
- **Known weaknesses:** Single-event narrative
- **Crypto relevance:** High
- **Implementation difficulty:** Medium (needs OI)
- **Potential edge:** Medium
- **Evidence class:** Opinion (practitioner)
- **Test status:** UNTESTED

## R-037

- **Source:** https://blog.amberdata.io/how-3.21b-vanished-in-60-seconds-october-2025-crypto-crash-explained-through-7-charts (verified via web search this session)
- **Author:** Amberdata
- **Date:** 2025-10
- **Hypothesis:** Liquidation intensity above ~5% of OI triggers further forced selling
- **Market:** Perps
- **Asset:** BTC/majors
- **Timeframe:** Minutes
- **Data required:** OI, liquidations
- **Methodology:** Descriptive
- **Reported result:** Threshold claim
- **Known weaknesses:** Vendor claim; OI figures inconsistent across sources
- **Crypto relevance:** High
- **Implementation difficulty:** Medium
- **Potential edge:** Medium
- **Evidence class:** Marketing claim
- **Test status:** UNTESTED

## R-038

- **Source:** https://ideas.repec.org/p/arx/papers/2608.03616.html (verified via web search this session)
- **Author:** arXiv preprint 2608.03616 (authors not confirmed)
- **Date:** 2026 (date inferred from ID, unconfirmed)
- **Hypothesis:** Liquidation cascades are self-exciting but subcritical (branching ratio ~0.1-0.2)
- **Market:** Perps
- **Asset:** Majors
- **Timeframe:** Seconds-minutes
- **Data required:** On-chain fills
- **Methodology:** Branching-ratio / Hawkes-type estimation
- **Reported result:** Subcritical in 7 large events 2022-2025
- **Known weaknesses:** Small event count; preprint
- **Crypto relevance:** High
- **Implementation difficulty:** High
- **Potential edge:** Medium
- **Evidence class:** Hypothesis (preprint)
- **Test status:** UNTESTED

## R-039

- **Source:** https://coinshares.com/insights/knowledge/billions-in-liquidations-what-happened/ (verified via web search this session)
- **Author:** CoinShares
- **Date:** 2025-10
- **Hypothesis:** Cascades are liquidity crises, not fundamental repricing (implies post-cascade reversal)
- **Market:** Perps
- **Asset:** Majors
- **Timeframe:** Hours-days
- **Data required:** Prices, OI
- **Methodology:** Commentary
- **Reported result:** Qualitative
- **Known weaknesses:** Commentary
- **Crypto relevance:** High
- **Implementation difficulty:** Low (proxy via price/volume)
- **Potential edge:** Medium
- **Evidence class:** Opinion
- **Test status:** UNTESTED

## R-040

- **Source:** Jegadeesh (1990) J. Finance 45(3); Lehmann (1990) QJE 105(1) (URL/DOI from prior knowledge, NOT re-verified this session) (no URL)
- **Author:** N. Jegadeesh; B. Lehmann
- **Date:** 1990
- **Hypothesis:** Short-term (1 week/1 month) cross-sectional reversal from liquidity provision
- **Market:** Equities
- **Asset:** Stocks
- **Timeframe:** Weekly/monthly
- **Data required:** Prices
- **Methodology:** Contrarian portfolios
- **Reported result:** Significant reversal profits pre-costs
- **Known weaknesses:** Costs; crypto weekly horizon often shows momentum instead
- **Crypto relevance:** Medium
- **Implementation difficulty:** Low
- **Potential edge:** Low-Medium
- **Evidence class:** Proven evidence (equities)
- **Test status:** UNTESTED

## R-041

- **Source:** Hurst, Ooi, Pedersen, 'A Century of Evidence on Trend-Following Investing', J. Portfolio Mgmt 2017 (URL/DOI from prior knowledge, NOT re-verified this session) (no URL)
- **Author:** B. Hurst, Y. Ooi, L. Pedersen (AQR)
- **Date:** 2017
- **Hypothesis:** Trend following robust over 100+ years with crisis alpha
- **Market:** Futures
- **Asset:** Multi-asset
- **Timeframe:** Monthly
- **Data required:** Futures
- **Methodology:** TSMOM backtest
- **Reported result:** Positive in every decade studied
- **Known weaknesses:** Practitioner (manager) source
- **Crypto relevance:** Medium
- **Implementation difficulty:** Low
- **Potential edge:** Medium
- **Evidence class:** Proven evidence (practitioner)
- **Test status:** PARTIALLY TESTED (trend.py, breakout.py)

## R-042

- **Source:** https://alphaarchitect.com/factors-investing-in-cryptocurrency/ (verified via web search this session)
- **Author:** Alpha Architect (summary of Liu-Tsyvinski-Wu)
- **Date:** 2022
- **Hypothesis:** Crypto factor investing practical summary
- **Market:** Spot
- **Asset:** Broad
- **Timeframe:** Weekly
- **Data required:** Prices
- **Methodology:** Secondary summary
- **Reported result:** Restates LTW findings
- **Known weaknesses:** Secondary source
- **Crypto relevance:** Medium
- **Implementation difficulty:** Low
- **Potential edge:** -
- **Evidence class:** Opinion (secondary)
- **Test status:** N/A
