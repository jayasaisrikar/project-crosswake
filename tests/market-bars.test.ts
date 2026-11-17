import { describe, expect, it } from 'vitest';
import {
  closedFourHourCloses,
  ema,
  macdAt,
  marketFacts,
} from '../packages/context/src/market-bars.js';

const FOUR_HOURS = 4 * 3_600_000;
const now = Date.UTC(2026, 10, 17, 4, 0);

const candle = (ts: number, close: number) => [
  ts,
  String(close - 1),
  String(close + 2),
  String(close - 3),
  String(close),
  '100',
  ts + FOUR_HOURS - 1,
  '1000',
  10,
  '500',
  '500',
  '0',
];

const rows = (closes: number[], start = now - closes.length * FOUR_HOURS) =>
  closes.map((close, i) => candle(start + i * FOUR_HOURS, close));

const respond = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
const accelerating = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.5);

describe('market bars', () => {
  it('keeps only candles that have closed', async () => {
    const closes = await closedFourHourCloses('BTCUSDT', {
      now,
      fetcher: respond(rows(rising)),
    });
    expect(closes).toHaveLength(60);
    expect(closes.at(-1)).toBe(159);
    const withOpen = await closedFourHourCloses('BTCUSDT', {
      now,
      fetcher: respond([
        ...rows(rising, now - (rising.length + 1) * FOUR_HOURS),
        candle(now, 999),
      ]),
    });
    expect(withOpen).toHaveLength(60);
    expect(withOpen).not.toContain(999);
  });

  it('refuses a failed request instead of inventing readings', async () => {
    await expect(
      closedFourHourCloses('BTCUSDT', { now, fetcher: respond({}, 429) }),
    ).rejects.toThrow('BTCUSDT 4h klines failed with HTTP 429');
  });

  it('tracks a constant series and a rising one', () => {
    expect(ema([5, 5, 5, 5, 5], 3).at(-1)).toBeCloseTo(5, 10);
    const fast = ema(rising, 12).at(-1)!,
      slow = ema(rising, 26).at(-1)!;
    expect(fast).toBeGreaterThan(slow);
  });

  it('needs enough closes before reporting a MACD', () => {
    expect(macdAt(rising.slice(0, 25))).toEqual({ macd: null, signal: null });
    const { macd, signal } = macdAt(accelerating);
    expect(macd).not.toBeNull();
    expect(signal).not.toBeNull();
    expect(macd!).toBeGreaterThan(0);
    expect(signal!).toBeGreaterThan(0);
    expect(macd!).toBeGreaterThan(signal!);
    const steady = macdAt(rising);
    expect(Math.abs(steady.macd! - steady.signal!)).toBeLessThan(1e-6);
  });

  it('builds digest facts from our own 4h closes', async () => {
    const facts = await marketFacts(['BTC', 'SOLUSDT'], {
      now,
      fetcher: respond(rows(accelerating)),
    });
    expect(facts.map((f) => f.symbol)).toEqual(['BTC', 'SOL']);
    expect(facts[0]!.price).toBe(1840.5);
    expect(facts[0]!.rsi).toBe(100);
    expect(facts[0]!.macd!).toBeGreaterThan(facts[0]!.macdSignal!);
  });

  it('skips symbols without enough history and throws when none are usable', async () => {
    const short = await marketFacts(['BTC'], {
      now,
      fetcher: respond(rows(rising.slice(0, 20))),
    }).catch((error: Error) => error);
    expect(short).toBeInstanceOf(Error);
    expect(String(short)).toContain('no closed 4h klines');
    const mixed = await marketFacts(['BTC', 'SOL'], {
      now,
      fetcher: (async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('BTC') ? rows(rising) : rows(rising.slice(0, 10)),
          ),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(mixed.map((f) => f.symbol)).toEqual(['BTC']);
  });
});
