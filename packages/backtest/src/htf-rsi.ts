/**
 * 4h EMA trend + 15m RSI re-cross (v007). Pure and causal: a decision at a 15m close uses only bars
 * closed by then (4h bars included) and fills at the next 15m open.
 */
export interface Bar15 {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface Funding {
  ts: number;
  rate: number;
}
export interface HtfRsiRules {
  emaFast: number;
  emaSlow: number;
  minEmaSpreadFrac: number;
  adxPeriod: number;
  adxMin: number;
  rsiPeriod: number;
  cooldownHours: number;
  fundingMaxAgainst: number;
  atrPeriod: number;
  atrMult: number;
  maxStopFrac: number;
  maxConcurrent: number;
  scaleOutR: number;
  scaleOutFrac: number;
  breakevenAfterR: number;
  trailAtrMult: number;
  timeStopBars: number;
  costBpsRoundTrip: number;
}
export type Side = 'long' | 'short';
export type ExitReason = 'stop' | 'trail' | 'time' | 'gap' | 'open';
export type SkipReason =
  | 'funding'
  | 'max_concurrent'
  | 'position_open'
  | 'gap_through_stop'
  | 'no_next_bar';
export interface HtfSignal {
  id: string;
  symbol: string;
  side: Side;
  /** Close time of the 15m candle that triggered; the fill is the next bar's open. */
  ts: number;
  status: 'taken' | 'skipped';
  skipReason?: SkipReason;
  close: number;
  entry?: number;
  stop: number;
  rDistance?: number;
  ema4h: { fast: number; slow: number; state: 'bullish' | 'bearish' };
  adx4h: number;
  rsiPrev: number;
  rsi: number;
  atr: number;
  vwap: number;
  vwapRelation: 'above' | 'below';
  funding: number | null;
  exitTs?: number;
  exitReason?: ExitReason;
  scaled?: boolean;
  realizedR?: number;
  costR?: number;
  fundingR?: number;
}

export const M15 = 15 * 60_000,
  H4 = 4 * 3_600_000;

/** EMA seeded with the SMA of the first `n` values; NaN before that. */
export function ema(xs: number[], n: number) {
  const out = new Array<number>(xs.length).fill(NaN),
    k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < xs.length; i++) {
    if (i < n - 1) e += xs[i]!;
    else if (i === n - 1) e = (e + xs[i]!) / n;
    else e = xs[i]! * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}
/** Wilder RSI; NaN until `n` changes are seen. */
export function rsi(closes: number[], n: number) {
  const out = new Array<number>(closes.length).fill(NaN);
  let g = 0,
    l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!,
      up = Math.max(d, 0),
      dn = Math.max(-d, 0);
    if (i <= n) {
      g += up / n;
      l += dn / n;
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
    }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
const trueRange = (b: Bar15, prev?: Bar15) =>
  prev
    ? Math.max(
        b.high - b.low,
        Math.abs(b.high - prev.close),
        Math.abs(b.low - prev.close),
      )
    : b.high - b.low;
/** Wilder ATR; NaN for the first n-1 bars. */
export function atr(bars: Bar15[], n: number) {
  const out = new Array<number>(bars.length).fill(NaN);
  let a = 0;
  bars.forEach((b, i) => {
    const tr = trueRange(b, bars[i - 1]);
    if (i < n) a += tr / n;
    else a = (a * (n - 1) + tr) / n;
    if (i >= n - 1) out[i] = a;
  });
  return out;
}
/** Wilder ADX; NaN until 2n bars. */
export function adx(bars: Bar15[], n: number) {
  const out = new Array<number>(bars.length).fill(NaN);
  let tr = 0,
    pdm = 0,
    mdm = 0,
    adxV = 0,
    dxSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!,
      p = bars[i - 1]!,
      up = b.high - p.high,
      dn = p.low - b.low,
      t = trueRange(b, p),
      pd = up > dn && up > 0 ? up : 0,
      md = dn > up && dn > 0 ? dn : 0;
    if (i <= n) {
      tr += t;
      pdm += pd;
      mdm += md;
    } else {
      tr = tr - tr / n + t;
      pdm = pdm - pdm / n + pd;
      mdm = mdm - mdm / n + md;
    }
    if (i < n) continue;
    const pdi = tr ? (100 * pdm) / tr : 0,
      mdi = tr ? (100 * mdm) / tr : 0,
      dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (i < 2 * n - 1) dxSum += dx;
    else if (i === 2 * n - 1) adxV = (dxSum + dx) / n;
    else adxV = (adxV * (n - 1) + dx) / n;
    if (i >= 2 * n - 1) out[i] = adxV;
  }
  return out;
}
/** Session VWAP of typical price, reset at 00:00 UTC. */
export function sessionVwap(bars: Bar15[]) {
  let day = -1,
    pv = 0,
    v = 0;
  return bars.map((b) => {
    const d = Math.floor(b.ts / 86_400_000);
    if (d !== day) [day, pv, v] = [d, 0, 0];
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
    return v ? pv / v : b.close;
  });
}
/** Complete 4h bars (all sixteen 15m bars present) built from 15m bars. */
export function to4h(bars: Bar15[]): Bar15[] {
  const out: Bar15[] = [];
  let cur: Bar15[] = [];
  const flush = () => {
    if (cur.length === H4 / M15)
      out.push({
        ts: cur[0]!.ts,
        open: cur[0]!.open,
        high: Math.max(...cur.map((b) => b.high)),
        low: Math.min(...cur.map((b) => b.low)),
        close: cur.at(-1)!.close,
        volume: cur.reduce((a, b) => a + b.volume, 0),
      });
    cur = [];
  };
  for (const b of bars) {
    if (cur.length && Math.floor(b.ts / H4) !== Math.floor(cur[0]!.ts / H4))
      flush();
    cur.push(b);
  }
  flush();
  return out;
}

interface Candidate extends HtfSignal {
  index: number;
}
/** Every trigger on one symbol, with cooldown and funding applied; concurrency is decided later. */
export function candidates(
  symbol: string,
  bars: Bar15[],
  funding: Funding[],
  rules: HtfRsiRules,
): Candidate[] {
  const closes = bars.map((b) => b.close),
    r = rsi(closes, rules.rsiPeriod),
    a = atr(bars, rules.atrPeriod),
    vw = sessionVwap(bars),
    h4 = to4h(bars),
    c4 = h4.map((b) => b.close),
    ef = ema(c4, rules.emaFast),
    es = ema(c4, rules.emaSlow),
    ax = adx(h4, rules.adxPeriod),
    out: Candidate[] = [];
  let k = -1,
    f = -1,
    lastSignal = -Infinity;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!,
      closeTs = b.ts + M15;
    while (k + 1 < h4.length && h4[k + 1]!.ts + H4 <= closeTs) k++;
    while (f + 1 < funding.length && funding[f + 1]!.ts <= closeTs) f++;
    if (k < 0 || !(ef[k]! > 0 && es[k]! > 0 && ax[k]! >= 0 && a[i]! > 0))
      continue;
    const px = c4[k]!,
      bull = px > es[k]! && ef[k]! > es[k]!,
      bear = px < es[k]! && ef[k]! < es[k]!,
      clean = Math.abs(ef[k]! - es[k]!) / px >= rules.minEmaSpreadFrac,
      strong = ax[k]! > rules.adxMin;
    if (!clean || !strong) continue;
    const side: Side | null =
      bull && r[i - 1]! <= 30 && r[i]! > 30 && b.close > vw[i]!
        ? 'long'
        : bear && r[i - 1]! >= 70 && r[i]! < 70 && b.close < vw[i]!
          ? 'short'
          : null;
    if (!side || closeTs - lastSignal < rules.cooldownHours * 3_600_000)
      continue;
    lastSignal = closeTs;
    // The dip (or pop) is the run of extreme-RSI bars ending at i-1, plus the trigger bar.
    let j = i - 1,
      swing = side === 'long' ? b.low : b.high;
    while (j >= 0 && (side === 'long' ? r[j]! <= 30 : r[j]! >= 70)) {
      swing =
        side === 'long'
          ? Math.min(swing, bars[j]!.low)
          : Math.max(swing, bars[j]!.high);
      j--;
    }
    const s = side === 'long' ? 1 : -1,
      atrStop = b.close - s * rules.atrMult * a[i]!,
      tighter = s > 0 ? Math.max(swing, atrStop) : Math.min(swing, atrStop),
      capped = b.close - s * rules.maxStopFrac * b.close,
      stop = s > 0 ? Math.max(tighter, capped) : Math.min(tighter, capped),
      rate = f >= 0 ? funding[f]!.rate : null,
      against =
        rate !== null &&
        (s > 0
          ? rate > rules.fundingMaxAgainst
          : rate < -rules.fundingMaxAgainst);
    out.push({
      index: i,
      id: `${symbol}-${closeTs}-${side}`,
      symbol,
      side,
      ts: closeTs,
      status: against ? 'skipped' : 'taken',
      ...(against ? { skipReason: 'funding' as const } : {}),
      close: b.close,
      stop,
      ema4h: { fast: ef[k]!, slow: es[k]!, state: bull ? 'bullish' : 'bearish' },
      adx4h: ax[k]!,
      rsiPrev: r[i - 1]!,
      rsi: r[i]!,
      atr: a[i]!,
      vwap: vw[i]!,
      vwapRelation: b.close > vw[i]! ? 'above' : 'below',
      funding: rate,
    });
  }
  return out;
}

/** Walks one trade forward from the fill bar. Returns null if the data ends first (still open). */
export function simulate(
  c: Candidate,
  bars: Bar15[],
  atrs: number[],
  funding: Funding[],
  rules: HtfRsiRules,
): HtfSignal {
  const s = c.side === 'long' ? 1 : -1,
    fillBar = bars[c.index + 1]!,
    entry = fillBar.open,
    R = s * (entry - c.stop),
    target = entry + s * rules.scaleOutR * R,
    legs: { frac: number; px: number; ts: number }[] = [];
  let stop = c.stop,
    remaining = 1,
    scaled = false,
    extreme = entry,
    reason: ExitReason = 'open',
    exitTs = bars.at(-1)!.ts + M15;
  const beyond = (px: number, level: number) => s * (px - level) <= 0;
  for (let j = c.index + 1; j < bars.length; j++) {
    const b = bars[j]!,
      n = j - c.index;
    // A missing bar means the price path is unknown: close at the last known close.
    if (j > c.index + 1 && b.ts - bars[j - 1]!.ts !== M15) {
      legs.push({ frac: remaining, px: bars[j - 1]!.close, ts: b.ts });
      [reason, exitTs] = ['gap', bars[j - 1]!.ts + M15];
      break;
    }
    const stopReason: ExitReason = scaled ? 'trail' : 'stop',
      worst = s > 0 ? b.low : b.high,
      best = s > 0 ? b.high : b.low;
    if (j > c.index + 1 && beyond(b.open, stop)) {
      legs.push({ frac: remaining, px: b.open, ts: b.ts });
      [reason, exitTs] = [stopReason, b.ts];
      break;
    }
    if (beyond(worst, stop)) {
      legs.push({ frac: remaining, px: stop, ts: b.ts });
      [reason, exitTs] = [stopReason, b.ts + M15];
      break;
    }
    if (!scaled && s * (best - target) >= 0) {
      const px = s * (b.open - target) >= 0 ? b.open : target;
      legs.push({ frac: rules.scaleOutFrac, px, ts: b.ts });
      remaining -= rules.scaleOutFrac;
      scaled = true;
    }
    if (!scaled && n >= rules.timeStopBars) {
      legs.push({ frac: remaining, px: b.close, ts: b.ts + M15 });
      [reason, exitTs] = ['time', b.ts + M15];
      break;
    }
    // Stop moves apply from the next bar.
    if (s * (best - entry) >= rules.breakevenAfterR * R)
      stop = s > 0 ? Math.max(stop, entry) : Math.min(stop, entry);
    if (scaled) {
      extreme = s > 0 ? Math.max(extreme, b.high) : Math.min(extreme, b.low);
      const trail = extreme - s * rules.trailAtrMult * atrs[j]!;
      stop = s > 0 ? Math.max(stop, trail) : Math.min(stop, trail);
    }
  }
  if (reason === 'open') legs.push({ frac: remaining, px: bars.at(-1)!.close, ts: exitTs });
  const grossR = legs.reduce((a, l) => a + (l.frac * s * (l.px - entry)) / R, 0),
    costR = ((rules.costBpsRoundTrip / 1e4) * entry) / R,
    // Funding paid at each settlement while (part of) the position is open; longs pay positive rates.
    fundingR = funding
      .filter((x) => x.ts > fillBar.ts && x.ts <= exitTs)
      .reduce((a, x) => {
        const open = 1 - legs.filter((l) => l.ts < x.ts && l !== legs.at(-1)).reduce((q, l) => q + l.frac, 0);
        return a - (s * x.rate * open * entry) / R;
      }, 0);
  const { index: _index, ...signal } = c;
  return {
    ...signal,
    entry,
    rDistance: R,
    exitTs,
    exitReason: reason,
    scaled,
    realizedR: grossR - costR + fundingR,
    costR,
    fundingR,
  };
}

/**
 * Portfolio replay over all symbols: candidates in time order, at most `maxConcurrent` open positions
 * and one per symbol. Deterministic, so live paper and backtest share it.
 */
export function runHtfRsi(
  bars: Map<string, Bar15[]>,
  funding: Map<string, Funding[]>,
  rules: HtfRsiRules,
): HtfSignal[] {
  const atrs = new Map([...bars].map(([s, b]) => [s, atr(b, rules.atrPeriod)])),
    all = [...bars]
      .flatMap(([s, b]) => candidates(s, b, funding.get(s) ?? [], rules))
      .sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol)),
    out: HtfSignal[] = [],
    open: HtfSignal[] = [];
  for (const c of all) {
    // Positions are open over [fill, exit); the fill is one bar after the signal close.
    const fillTs = c.ts;
    for (let i = open.length - 1; i >= 0; i--)
      if (open[i]!.exitReason !== 'open' && open[i]!.exitTs! <= fillTs)
        open.splice(i, 1);
    const skip = (skipReason: SkipReason) => {
      const { index: _index, ...rest } = c;
      out.push({ ...rest, status: 'skipped', skipReason });
    };
    if (c.status === 'skipped') {
      skip(c.skipReason!);
      continue;
    }
    const series = bars.get(c.symbol)!;
    if (c.index + 1 >= series.length) skip('no_next_bar');
    else if (open.some((t) => t.symbol === c.symbol)) skip('position_open');
    else if (open.length >= rules.maxConcurrent) skip('max_concurrent');
    else {
      const s = c.side === 'long' ? 1 : -1;
      if (s * (series[c.index + 1]!.open - c.stop) <= 0) skip('gap_through_stop');
      else {
        const t = simulate(c, series, atrs.get(c.symbol)!, funding.get(c.symbol) ?? [], rules);
        out.push(t);
        open.push(t);
      }
    }
  }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
/** R statistics on closed trades with a bootstrap over entry-week clusters. */
export function rStats(trades: HtfSignal[], resamples = 10000, seed = 7) {
  const closed = trades.filter((t) => t.status === 'taken' && t.exitReason !== 'open'),
    n = closed.length;
  if (!n) return null;
  const R = (t: HtfSignal) => t.realizedR!,
    wins = closed.filter((t) => R(t) > 0),
    losses = closed.filter((t) => R(t) <= 0),
    sum = (x: HtfSignal[]) => x.reduce((a, t) => a + R(t), 0),
    weeks = new Map<number, HtfSignal[]>(),
    rand = rng(seed),
    means: number[] = [];
  for (const t of closed) {
    const w = Math.floor(t.ts / (7 * 86_400_000));
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
  const by = <K extends string>(key: (t: HtfSignal) => K) => {
    const m: Record<string, { trades: number; netR: number }> = {};
    for (const t of closed) {
      const g = (m[key(t)] ??= { trades: 0, netR: 0 });
      g.trades++;
      g.netR += R(t);
    }
    return m;
  };
  return {
    trades: n,
    winRate: wins.length / n,
    expectancyR: sum(closed) / n,
    ci95: [
      means[Math.floor(resamples * 0.025)]!,
      means[Math.floor(resamples * 0.975)]!,
    ] as [number, number],
    profitFactor: losses.length ? sum(wins) / -sum(losses) : Infinity,
    avgWinR: wins.length ? sum(wins) / wins.length : 0,
    avgLossR: losses.length ? sum(losses) / losses.length : 0,
    totalR: sum(closed),
    avgCostR: closed.reduce((a, t) => a + t.costR!, 0) / n,
    avgFundingR: closed.reduce((a, t) => a + t.fundingR!, 0) / n,
    avgStopFrac: closed.reduce((a, t) => a + t.rDistance! / t.entry!, 0) / n,
    byExit: by((t) => t.exitReason!),
    bySymbol: by((t) => t.symbol),
    bySide: by((t) => t.side),
    clusters: clusters.length,
  };
}

/** Rules object from the frozen plan file. */
export function rulesFromPlan(plan: any): HtfRsiRules {
  return {
    emaFast: plan.filter.emaFast,
    emaSlow: plan.filter.emaSlow,
    minEmaSpreadFrac: plan.filter.minEmaSpreadFrac,
    adxPeriod: plan.filter.adxPeriod,
    adxMin: plan.filter.adxMin,
    rsiPeriod: plan.entry.rsiPeriod,
    cooldownHours: plan.entry.cooldownHours,
    fundingMaxAgainst: plan.entry.fundingMaxAgainst,
    atrPeriod: plan.stop.atrPeriod,
    atrMult: plan.stop.atrMult,
    maxStopFrac: plan.stop.maxStopFrac,
    maxConcurrent: plan.sizing.maxConcurrent,
    scaleOutR: plan.exits.scaleOutR,
    scaleOutFrac: plan.exits.scaleOutFrac,
    breakevenAfterR: plan.exits.breakevenAfterR,
    trailAtrMult: 2,
    timeStopBars: plan.exits.timeStopBars,
    costBpsRoundTrip: plan.costs.costBpsRoundTrip,
  };
}
