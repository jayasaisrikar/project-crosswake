import { retryRequest } from './archive.js';
import type { Market } from './klines.js';

export interface Book {
  bids: [number, number][];
  asks: [number, number][];
}
export interface ImpactSample {
  notionalUsdt: number;
  /** Average fill versus midpoint for a market buy (positive = cost). */
  buyBps: number | null;
  /** Average fill versus midpoint for a market sell (positive = cost). */
  sellBps: number | null;
}
export interface DepthSample {
  ts: number;
  market: Market;
  symbol: string;
  mid: number;
  spreadBps: number;
  /** Quote notional visible within the fetched levels on each side. */
  bidDepthUsdt: number;
  askDepthUsdt: number;
  impact: ImpactSample[];
}
export function parseBook(raw: unknown): Book {
  const body = raw as { bids?: unknown; asks?: unknown };
  const side = (rows: unknown, ascending: boolean) => {
    if (!Array.isArray(rows) || !rows.length)
      throw new Error('Order book side is empty');
    const levels = rows.map((r) => {
      const [p, q] = (r as unknown[]).map(Number);
      if (!(p! > 0) || !(q! > 0)) throw new Error('Invalid order book level');
      return [p!, q!] as [number, number];
    });
    for (let i = 1; i < levels.length; i++)
      if (
        ascending
          ? levels[i]![0] <= levels[i - 1]![0]
          : levels[i]![0] >= levels[i - 1]![0]
      )
        throw new Error('Order book levels are not sorted');
    return levels;
  };
  const book = { bids: side(body.bids, false), asks: side(body.asks, true) };
  if (book.bids[0]![0] >= book.asks[0]![0])
    throw new Error('Crossed order book');
  return book;
}
/** Walks visible levels; null when the book is too thin for the notional. */
export function sweepBps(
  levels: [number, number][],
  mid: number,
  notional: number,
  buy: boolean,
) {
  let remaining = notional,
    quantity = 0;
  for (const [price, size] of levels) {
    const take = Math.min(remaining, price * size);
    quantity += take / price;
    remaining -= take;
    if (remaining <= 1e-9) {
      const average = notional / quantity;
      return ((buy ? average - mid : mid - average) / mid) * 1e4;
    }
  }
  return null;
}
export function measureBook(book: Book, notionals: number[]) {
  const bid = book.bids[0]![0],
    ask = book.asks[0]![0],
    mid = (bid + ask) / 2,
    depth = (levels: [number, number][]) =>
      levels.reduce((n, [p, q]) => n + p * q, 0);
  return {
    mid,
    spreadBps: ((ask - bid) / mid) * 1e4,
    bidDepthUsdt: depth(book.bids),
    askDepthUsdt: depth(book.asks),
    impact: notionals.map((n) => ({
      notionalUsdt: n,
      buyBps: sweepBps(book.asks, mid, n, true),
      sellBps: sweepBps(book.bids, mid, n, false),
    })),
  };
}
type Fetch = typeof fetch;
export async function fetchBook(
  symbol: string,
  market: Market,
  fetcher: Fetch = fetch,
) {
  const url =
    market === 'spot'
      ? `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=100`
      : `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`;
  return parseBook(
    await retryRequest(async () => {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok)
        throw new Error(
          `${response.status >= 500 || response.status === 429 ? 'Transient' : 'Permanent'} HTTP ${response.status}`,
        );
      return response.json();
    }),
  );
}
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
/** Median and p90 spread and round-trip impact (buy + sell) per market, symbol and notional. */
export function summarizeDepth(samples: DepthSample[]) {
  const groups = new Map<string, DepthSample[]>();
  for (const s of samples) {
    const key = `${s.market}|${s.symbol}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].map(([key, list]) => {
    const [market, symbol] = key.split('|') as [Market, string];
    const notionals = [
      ...new Set(list.flatMap((s) => s.impact.map((i) => i.notionalUsdt))),
    ].sort((a, b) => a - b);
    return {
      market,
      symbol,
      samples: list.length,
      firstTs: Math.min(...list.map((s) => s.ts)),
      lastTs: Math.max(...list.map((s) => s.ts)),
      spreadBps: {
        median: quantile(
          list.map((s) => s.spreadBps),
          0.5,
        ),
        p90: quantile(
          list.map((s) => s.spreadBps),
          0.9,
        ),
      },
      roundTripImpact: notionals.map((n) => {
        const values = list.flatMap((s) => {
          const i = s.impact.find((x) => x.notionalUsdt === n);
          return i && i.buyBps !== null && i.sellBps !== null
            ? [i.buyBps + i.sellBps]
            : [];
        });
        return {
          notionalUsdt: n,
          median: quantile(values, 0.5),
          p90: quantile(values, 0.9),
          unfillable: list.length - values.length,
        };
      }),
    };
  });
}
