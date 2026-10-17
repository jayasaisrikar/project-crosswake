# v008 · Trend + cross-sectional momentum on perps

**Status:** frozen 17 Oct 2026, live paper from 18 Oct 2026. Judged on live paper only.

## The idea

Two slow, well-documented crypto return patterns, held together in one book on Binance USDT perps:

- **Trend (time-series momentum):** for each coin, average the sign of its 20-, 60- and 120-day returns. Size each coin by 1 / its volatility. Go long when the score is positive and short when it's negative. This is directional, and it tends to get out of crashes.
- **Cross-sectional momentum** (Liu, Tsyvinski & Wu, _Common Risk Factors in Cryptocurrency_): once a week, rank coins by their 30-day return, skipping the latest day. Go long the top third and short the bottom third with equal dollars on each side. This is market-neutral.

Each half is scaled to 20% annual volatility from its own trailing 30-day returns, then capped at 25% per coin and 2× gross. The book holds 50% of each.

These sleeves trade slowly (daily and weekly), so a few bps of cost per trade doesn't eat the edge the way it did for v001–v004 and v007.

## Why there is no clean backtest

The rules come unchanged from the engine-py research lab (Mohan's `python-engine` branch): the `trend` and `xsmom` blocks of `experiment.yaml`, with xsmom being experiment EXP-000015. That lab has already evaluated both sleeves on 2024-07 to 2026-09, including the H2 window from 1 Oct 2025 that it otherwise keeps sealed (`research/contract.py`). **No historical period is out-of-sample for these rules.** Opening H2 again would not be a real test.

So v008 is judged the same way v006 is: on **live paper only**, from the forward start.

## Rules

| Rule            | Value                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Universe        | 37 Binance USDT perps (the engine-py v002 list)                                                         |
| Trend score     | Mean of sign(20d, 60d, 120d return)                                                                     |
| Trend sizing    | Score / 30-day vol, rebalanced daily                                                                    |
| Cross-sectional | 30-day return skipping 1 day; top third long, bottom third short, equal weight; rebalanced every 7 days |
| Risk            | Each sleeve scaled to 20% annual vol; ≤ 25% per coin; ≤ 2× gross                                        |
| Allocation      | 50% trend, 50% cross-sectional                                                                          |
| Fill            | Decided on the 00:00 UTC daily close, held from the next daily open                                     |
| Costs           | 7 bps per side on every change in weight (5 bps taker + ~2 bps half-spread)                             |

**Changes from engine-py:** Crosswake uses daily bars, not hourly. Volatility comes from daily returns, and fills are at the next daily open.

## Pass criteria (fixed before any live data)

After at least **90 days** of live paper:

- book Sharpe above **0.5**;
- **each** sleeve's Sharpe above 0;
- max drawdown under **25%**;
- positive annualised alpha against an equal-weight, daily-rebalanced long of the same coins.

Anything less is a FAIL, and v008 is retired, not retuned. Even a PASS only means "worth continuing on paper": a Sharpe near 1 measured over a few months has a standard error of about 1 or more.

## Reference backtest (NOT out-of-sample)

`pnpm momentum:test` replays the rules on Binance perp daily bars from 2021-01 to 2026-10. It is a sanity check that the code behaves like the engine-py result, not evidence of an edge. It also has survivorship bias, because the coin list is today's listed perps.

| 2021-01 → 2026-10      | CAGR       | Sharpe   | Max DD     |
| ---------------------- | ---------- | -------- | ---------- |
| **Book (1× costs)**    | **+10.1%** | **0.62** | **−20.6%** |
| Trend sleeve           | +13.8%     | 0.70     | −27.2%     |
| Cross-sectional sleeve | +4.5%      | 0.31     | −39.0%     |
| Equal-weight long      | +34.9%     | 0.78     | −80.2%     |
| Book (2× costs)        | +5.5%      | 0.38     | −21.5%     |

Alpha against equal-weight is about +14% a year at 1× costs (+10% at 2×), with a beta near 0.

| Year        | 2021  | 2022  | 2023   | 2024   | 2025   | 2026 YTD  |
| ----------- | ----- | ----- | ------ | ------ | ------ | --------- |
| Book return | +9.0% | +1.6% | +34.5% | +10.2% | +14.6% | **−7.2%** |

**Read honestly:**

- Most of the result comes from the trend sleeve. Cross-sectional momentum alone is weak here (Sharpe 0.31, −39% drawdown), much weaker than engine-py's 0.92. Its failing the "each sleeve > 0" test live would not be a surprise.
- The book is losing in 2026 so far.
- Costs matter: doubling them cuts the Sharpe from 0.62 to 0.38.
- Funding is **not** charged. A trend book that is net long in bull markets pays funding, so the real result is lower.

## Known gaps

- No funding charge in the simulation.
- No Telegram alerts yet: v008 writes its state and decisions to disk only.
- Daily bars only, so intraday moves between decisions aren't marked.

## Files and commands

- Plan: `configs/momentum-plan-v008.json`
- Engine: `packages/backtest/src/momentum.ts` · tests `tests/momentum-v008.test.ts`
- App: `apps/momentum/src/main.ts`
- `pnpm momentum:history` downloads perp daily bars to `data/perp1d/`.
- `pnpm momentum:test` runs the reference backtest and writes `data/research/momentum-perp-v008-reference.json`.
- `pnpm momentum:live` runs the daily paper step and writes `data/momentum/live/momentum-perp-v008/{state.json,decisions.jsonl}`. It is installed as the `signals-momentum-v008` service.
