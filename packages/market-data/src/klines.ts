import { epochMs } from '../../domain/src/index.js';
import { retryRequest } from './archive.js';
import { MINUTE, type Bar } from '../../quant/src/residual.js';

/** Parses one Binance 1m kline row (archive CSV columns or REST array). */
export function parseKline(columns: readonly unknown[]): Bar {
  const open = epochMs(Number(columns[0])),
    close = epochMs(Number(columns[6])),
    bar = {
      ts: open,
      open: Number(columns[1]),
      high: Number(columns[2]),
      low: Number(columns[3]),
      close: Number(columns[4]),
      quoteVolume: Number(columns[7]),
    };
  if (
    !Number.isSafeInteger(open) ||
    open % MINUTE ||
    close !== open + MINUTE - 1 ||
    ![bar.open, bar.high, bar.low, bar.close].every((p) => p > 0) ||
    !(bar.quoteVolume >= 0) ||
    bar.low > Math.min(bar.open, bar.close) ||
    bar.high < Math.max(bar.open, bar.close)
  )
    throw new Error(`Invalid 1m kline at ${columns[0]}`);
  return bar;
}
/** Parses an archive CSV, skipping an optional header, and enforces strictly increasing bars within [startTs, endTs). */
export function parseKlineCsv(text: string, startTs: number, endTs: number) {
  const bars: Bar[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || !/^\d/.test(line)) continue;
    const bar = parseKline(line.split(','));
    if (bar.ts < startTs || bar.ts >= endTs)
      throw new Error('Kline outside its archive period');
    if (bars.length && bar.ts <= bars.at(-1)!.ts)
      throw new Error('Kline archive is out of order or duplicated');
    bars.push(bar);
  }
  return bars;
}
export function monthRange(first: string, last = first) {
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!valid.test(first) || !valid.test(last) || first > last)
    throw new Error('Months must be YYYY-MM and increasing');
  const months: string[] = [];
  for (let [y, m] = first.split('-').map(Number) as [number, number]; ;) {
    const label = `${y}-${String(m).padStart(2, '0')}`;
    months.push(label);
    if (label === last) return months;
    if (months.length >= 120) throw new Error('Maximum range is 120 months');
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
}
export function periodBounds(period: string) {
  const start = Date.parse(
    period.length === 7 ? `${period}-01T00:00:00Z` : `${period}T00:00:00Z`,
  );
  if (!Number.isFinite(start)) throw new Error(`Invalid period ${period}`);
  const end =
    period.length === 7
      ? Date.UTC(
          new Date(start).getUTCFullYear(),
          new Date(start).getUTCMonth() + 1,
        )
      : start + 86400000;
  return { start, end };
}
export const klineArchiveUrl = (symbol: string, period: string) =>
  `https://data.binance.vision/data/spot/${period.length === 7 ? 'monthly' : 'daily'}/klines/${symbol}/1m/${symbol}-1m-${period}.zip`;

type Fetch = typeof fetch;
/**
 * Fetches closed 1m bars in [startTs, endTs) from the public REST API. A bar
 * counts as closed only once `now` has passed its close time.
 */
export async function fetchKlines(
  symbol: string,
  startTs: number,
  endTs: number,
  options: { now?: number; fetcher?: Fetch; baseUrl?: string } = {},
) {
  const now = options.now ?? Date.now(),
    fetcher = options.fetcher ?? fetch,
    base = options.baseUrl ?? 'https://api.binance.com',
    bars: Bar[] = [];
  for (let from = startTs; from < endTs;) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${endTs - 1}&limit=1000`;
    const rows = await retryRequest(async () => {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error(
          `${response.status >= 500 || response.status === 429 ? 'Transient' : 'Permanent'} HTTP ${response.status}`,
        );
      return (await response.json()) as unknown[][];
    });
    if (!Array.isArray(rows)) throw new Error('Unexpected kline response');
    for (const row of rows) {
      const bar = parseKline(row);
      if (bar.ts + MINUTE > now || bar.ts < from || bar.ts >= endTs) continue;
      if (bars.length && bar.ts <= bars.at(-1)!.ts)
        throw new Error('REST klines out of order');
      bars.push(bar);
    }
    if (rows.length < 1000) break;
    from = parseKline(rows.at(-1)!).ts + MINUTE;
  }
  return bars;
}
