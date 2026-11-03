# v011 — the standard a strategy has to clear

`trend-daily-v011` is frozen on 3 November 2026. It is the v005 breakout premise with two changes
and a harder gate. The changes exist because of what the record shows about v005, not because of
anything v011 has been allowed to see.

## Why this version exists

v005 was scored 3.5/10 as a signal and 8/10 as research. The gap between those numbers is v011's
whole reason for being:

- its average trade was +1.53% with a 95% confidence interval of **−2.9% to +6.3%**, which includes
  zero, so the edge was never demonstrated;
- one coin, ZEC, carried the result: without it the book returned **+0.08%** over 21 months;
- it was flat in most market regimes, so what it really proved is that a 100-day Bitcoin filter
  keeps you out of falling markets.

## What changes, and what does not

| | v005 | v011 |
|---|---|---|
| Entry | 20-day Donchian breakout, BTC above its 100-day SMA | unchanged |
| Exit | 10-day breakdown, or the regime turning off | unchanged |
| Universe | 29 alts + BTC, equal capital per slot | unchanged (so the two versions answer the same question) |
| Sizing | equal slot, 1/29 of capital | inverse volatility over 60 days, 20% book vol target, **8% cap per coin**, 100% gross cap |
| Judged on | unseen data 2025-01-01 to 2026-10-01 | **live paper only**, from 2026-11-03 |

Inverse-volatility sizing is the single lever that can stop one coin from deciding the verdict,
and it is the only rule change. Everything else is held identical on purpose: a version that
changes rules and gate at once cannot say which one moved the number.

## The gate

`packages/backtest/src/portfolio-gate.ts` — five things, all numeric, all published in advance:

| Check | Threshold | Reason code |
|---|---|---|
| Enough trades to say anything | ≥ 40 closed | `insufficient_closed_trades` |
| Average net per trade | ≥ +50 bps | `expectancy_below_target` |
| Confidence interval, symbol-clustered, 10 000 resamples | lower bound **> 0** | `expectancy_confidence_inconclusive` |
| Breadth | ≥ 6 symbols profitable on their own | `symbol_breadth` |
| Concentration | no symbol > 25% of gross absolute PnL | `pnl_concentration` |
| Drawdown, capital-normalised | ≤ 20% | `drawdown_limit` |
| Regimes | every BTC up/down segment inside the window is scored; ≥ 60% must be positive | `regime_instability` |

A missing regime split fails the gate (`regime_split_unavailable`). So does an open position
(`unfinished_positions`). Nothing here passes by being absent.

## The gate against v005, which is what makes it worth having

Replayed over v005's own 243 trades, split into the 12 BTC up/down segments it actually traded:

| Check | v005 result | Verdict |
|---|---|---|
| Trades | 243 | pass |
| Average net | +153 bps | pass |
| CI 95, symbol-clustered | **−99 to +506 bps** | **fail** |
| Profitable symbols | 14 of 29 | pass |
| Largest symbol share | **35.4%** (ZEC) | **fail** |
| Drawdown of capital | 10.8% | pass |
| Positive regimes | **3 of 12 (25%)** | **fail** |

Three failures, on exactly the three weaknesses the public record already admitted. A gate that
v005 passes would have been decoration.

## Delivery

From 3 November 2026 v011 is the engine behind the daily Telegram channel: `signals-daily` runs
`configs/trend-plan-v011.json` with delivery on. v005 and v006 keep running on paper with
`TELEGRAM_ENABLED=false` so their live records stay comparable, but they no longer post — three
correlated alerts for one breakout is noise. `signals-daily-v005` was added as its own unit for
that. Any signal v011 posts carries its size, because the sizing is the rule that changed.

## Dependability, which is not the same as profitability

The failure Jay hit was not a losing strategy, it was a *silent* one: an engine whose model had
been retired, a page that showed zero notes, a chart dated two weeks ago. That is now checked
rather than assumed:

- `packages/research-runtime/src/freshness.ts` scores a published record: age, collector
  connection, feed idleness, and every engine's heartbeat. A quiet engine is named
  (`engine_silent:<id>`), never rendered as flat.
- `pnpm record:freshness` runs it against `data/public/record.json` or a `--url=` mirror and exits
  non-zero on any problem, so a timer or a cron can act on it.
- The record is mirrored to the public signal-log repository every 15 minutes when it changes, so
  a site read does not depend on one tunnel being healthy.

## What "10/10" can and cannot mean here

This is the part worth being blunt about. Four of the five axes can be 10/10 today, by
construction:

- **Measurement** — frozen rules, pre-registered gate, symbol-clustered bootstrap, no retuning.
- **Breadth** — enforced, not hoped for.
- **Dependability** — heartbeat, freshness, mirror, alarms.
- **Honesty** — the failures publish before the successes.

The fifth, **the edge**, cannot be assigned by anyone at freeze time, including this document.
Anyone who hands you a 10/10 strategy rating before the judgement window closes is describing
their marketing, not a result. v011's edge rating is *unscored* until the live gate runs, and the
honest output of that run may well be a fail that gets published in full.

## Retirement

A version is retired on any of: a failed gate verdict, seven consecutive days without an engine
heartbeat, or a published signal that cannot be reproduced from the frozen rules and the recorded
bars. Retired versions keep their page and their numbers.
