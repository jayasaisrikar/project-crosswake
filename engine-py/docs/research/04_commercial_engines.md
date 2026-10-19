# 04 — Retail / commercial engines: what they do, documented records, failure modes

All entries are [K] (prior knowledge) unless marked otherwise. Verify before quoting externally.

| Tool | What it is | Typical strategies | Documented live record | Failure modes |
|---|---|---|---|---|
| Freqtrade | Open-source Python bot: backtest, hyperopt, live | TA indicator strategies (RSI, EMA cross, Bollinger) tuned with `hyperopt` | No aggregated official record; community repos publish backtests only | Hyperopt is multiple testing at scale; same-candle look-ahead. Freqtrade ships `lookahead-analysis` and `recursive-analysis` commands to catch it (verify at https://www.freqtrade.io/en/stable/lookahead-analysis/) |
| Jesse | Open-source Python framework | The same TA family, plus genetic optimisation | None published | Optimisation over small samples |
| Hummingbot | Open-source market-making and arbitrage bot | Pure MM, cross-exchange MM, AMM arbitrage | PnL is often driven by liquidity-mining rewards rather than spread capture | Adverse selection, inventory risk, latency against professional MMs |
| 3Commas | SaaS DCA, grid and signal bots | DCA (martingale-style averaging), grid | No audited aggregate. A Dec 2022 API-key leak led to unauthorised trades on user accounts | DCA and grid are short volatility and blow up in trends; API-key custody risk |
| Cryptohopper | SaaS strategy marketplace and copy-trading | Marketplace TA strategies, DCA | Sellers show backtests; no audited live stats | Selection and survivorship bias among sellers |
| Telegram / Discord signal groups | Paid "VIP" calls | Discretionary entries with TP/SL ladders | Xu & Livshits (USENIX Security 2019) on pump-and-dump groups: organisers profit at followers' expense. https://www.usenix.org/conference/usenixsecurity19/presentation/xu-jiahua | Cherry-picked screenshots, admins front-running followers, no auditable record |

## Takeaways for our engine
- The retail stack tunes indicators per coin and per timeframe. That is exactly the overfitting process in 03.
- Grid and DCA bots have a positive median outcome and catastrophic tails (short gamma), the opposite profile to
  trend.
- No tool surveyed offers better evidence than vol-scaled trend, and none publishes an audited live Sharpe.
