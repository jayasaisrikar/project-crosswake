import { rsi } from '../../backtest/src/htf-rsi.js';
import type { CoinFact } from './digest.js';

const FOUR_HOURS = 4 * 3_600_000;
const CANDLES = 200;
const BASE = 'https://fapi.binance.com';

export const ema = (xs: number[], n: number) => {
  const k = 2 / (n + 1),
    out = new Array<number>(xs.length).fill(NaN);
  let e = 0;
  for (let i = 0; i < xs.length; i++) {
    if (i < n - 1) e += xs[i]!;
    else if (i === n - 1) e = (e + xs[i]!) / n;
    else e = xs[i]! * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
};

export const macdAt = (closes: number[]) => {
  const fast = ema(closes, 12),
    slow = ema(closes, 26),
    first = 25,
    line = closes.map((_, i) => fast[i]! - slow[i]!),
    signal = ema(line.slice(first), 9),
    last = closes.length - 1,
    reading = signal[last - first];
  return last < first
    ? { macd: null, signal: null }
    : {
        macd: line[last]!,
        signal:
          reading !== undefined && Number.isFinite(reading) ? reading : null,
      };
};

const fourHourBar = (row: unknown, pair: string) => {
  if (!Array.isArray(row)) throw new Error(`${pair} 4h kline is not a list`);
  const ts = Number(row[0]),
    close = Number(row[4]),
    closeTs = Number(row[6]);
  if (
    !Number.isSafeInteger(ts) ||
    ts % FOUR_HOURS ||
    closeTs !== ts + FOUR_HOURS - 1 ||
    !(close > 0)
  )
    throw new Error(`${pair} 4h kline is invalid at ${String(row[0])}`);
  return { ts, close };
};

export async function closedFourHourCloses(
  pair: string,
  options: { now?: number; fetcher?: typeof fetch; baseUrl?: string } = {},
) {
  const now = options.now ?? Date.now(),
    fetcher = options.fetcher ?? fetch,
    base = options.baseUrl ?? BASE,
    response = await fetcher(
      `${base}/fapi/v1/klines?symbol=${pair}&interval=4h&limit=${CANDLES}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
  if (!response.ok)
    throw new Error(`${pair} 4h klines failed with HTTP ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows))
    throw new Error(`${pair} 4h klines response is not a list`);
  const closes: number[] = [];
  for (const row of rows) {
    const bar = fourHourBar(row, pair);
    if (bar.ts + FOUR_HOURS > now) continue;
    closes.push(bar.close);
  }
  return closes;
}

export async function marketFacts(
  symbols: string[],
  options: { now?: number; fetcher?: typeof fetch; baseUrl?: string } = {},
): Promise<CoinFact[]> {
  const facts: CoinFact[] = [];
  for (const symbol of symbols) {
    const pair = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`,
      closes = await closedFourHourCloses(pair, options);
    if (closes.length < 35) continue;
    const reading = rsi(closes, 14).at(-1)!,
      { macd, signal } = macdAt(closes);
    facts.push({
      symbol: pair.replace(/USDT$/, ''),
      price: closes.at(-1)!,
      rsi: Number.isFinite(reading) ? reading : null,
      macd,
      macdSignal: signal,
    });
  }
  if (!facts.length)
    throw new Error(
      'no closed 4h klines were available for the digest symbols',
    );
  return facts;
}
