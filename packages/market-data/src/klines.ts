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
export type Market = 'spot' | 'usdm';
const archiveRoot = (market: Market) =>
  `https://data.binance.vision/data/${market === 'spot' ? 'spot' : 'futures/um'}`;
export const klineArchiveUrl = (
  symbol: string,
  period: string,
  market: Market = 'spot',
) =>
  `${archiveRoot(market)}/${period.length === 7 ? 'monthly' : 'daily'}/klines/${symbol}/1m/${symbol}-1m-${period}.zip`;
/** USDⓈ-M funding archives are published monthly only. */
export const fundingArchiveUrl = (symbol: string, month: string) =>
  `${archiveRoot('usdm')}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`;
export interface FundingEvent {
  ts: number;
  rate: number;
}
function fundingEvent(ts: number, rate: number): FundingEvent {
  if (
    !Number.isSafeInteger(ts) ||
    ts <= 0 ||
    !Number.isFinite(rate) ||
    Math.abs(rate) > 0.05
  )
    throw new Error(`Invalid funding record at ${ts}`);
  return { ts, rate };
}
/** Parses calc_time,funding_interval_hours,last_funding_rate rows within [startTs, endTs). */
export function parseFundingCsv(text: string, startTs: number, endTs: number) {
  const events: FundingEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || !/^\d/.test(line)) continue;
    const [ts, , rate] = line.split(',');
    const event = fundingEvent(epochMs(Number(ts)), Number(rate));
    if (event.ts < startTs || event.ts >= endTs)
      throw new Error('Funding record outside its archive period');
    if (events.length && event.ts <= events.at(-1)!.ts)
      throw new Error('Funding archive is out of order or duplicated');
    events.push(event);
  }
  return events;
}

type Fetch = typeof fetch;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * GET JSON with rate-limit awareness: 429/418 wait for Retry-After (default
 * 10s, capped at 2 minutes); 5xx and network errors back off exponentially;
 * other 4xx fail immediately.
 */
export async function getJson<T>(
  fetcher: Fetch,
  url: string,
  sleep: (ms: number) => Promise<unknown> = pause,
  attempts = 5,
): Promise<T> {
  for (let n = 1; ; n++) {
    let wait: number;
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 429 || response.status === 418) {
        const retry = Number(response.headers.get('retry-after'));
        wait = Math.min(
          120000,
          Number.isFinite(retry) && retry > 0 ? retry * 1000 : 10000,
        );
      } else if (response.status >= 500) wait = 1000 * 2 ** (n - 1);
      else throw new Error(`Permanent HTTP ${response.status}`);
      if (n >= attempts) throw new Error(`Transient HTTP ${response.status}`);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(Permanent|Transient) HTTP/.test(error.message)
      )
        throw error;
      if (n >= attempts) throw error;
      wait = 1000 * 2 ** (n - 1);
    }
    await sleep(wait);
  }
}
/** Settled USDⓈ-M funding events in [startTs, endTs) from the public REST API. */
export async function fetchFunding(
  symbol: string,
  startTs: number,
  endTs: number,
  options: { fetcher?: Fetch; baseUrl?: string } = {},
) {
  const fetcher = options.fetcher ?? fetch,
    base = options.baseUrl ?? 'https://fapi.binance.com',
    events: FundingEvent[] = [];
  for (let from = startTs; from < endTs;) {
    const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>(
      fetcher,
      `${base}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${from}&endTime=${endTs - 1}&limit=1000`,
    );
    if (!Array.isArray(rows)) throw new Error('Unexpected funding response');
    for (const row of rows) {
      const event = fundingEvent(
        Number(row.fundingTime),
        Number(row.fundingRate),
      );
      if (event.ts < from || event.ts >= endTs) continue;
      if (events.length && event.ts <= events.at(-1)!.ts)
        throw new Error('REST funding out of order');
      events.push(event);
    }
    if (rows.length < 1000) break;
    from = events.at(-1)!.ts + 1;
  }
  return events;
}
/**
 * Fetches closed 1m bars in [startTs, endTs) from the public REST API. A bar
 * counts as closed only once `now` has passed its close time.
 */
export async function fetchKlines(
  symbol: string,
  startTs: number,
  endTs: number,
  options: {
    now?: number;
    fetcher?: Fetch;
    baseUrl?: string;
    market?: Market;
  } = {},
) {
  const now = options.now ?? Date.now(),
    fetcher = options.fetcher ?? fetch,
    usdm = options.market === 'usdm',
    base =
      options.baseUrl ??
      (usdm ? 'https://fapi.binance.com' : 'https://api.binance.com'),
    bars: Bar[] = [];
  for (let from = startTs; from < endTs;) {
    const url = `${base}${usdm ? '/fapi/v1' : '/api/v3'}/klines?symbol=${symbol}&interval=1m&startTime=${from}&endTime=${endTs - 1}&limit=1000`;
    const rows = await getJson<unknown[][]>(fetcher, url);
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
