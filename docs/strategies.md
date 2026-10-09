# Strategy catalog

Every strategy Crosswake has built or tested gets a version number (v001, v002, …). A version's rules are frozen before it is tested. If a rule changes, the result is a new version, tested on data it hasn't seen. Failed versions stay listed here.

All results are after fees and slippage. Every strategy is **paper only**: signals are recorded and scored, but no real orders are placed.

## At a glance

| Version | Idea | Market | Timeframe | Status |
|---|---|---|---|---|
| v001 | Alts lag BTC by seconds: buy the laggard | Spot | Seconds–minutes | ❌ Retired: lag too short to act on |
| v002 | v001 with entry delay and forward-return model | Spot | 1–5 minutes | ❌ Retired: no tradable signals |
| v003 | Alt lagged BTC over 1–4h: buy the catch-up | Spot / pair | Hours | ❌ Failed test |
| v004 | Alt held up while BTC fell: short the catch-down | Perps | 4 hours | ❌ Failed test |
| **v005** | **Daily 20-day breakout while BTC is in an uptrend** | **Spot** | **Days–weeks** | 🟡 **Live paper, main strategy** |
| v006 | v005 rules on a wider coin list (HYPE and newer coins) | Spot | Days–weeks | 🟡 Live paper only |
| v007 | 15m RSI rebound in the 4h trend direction | Perps | Hours | ❌ Failed test, paper for observation |

## How a strategy is judged

1. **Freeze** the rules in a `configs/*.json` plan, with a written hypothesis and pass/fail criteria, before fetching any test data.
2. **Develop** on an early period, then **test** once on a later period the rules have never seen.
3. **Pass gate:** enough trades, positive expectancy whose 95% confidence interval stays above zero, and a minimum profit factor. Win rate is reported, but a 30–50% win rate is fine when winners are much larger than losers.
4. **Live paper** from the freeze date onward, as fresh unseen data.

---

## v005 · Daily trend breakout (main strategy)

**In plain words:** buy a coin when it breaks to a new 20-day high, but only while Bitcoin is in an uptrend. Sell when it falls to a new 10-day low. Most trades lose a little; a few big winners pay for them.

| Rule | Value |
|---|---|
| Market filter | BTC daily close above its 100-day average |
| Entry | Coin's daily close above its highest close of the prior 20 days |
| Exit | Daily close below the prior 10-day low, or BTC filter turns off |
| Fill | Next day's open (signal at 00:00 UTC close) |
| Sizing | One position per coin, equal size, long only |
| Costs | 30 bps round trip |
| Coins | 29 alts + BTC, including pairs later delisted (no survivorship bias) |

**Results**

| Period | Trades | Win rate | Avg winner | Avg loser | Net / trade | 95% CI | Profit factor |
|---|---|---|---|---|---|---|---|
| Development 2020–2024 | 910 | 43.3% | +43% | −8.5% | +13.9% | [+6.2%, +23.3%] | 3.86 |
| **Test 2025-01 → 2026-09** | **243** | **33.7%** | +19% | −7.3% | **+1.5%** | [−2.9%, +6.3%] | 1.32 |

**Verdict:** profitable on unseen data, but the confidence interval includes zero, so the edge isn't proven. The test had only 33 independent entry-weeks, which makes it underpowered rather than disproven. Development results lean heavily on the 2020–21 bull market. Live paper tracking started 1 Oct 2026.

**Files:** `configs/trend-plan-v005.json` · engine `packages/backtest/src/trend.ts` · live `apps/trend/src/main.ts`

## v006 · Daily trend breakout, wider universe

**In plain words:** exactly the v005 rules, applied to 36 coins including HYPE, SUI, ENA, TAO, JUP, WLD, SEI and PUMP. More coins means more signals.

- **Why it's separate:** most new coins have under 3 years of history, so there's no meaningful backtest. v006 is judged on **live paper only**, from 9 Oct 2026.
- **Universe changes:** EOS and MATIC dropped (no longer traded on Binance spot). A coin becomes tradable once it has 20 daily closes.
- **Pass gate:** same as v005 (200+ closed trades, 30–50% win rate, profit factor ≥ 1.2, CI above zero), measured on live paper.
- v005 keeps running unchanged alongside it.

**Files:** `configs/trend-plan-v006.json`

## v007 · 15m RSI rebound with the 4h trend (failed)

**In plain words:** on BTC, ETH and SOL futures, wait for a clean 4-hour trend. Then go long when the 15-minute RSI bounces back out of oversold (or short when it drops back from overbought), in the trend's direction.

| Rule | Value |
|---|---|
| Trend filter (4h) | EMA 20 vs EMA 50 at least 0.3% apart, ADX ≥ 20 |
| Long entry (15m) | RSI(14) crosses back above 30, price above session VWAP |
| Short entry (15m) | RSI(14) crosses back below 70, price below session VWAP |
| Funding guard | Skip if funding is more than 0.05% against the trade |
| Stop | Tighter of the dip's swing point and 1.2× ATR, at most 1.2% away |
| Management | 50% off at 1.5R, stop to breakeven after 1R, trailing stop after scale-out |
| Time stop | Exit after 16 bars (4h) if 1.5R isn't reached |
| Costs | 10 bps round trip plus funding |

**Results**

| Period | Trades | Win rate | Net / trade | 95% CI | Profit factor |
|---|---|---|---|---|---|
| Development 2022–2024 | 76 | — | −0.12R | — | — |
| **Test 2025-01 → 2026-09** | **32** (needed 200) | **28%** | **−0.15R** | [−0.73R, +0.47R] | 0.79 |

**Verdict:** fails. The stacked filters produce about 1.5 trades a month across three coins, and costs eat roughly 0.2R per trade because the stops are tight (~0.55%). It still loses at 5 bps costs (−0.04R). It runs as paper for observation only and won't be retuned.

**Files:** `configs/htf-rsi-plan-v007.json` · live `apps/htf/src/main.ts` · results `data/research/htf-rsi-v007.json`

---

## Retired research (v001–v004)

These tested the original idea: **altcoins follow Bitcoin with a delay, so trade the laggard.**

### v001 · Seconds-scale lead-lag

Buy an alt right after BTC jumps, before the alt catches up. **Finding:** on second-level data, ETH and SOL react to BTC within 1–3 seconds. By the time a person sees a signal, the move is over. Live shadow runs produced zero signals. Files: `configs/catch-up-v001.json`, `configs/research-plan-v001.json`.

### v002 · Executable lead-lag

v001 redesigned around a realistic entry delay (30s), a forward-return model and cost-aware targets. **Finding:** to clear costs at 2:1 reward/risk it needed about a 2.5% move forecast in 5 minutes, which almost never happens. No tradable signals. Files: `configs/forward-v002.json`, [`signal-improvements-v002.md`](signal-improvements-v002.md).

### v003 · Hour-scale residual catch-up

When BTC rallied over 2 hours and an alt lagged its usual BTC-implied move, buy the alt (spot) or the alt against BTC (pair), and hold up to 4 hours. **Finding:** every one of 36 variants lost money in-sample. Out of sample, the spot plan never reached 30 trades and the pair plan made −0.43% per trade (37.5% wins). Win rates were fine, but the winners were too small. Files: `configs/residual-*-v003.json`, [`residual-strategy-v003.md`](residual-strategy-v003.md).

### v004 · Catch-down short

The mirror case on perps: short an alt that held up while BTC fell. Rules pre-registered before any data was loaded. **Finding:** 349 trades, 40.7% wins, −0.46% per trade (CI −0.71% to −0.18%). Fails clearly. Files: `configs/catchdown-perp-v004.json`, `configs/catchdown-plan-v004.json`.

**Lesson from v001–v004:** "alts lag BTC" is real but too fast for humans, and at slower speeds it doesn't pay after costs. That's what led to the daily trend approach in v005.

---

*Research software. Signals are not financial advice, and past performance doesn't guarantee future results.*
