import { describe, expect, it } from 'vitest';
import {
  DAY,
  drawdowns,
  extendSeries,
  readPositions,
  type Closes,
  type LedgerRow,
  type PerformancePayload,
} from '../apps/landing/lib/performance-live.js';

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;

const payload = (): PerformancePayload => ({
  summary: {
    version: 'trend-daily-v005',
    period: ['2024-12-31', '2026-10-01'],
    builtAt: '2026-10-17T00:00:00.000Z',
    model: {
      slots: 2,
      sizing: '',
      marking: '',
      costBpsRoundTrip: 30,
    },
    trades: 1,
    winRate: 1,
    avgNetBps: 100,
    bestBps: 100,
    worstBps: 100,
    longestLosingStreak: 0,
    avgExposure: 0,
    maxExposure: 0,
    totalReturn: { strategy: 0.1, btc: 0, basket: 0 },
    maxDrawdown: { strategy: -0.05, btc: 0, basket: 0 },
    worstDrawdown: { from: day('2026-01-01'), to: day('2026-02-01') },
    basketCoins: 1,
    live: {
      from: day('2026-10-01'),
      through: day('2026-10-16'),
      closedTrades: 0,
      openTrades: 1,
    } as PerformancePayload['summary']['live'],
    universe: ['AAAUSDT', 'BTCUSDT'],
    regimeSymbol: 'BTCUSDT',
  },
  points: [
    {
      t: day('2026-09-30'),
      strategy: 1.1,
      btc: 1.2,
      basket: 1.3,
      exposure: 0,
      drawdown: 0,
    },
    {
      t: day('2026-10-16'),
      strategy: 1.09,
      btc: 1.15,
      basket: 1.28,
      exposure: 0.5,
      drawdown: -0.01,
    },
  ],
});

const series = (pairs: [string, number][]) => {
  const days = pairs.map(([iso]) => utcDay(day(iso))).sort((a, b) => a - b);
  const closes = days.map(
    (at) => pairs.find(([iso]) => utcDay(day(iso)) === at)![1],
  );
  return { days, closes };
};

const closes = (): Closes =>
  new Map([
    [
      'AAAUSDT',
      series([
        ['2024-12-31', 10],
        ['2026-10-16', 20],
        ['2026-10-17', 22],
        ['2026-10-18', 22],
      ]),
    ],
    [
      'BTCUSDT',
      series([
        ['2024-12-31', 100],
        ['2026-10-16', 150],
        ['2026-10-17', 160],
        ['2026-10-18', 165],
      ]),
    ],
  ]);

describe('readPositions', () => {
  it('pairs each exit with the open position for its symbol', () => {
    const rows: LedgerRow[] = [
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-02'),
        price: 10,
        netBps: null,
      },
      {
        kind: 'exit',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-05'),
        price: 11,
        netBps: 900,
      },
      {
        kind: 'entry',
        symbol: 'BTCUSDT',
        fillAt: day('2026-10-06'),
        price: 100,
        netBps: null,
      },
    ];
    const positions = readPositions(rows);
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      symbol: 'AAAUSDT',
      entryDay: utcDay(day('2026-10-02')),
      exitDay: utcDay(day('2026-10-05')),
      netBps: 900,
    });
    expect(positions[1]).toMatchObject({ symbol: 'BTCUSDT', exitDay: null });
  });

  it('ignores an exit with no matching entry, and a duplicate entry', () => {
    const rows: LedgerRow[] = [
      {
        kind: 'exit',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-02'),
        price: 10,
        netBps: 100,
      },
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-03'),
        price: 10,
        netBps: null,
      },
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-04'),
        price: 12,
        netBps: null,
      },
    ];
    const positions = readPositions(rows);
    expect(positions).toHaveLength(1);
    expect(positions[0]!.entry).toBe(10);
  });
});

describe('extendSeries', () => {
  it('continues the published series from its last point without a jump', () => {
    const positions = readPositions([
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-12'),
        price: 19,
        netBps: null,
      },
    ]);
    const extension = extendSeries(
      payload(),
      positions,
      closes(),
      utcDay(day('2026-10-18')),
    );
    expect(extension).not.toBeNull();
    const points = extension!.points;
    expect(points.map((p) => new Date(p.t).toISOString().slice(0, 10))).toEqual(
      ['2026-10-17', '2026-10-18'],
    );
    // The last published point already marks the open position at 20, so only the move since is added.
    expect(points[0]!.strategy).toBeCloseTo(
      1.09 + 0.5 * (22 / 19 - 20 / 19),
      4,
    );
    expect(points[1]!.strategy).toBeCloseTo(points[0]!.strategy, 5);
    expect(points[0]!.exposure).toBe(0.5);
    // Benchmarks chain from their own published values.
    expect(points[0]!.btc).toBeCloseTo(1.15 * (160 / 150), 4);
    expect(points[0]!.basket).toBeCloseTo(1.28 * (22 / 20), 4);
    expect(extension!.live.through).toBe(utcDay(day('2026-10-18')));
    expect(extension!.live.openTrades).toBe(1);
  });

  it('books a closed trade at its exit fill and stops marking it', () => {
    const positions = readPositions([
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-12'),
        price: 19,
        netBps: null,
      },
      {
        kind: 'exit',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-17'),
        price: 22,
        netBps: 1500,
      },
    ]);
    const points = extendSeries(
      payload(),
      positions,
      closes(),
      utcDay(day('2026-10-18')),
    )!.points;
    expect(points[0]!.strategy).toBeCloseTo(
      1.09 + 0.5 * 0.15 - 0.5 * (20 / 19 - 1),
      4,
    );
    expect(points[0]!.exposure).toBe(0);
    expect(points[1]!.strategy).toBeCloseTo(points[0]!.strategy, 4);
  });

  it('returns null when the record has no daily close past the anchor', () => {
    const positions = readPositions([
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-12'),
        price: 19,
        netBps: null,
      },
    ]);
    expect(
      extendSeries(payload(), positions, closes(), utcDay(day('2026-10-16'))),
    ).toBeNull();
  });

  it('carries the last price of a coin that stopped trading', () => {
    const stops = closes();
    stops.set(
      'AAAUSDT',
      series([
        ['2024-12-31', 10],
        ['2026-10-16', 20],
        ['2026-10-17', 22],
      ]),
    );
    const positions = readPositions([
      {
        kind: 'entry',
        symbol: 'AAAUSDT',
        fillAt: day('2026-10-12'),
        price: 19,
        netBps: null,
      },
    ]);
    const points = extendSeries(
      payload(),
      positions,
      stops,
      utcDay(day('2026-10-18')),
    )!.points;
    expect(points[1]!.strategy).toBeCloseTo(points[0]!.strategy, 5);
    expect(points[1]!.basket).toBeCloseTo(points[0]!.basket, 5);
  });
});

describe('drawdowns', () => {
  it('measures from the running peak and reports the deepest span', () => {
    const points = payload().points.concat([
      {
        t: day('2026-10-17'),
        strategy: 1.2,
        btc: 1,
        basket: 1,
        exposure: 0,
        drawdown: 0,
      },
      {
        t: day('2026-10-18'),
        strategy: 0.9,
        btc: 1,
        basket: 1,
        exposure: 0,
        drawdown: 0,
      },
    ]);
    const result = drawdowns(points);
    expect(result.values.at(-1)).toBeCloseTo(0.9 / 1.2 - 1, 5);
    expect(result.worst).toBeCloseTo(0.9 / 1.2 - 1, 5);
    expect(result.span.to).toBe(points.length - 1);
  });
});
