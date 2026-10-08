# Crosswake

**Crypto trade signals backed by evidence, not hype.**

Most signal groups post calls with no proof behind them. Crosswake works the other way around. A strategy has to prove itself on market data it has never seen before it ever reaches a user.

## What we do

Bitcoin moves the crypto market. When BTC trends, most altcoins follow, but not all at once and not equally. Crosswake watches that relationship across 30 major coins. It looks for altcoins that are starting to move with real strength, then turns that into a clear signal: **what to buy, when, and when to exit.**

- **Simple signals:** a coin, an entry and an exit rule, delivered to a live dashboard and our Telegram channel.
- **Market updates every 4 hours:** a short Telegram post on where the major coins stand, so followers have context between signals.
- **Built for real people:** a trade lasts days to weeks, so there's time to act. This isn't high-frequency trading.
- **Honest numbers:** every result includes trading fees and slippage, and we publish what failed as well as what worked.

## The strategy

**Ride strong altcoins, but only when Bitcoin is in an uptrend.**

1. **Market check:** trade only while Bitcoin is above its 100-day average. When the market turns, we step aside.
2. **Entry:** buy a coin when it breaks above its highest price of the last 20 days.
3. **Exit:** sell when it falls below its lowest price of the last 10 days. That cuts losers quickly and lets winners run.

It's designed to win about 1 trade in 3, with each winner much larger than each loser. That's the profile of classic trend following.

### Results so far

| | Trades | Win rate | Average winner | Average loser |
|---|---|---|---|---|
| 2020–2024 | 910 | 43% | +43% | −8.5% |
| 2025–2026, unseen data | 243 | 34% | +19% | −7.3% |

All figures are after fees.

The rules were locked before testing and never adjusted to fit the results. On 2025–2026 data the strategy had never seen, it stayed profitable on average, at **+1.5% per trade**. It is now being tracked live to confirm the edge holds up in real time.

## What's running live

Every strategy below runs around the clock on our server as paper trading: signals are recorded and scored, but no real orders are placed.

| Version | What it trades | Why it's running |
|---|---|---|
| **v005** | The daily trend strategy above, on 28 established coins | Live confirmation of the tested edge, from 1 Oct 2026 |
| **v006** | The same rules, unchanged, on 36 coins including HYPE and other newer listings | More coins means more signals. Most new coins lack enough history to test, so it's judged on live results only, from 9 Oct 2026 |
| **v007** | BTC, ETH and SOL futures: 15-minute RSI rebounds taken in the direction of the 4-hour trend | A faster strategy that **failed** its test (see below). It runs for observation only |

## Telegram market updates

Alongside trade signals, the Telegram channel gets a short market update about 5 minutes after every 4-hour candle closes (00:05, 04:05, 08:05 UTC and so on).

- **What it covers:** BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK and HYPE. For each it gives the price, 4-hour momentum (RSI and MACD from altFINS), how many coins are strong or weak, and what our own strategies are holding.
- **How it's written:** our software works out every number. An AI model then turns those facts into a readable post. If the draft contains any number that isn't in the data, any price prediction or trade call, or no disclaimer, it is thrown away and a plain fact-only version goes out instead.
- **What it isn't:** these posts are market context, not buy or sell calls. Trade signals come only from the tested strategies above.

## How we got here

We tested and rejected three faster strategies before this one, including signals that tried to profit from altcoins lagging Bitcoin by seconds or hours. They either moved too fast for a person to act on or lost money after fees.

In October 2026 we tested a fourth, a popular short-term futures setup (v007). Its rules were locked before any data was fetched. On 2025–2026 data it made only 32 trades in 21 months, won 28% of them, and lost 0.15× its risk per trade after fees and funding. It fails, and we say so.

Discarding ideas that don't hold up is the core of the product.

## Status

| Stage | |
|---|---|
| Data collection and research engine | ✅ Live |
| Signal dashboard | ✅ Live |
| 24/7 hosting | ✅ Live on our server |
| Strategy validation | 🟡 Live paper tracking (v005, v006, v007) |
| Telegram signal alerts | ✅ Live (paper signals) |
| Telegram market updates | ✅ Live, every 4 hours |

---

*Crosswake is research software. Signals are not financial advice, and past performance doesn't guarantee future results.*

<sub>Developers: see the [technical reference](docs/reference.md).</sub>
