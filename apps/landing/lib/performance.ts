import base from '@/public/data/trend-daily-v005-performance.json';
import { signalLogBase } from './site';
import {
  DAY,
  drawdowns,
  extendSeries,
  readPositions,
  type Closes,
  type LedgerRow,
  type PerformancePayload,
} from './performance-live';

export type {
  LiveRecord,
  PerformancePayload,
  PerformancePoint,
  PerformanceSummary,
} from './performance-live';

const REVALIDATE = 3600;
const KLINE_LIMIT = 1000;
const BINANCE = 'https://data-api.binance.vision/api/v3/klines';
const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;

async function readSignalLog(version: string): Promise<LedgerRow[]> {
  if (!signalLogBase) return [];
  try {
    const response = await fetch(`${signalLogBase}/${version}.jsonl`, {
      next: { revalidate: REVALIDATE },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return [];
    const rows: LedgerRow[] = [];
    for (const line of (await response.text()).split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.kind !== 'entry' && row.kind !== 'exit') continue;
        if (typeof row.symbol !== 'string') continue;
        rows.push({
          kind: row.kind,
          symbol: row.symbol,
          fillAt: Number(row.fillAt),
          price: Number(row.price),
          netBps: row.netBps === undefined ? null : Number(row.netBps),
        });
      } catch {
        continue;
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function readCloses(symbols: string[], from: number): Promise<Closes> {
  const closes: Closes = new Map();
  const startTime = from - 2 * DAY;
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const url = `${BINANCE}?symbol=${symbol}&interval=1d&startTime=${startTime}&limit=${KLINE_LIMIT}`;
        const response = await fetch(url, {
          next: { revalidate: REVALIDATE },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return;
        const rows = (await response.json()) as unknown[][];
        const byDay = new Map<number, number>();
        for (const row of rows) {
          const ts = Number(row[0]),
            close = Number(row[4]);
          if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;
          byDay.set(utcDay(ts), close);
        }
        if (byDay.size) {
          const days = [...byDay.keys()].sort((a, b) => a - b);
          closes.set(symbol, {
            days,
            closes: days.map((day) => byDay.get(day)!),
          });
        }
      } catch {
        return;
      }
    }),
  );
  return closes;
}

/** The published test record, continued to the latest completed daily close when it can be read. */
export async function readPerformance(): Promise<PerformancePayload> {
  const payload = base as PerformancePayload;
  const summary = payload.summary;
  const universe = summary.universe ?? [];
  if (!universe.length) return payload;
  const through = utcDay(Date.now()) - DAY;
  const anchor = payload.points.at(-1);
  if (!anchor || anchor.t + DAY > through) return payload;

  const [rows, closes] = await Promise.all([
    readSignalLog(summary.version),
    readCloses(universe, utcDay(Date.parse(`${summary.period[0]}T00:00:00Z`))),
  ]);
  if (!rows.length) return payload;
  const positions = readPositions(rows);
  const extension = extendSeries(payload, positions, closes, through);
  if (!extension) return payload;

  const points = [...payload.points, ...extension.points];
  const { values, span } = drawdowns(points);
  const scored = points.map((point, index) => ({
    ...point,
    drawdown: values[index]!,
  }));
  return {
    summary: {
      ...summary,
      live: extension.live,
      liveAsOf: Date.now(),
      worstDrawdown: {
        from: scored[span.from]!.t,
        to: scored[span.to]!.t,
      },
    },
    points: scored,
  };
}
