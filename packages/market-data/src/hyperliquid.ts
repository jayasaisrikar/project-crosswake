/**
 * Read-only client for Hyperliquid's public info API (no key, no signing).
 * Hyperliquid quotes perpetuals by coin name ("BTC", "HYPE"), not by pair.
 */
type Fetch = typeof fetch;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const DAY = 86_400_000;
const INTERVAL_MS = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': DAY,
} as const;
export type HlInterval = keyof typeof INTERVAL_MS;
export interface HlCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume. */
  volume: number;
}
export interface HlFunding {
  ts: number;
  rate: number;
}
export interface HlAssetContext {
  coin: string;
  markPx: number;
  oraclePx: number;
  /** Current hourly funding rate. */
  funding: number;
  /** Open interest in coins. */
  openInterest: number;
  /** 24h notional volume in USD. */
  dayNtlVlm: number;
}
export interface HlOptions {
  fetcher?: Fetch;
  url?: string;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Binance pair ("HYPEUSDT") to Hyperliquid coin ("HYPE"). */
export const hlCoin = (symbol: string) => symbol.replace(/USDT$/, '');

/**
 * POST to the info endpoint with the same retry policy as `getJson`: 429 waits
 * for Retry-After (default 10s), 5xx and network errors back off, other 4xx fail.
 */
export async function postInfo<T>(
  body: Record<string, unknown>,
  { fetcher = fetch, url = HL_INFO_URL, sleep = pause }: HlOptions = {},
  attempts = 5,
): Promise<T> {
  for (let n = 1; ; n++) {
    let wait: number;
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 429) {
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

/**
 * Closed candles opening in [startTs, endTs). Hyperliquid serves at most 5000
 * per request and only the most recent 5000 per interval overall, so older
 * history must come from elsewhere.
 */
export async function fetchHlCandles(
  coin: string,
  interval: HlInterval,
  startTs: number,
  endTs: number,
  options: HlOptions & { now?: number } = {},
) {
  const step = INTERVAL_MS[interval],
    now = options.now ?? Date.now(),
    candles: HlCandle[] = [];
  for (let from = startTs; from < endTs; ) {
    const rows = await postInfo<
      { t: number; o: string; h: string; l: string; c: string; v: string }[]
    >(
      {
        type: 'candleSnapshot',
        req: { coin, interval, startTime: from, endTime: endTs - 1 },
      },
      options,
    );
    if (!Array.isArray(rows)) throw new Error('Unexpected candle response');
    for (const r of rows) {
      const ts = Number(r.t);
      if (ts < from || ts >= endTs || ts + step > now) continue;
      if (candles.length && ts <= candles.at(-1)!.ts)
        throw new Error('Hyperliquid candles out of order');
      candles.push({
        ts,
        open: Number(r.o),
        high: Number(r.h),
        low: Number(r.l),
        close: Number(r.c),
        volume: Number(r.v),
      });
    }
    if (rows.length < 5000) break;
    from = Number(rows.at(-1)!.t) + step;
  }
  return candles;
}

/** Hourly funding settlements in [startTs, endTs), paged 500 at a time. */
export async function fetchHlFunding(
  coin: string,
  startTs: number,
  endTs: number,
  options: HlOptions = {},
) {
  const events: HlFunding[] = [];
  for (let from = startTs; from < endTs; ) {
    const rows = await postInfo<{ time: number; fundingRate: string }[]>(
      { type: 'fundingHistory', coin, startTime: from, endTime: endTs - 1 },
      options,
    );
    if (!Array.isArray(rows)) throw new Error('Unexpected funding response');
    for (const r of rows) {
      const ts = Number(r.time);
      if (ts < from || ts >= endTs) continue;
      if (events.length && ts <= events.at(-1)!.ts)
        throw new Error('Hyperliquid funding out of order');
      events.push({ ts, rate: Number(r.fundingRate) });
    }
    if (rows.length < 500) break;
    from = events.at(-1)!.ts + 1;
  }
  return events;
}

/** Mark price, funding, open interest and volume for every listed perp. */
export async function fetchHlContexts(options: HlOptions = {}) {
  const [meta, ctxs] = await postInfo<
    [
      { universe: { name: string; isDelisted?: boolean }[] },
      Record<string, string>[],
    ]
  >({ type: 'metaAndAssetCtxs' }, options);
  if (!meta?.universe || !Array.isArray(ctxs))
    throw new Error('Unexpected asset context response');
  const out = new Map<string, HlAssetContext>();
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || u.isDelisted) return;
    out.set(u.name, {
      coin: u.name,
      markPx: Number(c.markPx),
      oraclePx: Number(c.oraclePx),
      funding: Number(c.funding),
      openInterest: Number(c.openInterest),
      dayNtlVlm: Number(c.dayNtlVlm),
    });
  });
  return out;
}

/** Current mid price for a perp ("HYPE") or spot market ("@107"). */
export async function fetchHlMid(coin: string, options: HlOptions = {}) {
  const mids = await postInfo<Record<string, string>>(
    { type: 'allMids' },
    options,
  );
  const mid = Number(mids?.[coin]);
  if (!(mid > 0)) throw new Error(`No Hyperliquid mid for ${coin}`);
  return mid;
}
