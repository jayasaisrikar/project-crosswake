import { describe, expect, it } from 'vitest';
import {
  fetchHlBook,
  fetchHlCandles,
  fetchHlContexts,
  fetchHlFunding,
  fetchHlMid,
  hlCoin,
  postInfo,
} from '../packages/market-data/src/hyperliquid.js';
import { measureBook, sweepBps } from '../packages/market-data/src/depth.js';
import { compareCloses } from '../packages/market-data/src/crosscheck.js';

const DAY = 86_400_000;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const candle = (t: number, c: number) => ({
  t,
  T: t + DAY - 1,
  s: 'BTC',
  i: '1d',
  o: String(c),
  h: String(c),
  l: String(c),
  c: String(c),
  v: '1',
  n: 1,
});

describe('hyperliquid client', () => {
  it('maps Binance pairs to coins', () => {
    expect(hlCoin('HYPEUSDT')).toBe('HYPE');
  });
  it('posts the request body and drops the still-open candle', async () => {
    const bodies: unknown[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return json([candle(0, 10), candle(DAY, 11), candle(2 * DAY, 12)]);
    }) as typeof fetch;
    const bars = await fetchHlCandles('BTC', '1d', 0, 3 * DAY, {
      fetcher,
      now: 2 * DAY + 5,
    });
    expect(bars.map((b) => b.close)).toEqual([10, 11]);
    expect(bodies[0]).toMatchObject({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1d', startTime: 0 },
    });
  });
  it('pages funding until a short page', async () => {
    let calls = 0;
    const fetcher = (async (_u: string, init: RequestInit) => {
      const { startTime } = JSON.parse(String(init.body));
      calls++;
      const n = startTime === 0 ? 500 : 3;
      return json(
        Array.from({ length: n }, (_, i) => ({
          time: startTime + i * 3_600_000,
          fundingRate: '0.0001',
        })),
      );
    }) as typeof fetch;
    const ev = await fetchHlFunding('BTC', 0, 1e12, { fetcher });
    expect(calls).toBe(2);
    expect(ev).toHaveLength(503);
  });
  it('retries 5xx then fails fast on 4xx', async () => {
    let n = 0;
    const flaky = (async () =>
      ++n < 3 ? json({}, 502) : json({ ok: 1 })) as typeof fetch;
    await expect(
      postInfo({ type: 'meta' }, { fetcher: flaky, sleep: async () => {} }),
    ).resolves.toEqual({ ok: 1 });
    const bad = (async () => json({}, 400)) as typeof fetch;
    await expect(
      postInfo({ type: 'meta' }, { fetcher: bad, sleep: async () => {} }),
    ).rejects.toThrow('Permanent HTTP 400');
  });
  it('skips delisted coins in asset contexts', async () => {
    const fetcher = (async () =>
      json([
        { universe: [{ name: 'HYPE' }, { name: 'OLD', isDelisted: true }] },
        [
          {
            markPx: '85.4',
            oraclePx: '85.5',
            funding: '0.0000125',
            openInterest: '2',
            dayNtlVlm: '3',
          },
          {
            markPx: '1',
            oraclePx: '1',
            funding: '0',
            openInterest: '0',
            dayNtlVlm: '0',
          },
        ],
      ])) as typeof fetch;
    const ctx = await fetchHlContexts({ fetcher });
    expect([...ctx.keys()]).toEqual(['HYPE']);
    expect(ctx.get('HYPE')!.markPx).toBe(85.4);
  });
});

describe('compareCloses', () => {
  const bn = [
    { ts: 0, close: 100 },
    { ts: DAY, close: 100 },
    { ts: 2 * DAY, close: 100 },
  ];
  it('passes small basis and reports the median', () => {
    const r = compareCloses(
      'X',
      bn,
      [
        { ts: 0, close: 100.02 },
        { ts: DAY, close: 100.03 },
        { ts: 2 * DAY, close: 99.99 },
      ],
      50,
    );
    expect(r.status).toBe('ok');
    expect(r.medianGapBps).toBeCloseTo(2);
    expect(r.unmatchedDays).toBe(0);
  });
  it('flags a gap past the threshold and names the day', () => {
    const r = compareCloses(
      'X',
      bn,
      [
        { ts: 0, close: 100 },
        { ts: DAY, close: 101 },
      ],
      50,
    );
    expect(r.status).toBe('flagged');
    expect(r.worst!.ts).toBe(DAY);
    expect(r.maxAbsGapBps).toBeCloseTo(100);
    expect(r.unmatchedDays).toBe(1);
  });
  it('marks coins Hyperliquid does not list', () => {
    expect(compareCloses('X', bn, undefined, 50).status).toBe('missing');
  });
});

describe('fetchHlMid', () => {
  it('reads a spot market mid and rejects a missing one', async () => {
    const fetcher = (async () =>
      json({ '@107': '85.5', BTC: '1' })) as typeof fetch;
    expect(await fetchHlMid('@107', { fetcher })).toBe(85.5);
    await expect(fetchHlMid('@999', { fetcher })).rejects.toThrow(
      'No Hyperliquid mid',
    );
  });
});

/** Shape captured from a live l2Book response: string prices, `{px, sz, n}` rows. */
const l2Book = (bids: [number, number][], asks: [number, number][]) => ({
  coin: 'SOL',
  time: 1_791_640_297_416,
  levels: [
    bids.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 3 })),
    asks.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 4 })),
  ],
});

describe('fetchHlBook', () => {
  it('parses the live response shape into a numeric book and reports impact', async () => {
    const bodies: unknown[] = [],
      fetcher = (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return json(
          l2Book(
            [
              [109.95, 1000],
              [109.94, 500],
            ],
            [
              [109.96, 1200],
              [109.97, 600],
            ],
          ),
        );
      }) as typeof fetch,
      { coin, ts, book } = await fetchHlBook('SOL', { fetcher });
    expect(bodies[0]).toEqual({ type: 'l2Book', coin: 'SOL' });
    expect(coin).toBe('SOL');
    expect(ts).toBe(1_791_640_297_416);
    expect(book.bids).toEqual([
      [109.95, 1000],
      [109.94, 500],
    ]);
    expect(book.asks[0]).toEqual([109.96, 1200]);
    const measured = measureBook(book, [10_000]);
    expect(measured.spreadBps).toBeCloseTo(0.9095, 3);
    expect(measured.bidDepthUsdt).toBeCloseTo(109_950 + 54_970, 3);
    // Walking both sides of the visible book.
    expect(sweepBps(book.asks, measured.mid, 250_000, true)).toBeNull();
    expect(measureBook(book, [250_000]).impact[0]!.buyBps).toBeNull();
  });

  it('bounds its retries so a venue outage cannot stall a research run', async () => {
    let calls = 0;
    const dead = (async () => {
      calls++;
      throw new Error('connection refused');
    }) as typeof fetch;
    await expect(
      fetchHlBook('SOL', { fetcher: dead, attempts: 1 }),
    ).rejects.toThrow('connection refused');
    expect(calls).toBe(1);
  });

  it('rejects a crossed book, an empty side and an unexpected payload', async () => {
    const crossed = (async () =>
      json(l2Book([[100, 1]], [[99, 1]]))) as typeof fetch;
    await expect(fetchHlBook('SOL', { fetcher: crossed })).rejects.toThrow(
      'Crossed order book',
    );
    const emptySide = (async () =>
      json({
        coin: 'SOL',
        time: 1,
        levels: [[], [{ px: '1', sz: '1' }]],
      })) as typeof fetch;
    await expect(fetchHlBook('SOL', { fetcher: emptySide })).rejects.toThrow(
      'Order book side is empty',
    );
    const noLevels = (async () =>
      json({ coin: 'SOL', time: 1 })) as typeof fetch;
    await expect(fetchHlBook('SOL', { fetcher: noLevels })).rejects.toThrow(
      'Unexpected l2Book response',
    );
    const badTimestamp = (async () =>
      json({
        coin: 'SOL',
        time: 'soon',
        levels: [[{ px: '1', sz: '1' }], [{ px: '2', sz: '1' }]],
      })) as typeof fetch;
    await expect(fetchHlBook('SOL', { fetcher: badTimestamp })).rejects.toThrow(
      'Unexpected l2Book timestamp',
    );
  });
});
