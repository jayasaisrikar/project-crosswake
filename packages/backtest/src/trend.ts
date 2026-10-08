/** Daily Donchian breakout with a BTC regime filter (v005). Pure and causal: signals use closes up to day t, fills at day t+1 open. */
export interface DailyBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface TrendRules {
  breakoutDays: number;
  breakdownDays: number;
  regimeSmaDays: number;
  costBpsRoundTrip: number;
}
export interface TrendTrade {
  symbol: string;
  entryTs: number;
  exitTs: number;
  entry: number;
  exit: number;
  netBps: number;
  reason: 'breakdown' | 'regime' | 'open';
}
const DAY = 86_400_000;

/** BTC-above-SMA by day timestamp; the value for day t is known at t's close. */
export function regimeByDay(btc: DailyBar[], smaDays: number) {
  const on = new Map<number, boolean>();
  let sum = 0;
  btc.forEach((b, i) => {
    sum += b.close;
    if (i >= smaDays) sum -= btc[i - smaDays]!.close;
    if (i >= smaDays - 1) on.set(b.ts, b.close > sum / smaDays);
  });
  return on;
}

export function runTrend(
  symbol: string,
  bars: DailyBar[],
  regime: Map<number, boolean>,
  rules: TrendRules,
  includeOpen = false,
): TrendTrade[] {
  const trades: TrendTrade[] = [];
  let pos: { entryTs: number; entry: number } | null = null;
  for (let i = rules.breakoutDays; i + 1 < bars.length; i++) {
    const bar = bars[i]!,
      next = bars[i + 1]!;
    // A calendar gap (delisting, outage) ends any position at the last known close.
    if (next.ts - bar.ts !== DAY) {
      if (pos) {
        trades.push(close(symbol, pos, bar.ts, bar.close, 'breakdown', rules));
        pos = null;
      }
      continue;
    }
    const regimeOn = regime.get(bar.ts) === true;
    if (pos) {
      const low = Math.min(
        ...bars.slice(i - rules.breakdownDays, i).map((b) => b.close),
      );
      const reason =
        bar.close < low ? 'breakdown' : !regimeOn ? 'regime' : null;
      if (reason) {
        trades.push(close(symbol, pos, next.ts, next.open, reason, rules));
        pos = null;
      }
    } else if (regimeOn) {
      const high = Math.max(
        ...bars.slice(i - rules.breakoutDays, i).map((b) => b.close),
      );
      if (bar.close > high) pos = { entryTs: next.ts, entry: next.open };
    }
  }
  if (pos && includeOpen) {
    const last = bars.at(-1)!;
    trades.push(close(symbol, pos, last.ts, last.close, 'open', rules));
  }
  return trades;
}
function close(
  symbol: string,
  pos: { entryTs: number; entry: number },
  exitTs: number,
  exit: number,
  reason: TrendTrade['reason'],
  rules: TrendRules,
): TrendTrade {
  return {
    symbol,
    entryTs: pos.entryTs,
    exitTs,
    entry: pos.entry,
    exit,
    netBps: (exit / pos.entry - 1) * 1e4 - rules.costBpsRoundTrip,
    reason,
  };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
/** Trade statistics with a bootstrap over entry-week clusters (correlated breakouts share a week). */
export function trendStats(trades: TrendTrade[], resamples = 10000, seed = 5) {
  const n = trades.length;
  if (!n) return null;
  const wins = trades.filter((t) => t.netBps > 0),
    losses = trades.filter((t) => t.netBps <= 0),
    sum = (x: TrendTrade[]) => x.reduce((a, t) => a + t.netBps, 0),
    weeks = new Map<number, TrendTrade[]>(),
    rand = rng(seed),
    means: number[] = [];
  for (const t of trades) {
    const w = Math.floor(t.entryTs / (7 * DAY));
    weeks.set(w, [...(weeks.get(w) ?? []), t]);
  }
  const clusters = [...weeks.values()];
  for (let r = 0; r < resamples; r++) {
    let s = 0,
      c = 0;
    for (let k = 0; k < clusters.length; k++) {
      const g = clusters[Math.floor(rand() * clusters.length)]!;
      s += sum(g);
      c += g.length;
    }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  const sorted = trades.map((t) => t.netBps).sort((a, b) => a - b);
  return {
    trades: n,
    winRate: wins.length / n,
    netExpectancyBps: sum(trades) / n,
    ci95: [
      means[Math.floor(resamples * 0.025)]!,
      means[Math.floor(resamples * 0.975)]!,
    ] as [number, number],
    profitFactor: losses.length ? sum(wins) / -sum(losses) : Infinity,
    avgWinBps: wins.length ? sum(wins) / wins.length : 0,
    avgLossBps: losses.length ? sum(losses) / losses.length : 0,
    medianBps: sorted[Math.floor(n / 2)]!,
    avgHoldDays:
      trades.reduce((a, t) => a + (t.exitTs - t.entryTs), 0) / n / DAY,
    clusters: clusters.length,
  };
}

export interface TrendEvent {
  id: string;
  kind: 'entry' | 'exit';
  symbol: string;
  /** Daily close that produced the decision; the fill is the next day's open. */
  decidedAt: number;
  fillAt: number;
  price: number;
  netBps?: number;
  reason?: TrendTrade['reason'];
}
/**
 * Forward paper ledger: replays the frozen rules over all bars (for warm-up) and keeps only
 * positions entered on or after `forwardStart`. Deterministic, so every run rebuilds the same ledger.
 */
export function trendLedger(
  bars: Map<string, DailyBar[]>,
  regime: Map<number, boolean>,
  rules: TrendRules,
  forwardStart: number,
) {
  const open: (TrendTrade & { markBps: number; lastClose: number })[] = [],
    closed: TrendTrade[] = [],
    events: TrendEvent[] = [];
  for (const [symbol, series] of bars) {
    for (const t of runTrend(symbol, series, regime, rules, true)) {
      if (t.entryTs < forwardStart) continue;
      events.push({
        id: `${symbol}-${t.entryTs}-entry`,
        kind: 'entry',
        symbol,
        decidedAt: t.entryTs - DAY,
        fillAt: t.entryTs,
        price: t.entry,
      });
      if (t.reason === 'open') {
        open.push({ ...t, markBps: t.netBps, lastClose: t.exit });
        continue;
      }
      closed.push(t);
      events.push({
        id: `${symbol}-${t.entryTs}-exit`,
        kind: 'exit',
        symbol,
        decidedAt: t.exitTs - DAY,
        fillAt: t.exitTs,
        price: t.exit,
        netBps: t.netBps,
        reason: t.reason,
      });
    }
  }
  events.sort((a, b) => b.decidedAt - a.decidedAt || a.id.localeCompare(b.id));
  return { open, closed, events };
}
