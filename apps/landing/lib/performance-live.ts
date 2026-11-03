export type PerformancePoint = {
  t: number;
  strategy: number;
  btc: number;
  basket: number;
  exposure: number;
  drawdown: number;
};

export type LiveRecord = {
  from: number;
  through: number;
  closedTrades: number;
  openTrades: number;
  return: number;
};

export type PerformanceSummary = {
  version: string;
  period: [string, string];
  builtAt: string;
  model: {
    slots: number;
    sizing: string;
    marking: string;
    costBpsRoundTrip: number;
  };
  trades: number;
  winRate: number;
  avgNetBps: number;
  bestBps: number;
  worstBps: number;
  longestLosingStreak: number;
  avgExposure: number;
  maxExposure: number;
  totalReturn: Record<'strategy' | 'btc' | 'basket', number>;
  maxDrawdown: Record<'strategy' | 'btc' | 'basket', number>;
  worstDrawdown: { from: number; to: number };
  basketCoins: number;
  live?: LiveRecord | null;
  liveAsOf?: number | null;
  excludingTop?: {
    symbol: string;
    multiple: number;
    strategy: number;
    basket: number;
  };
  fillDelay?: {
    skipped: number;
    rows: {
      delayHours: number;
      trades: number;
      avgNetBps: number;
      winRate: number;
      totalReturn: number;
    }[];
  };
  universe?: string[];
  regimeSymbol?: string;
};

export type PerformancePayload = {
  summary: PerformanceSummary;
  points: PerformancePoint[];
};

export const DAY = 86_400_000;
const REVALIDATE = 3600;
const KLINE_LIMIT = 1000;
const BINANCE = 'https://data-api.binance.vision/api/v3/klines';

const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;
const round = (value: number, digits = 5) => Number(value.toFixed(digits));

export type LedgerRow = {
  kind: 'entry' | 'exit';
  symbol: string;
  fillAt: number;
  price: number;
  netBps: number | null;
};

export type LivePosition = {
  symbol: string;
  entry: number;
  entryDay: number;
  exitDay: number | null;
  netBps: number | null;
};

type Series = { days: number[]; closes: number[] };
export type Closes = Map<string, Series>;

export function readPositions(rows: LedgerRow[]): LivePosition[] {
  const open = new Map<string, LivePosition>();
  const done: LivePosition[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.fillAt) || !Number.isFinite(row.price)) continue;
    if (row.kind === 'entry') {
      if (open.has(row.symbol)) continue;
      open.set(row.symbol, {
        symbol: row.symbol,
        entry: row.price,
        entryDay: utcDay(row.fillAt),
        exitDay: null,
        netBps: null,
      });
      continue;
    }
    const position = open.get(row.symbol);
    if (!position) continue;
    open.delete(row.symbol);
    done.push({
      ...position,
      exitDay: utcDay(row.fillAt),
      netBps: row.netBps ?? 0,
    });
  }
  return [...done, ...open.values()].sort((a, b) => a.entryDay - b.entryDay);
}

/** Last close at or before `at`; a coin that stopped trading keeps the price it had. */
const closeOn = (series: Series | undefined, at: number) => {
  if (!series) return undefined;
  let lo = 0,
    hi = series.days.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.days[mid]! <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? undefined : series.closes[found];
};

const closeOnDay = (series: Series | undefined, at: number) => {
  if (!series) return undefined;
  let lo = 0,
    hi = series.days.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const day = series.days[mid]!;
    if (day === at) return series.closes[mid];
    if (day < at) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
};

export type LiveExtension = {
  points: PerformancePoint[];
  live: LiveRecord;
};

/**
 * Continues the frozen test series with the live paper record: realised exits plus open
 * positions marked at each daily close, anchored to the last published point so the chart
 * joins without a jump. Benchmarks chain from their own published values.
 */
export function extendSeries(
  payload: PerformancePayload,
  positions: LivePosition[],
  closes: Closes,
  through: number,
): LiveExtension | null {
  const universe = payload.summary.universe ?? [];
  const regime = payload.summary.regimeSymbol ?? universe.at(-1);
  if (!universe.length || !regime) return null;
  const anchor = payload.points.at(-1);
  if (!anchor) return null;
  const slot = 1 / payload.summary.model.slots;
  const testStart = utcDay(
    Date.parse(`${payload.summary.period[0]}T00:00:00Z`),
  );
  const start = anchor.t + DAY;
  if (start > through) return null;

  const alts = universe.filter((symbol) => symbol !== regime);
  const basket = alts
    .map((symbol) => ({
      series: closes.get(symbol),
      first: closeOnDay(closes.get(symbol), testStart),
    }))
    .filter(
      (entry): entry is { series: Series; first: number } =>
        !!entry.series && !!entry.first,
    );
  const btcSeries = closes.get(regime);
  if (!btcSeries || !basket.length) return null;

  const basketAt = (at: number) => {
    let sum = 0;
    for (const { series, first } of basket) {
      const now = closeOn(series, at);
      if (!now) return undefined;
      sum += now / first;
    }
    return sum / basket.length;
  };

  const btcAt = (at: number) => closeOn(btcSeries, at);
  const anchorDay = utcDay(anchor.t);
  const anchorBasket = basketAt(anchorDay);
  const anchorBtc = btcAt(anchorDay);
  if (!anchorBasket || !anchorBtc) return null;

  const realised = (at: number) => {
    let sum = 0;
    for (const position of positions)
      if (position.exitDay !== null && position.exitDay <= at)
        sum += slot * ((position.netBps ?? 0) / 10_000);
    return sum;
  };
  const marked = (at: number) => {
    let sum = 0,
      count = 0;
    for (const position of positions) {
      if (position.entryDay > at) continue;
      if (position.exitDay !== null && position.exitDay <= at) continue;
      const price = closeOn(closes.get(position.symbol), at);
      if (!price) continue;
      sum += slot * (price / position.entry - 1);
      count += 1;
    }
    return { sum, count };
  };

  const baseRealised = realised(anchorDay);
  const baseMarked = marked(anchorDay);
  const points: PerformancePoint[] = [];
  for (let at = start; at <= through; at += DAY) {
    const btc = btcAt(at),
      index = basketAt(at);
    if (!btc || !index) break;
    const mark = marked(at);
    const strategy =
      anchor.strategy +
      (realised(at) - baseRealised) +
      (mark.sum - baseMarked.sum);
    points.push({
      t: at,
      strategy: round(strategy),
      btc: round(anchor.btc * (btc / anchorBtc)),
      basket: round(anchor.basket * (index / anchorBasket)),
      exposure: round(mark.count * slot, 4),
      drawdown: 0,
    });
  }
  if (!points.length) return null;

  const liveFrom = payload.summary.live?.from ?? start;
  const sealed = payload.points.filter((point) => point.t <= points.at(-1)!.t);
  const entry = [...sealed, ...points].find((point) => point.t >= liveFrom);
  const last = points.at(-1)!;
  return {
    points,
    live: {
      from: liveFrom,
      through: last.t,
      closedTrades: positions.filter(
        (p) => p.exitDay !== null && p.exitDay <= last.t,
      ).length,
      openTrades: positions.filter(
        (p) => p.exitDay === null || p.exitDay > last.t,
      ).length,
      return: entry && entry.strategy ? last.strategy / entry.strategy - 1 : 0,
    },
  };
}

export function drawdowns(points: PerformancePoint[]) {
  let peak = points[0]?.strategy ?? 1,
    worst = 0,
    peakIndex = 0,
    span = { from: 0, to: 0 };
  const values = points.map((point, index) => {
    if (point.strategy > peak) {
      peak = point.strategy;
      peakIndex = index;
    }
    const depth = point.strategy / peak - 1;
    if (depth < worst) {
      worst = depth;
      span = { from: peakIndex, to: index };
    }
    return round(depth);
  });
  return { values, worst, span };
}
