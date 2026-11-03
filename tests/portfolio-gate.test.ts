import { describe, expect, it } from 'vitest';
import {
  maxDrawdownBps,
  portfolioGate,
  segmentStats,
  symbolClusteredCi,
  type PortfolioCriteria,
  type StrategyTrade,
} from '../packages/backtest/src/portfolio-gate.js';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

const trade = (
  symbol: string,
  entry: string,
  exit: string,
  netBps: number,
): StrategyTrade => ({
  symbol,
  entryTs: at(entry),
  exitTs: at(exit),
  netBps,
});

const criteria: PortfolioCriteria = {
  minClosedTrades: 10,
  minNetExpectancyBps: 50,
  minCiLowerBps: 0,
  minProfitSymbols: 4,
  maxSymbolPnlShare: 0.25,
  maxDrawdownBps: 2000,
  minPositiveSegments: 2,
  minPositiveSegmentShare: 0.5,
};

const segments = [
  { label: 'btc-up', from: at('2026-01-01'), to: at('2026-03-01') },
  { label: 'btc-down', from: at('2026-03-01'), to: at('2026-05-01') },
];

/** Twelve trades over five coins, spread evenly, profitable in both regimes. */
const healthy = () =>
  [
    trade('AAAUSDT', '2026-01-05', '2026-01-20', 300),
    trade('BBBUSDT', '2026-01-08', '2026-01-25', 220),
    trade('CCCUSDT', '2026-01-12', '2026-02-02', 180),
    trade('DDDUSDT', '2026-01-15', '2026-02-10', -150),
    trade('EEEUSDT', '2026-01-20', '2026-02-18', 260),
    trade('AAAUSDT', '2026-01-28', '2026-02-14', 140),
    trade('BBBUSDT', '2026-03-02', '2026-03-18', 210),
    trade('CCCUSDT', '2026-03-05', '2026-03-24', 190),
    trade('DDDUSDT', '2026-03-09', '2026-03-29', -120),
    trade('EEEUSDT', '2026-03-12', '2026-04-04', 320),
    trade('AAAUSDT', '2026-03-18', '2026-04-09', 120),
    trade('BBBUSDT', '2026-03-24', '2026-04-15', 160),
  ].sort((a, b) => a.exitTs - b.exitTs);

describe('portfolioGate', () => {
  it('passes a book with breadth, a CI above zero and both regimes positive', () => {
    const result = portfolioGate(healthy(), criteria, segments);
    expect(result.reasons).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.stats.profitSymbols).toBe(4);
    expect(result.stats.netExpectancyCi95![0]).toBeGreaterThan(0);
  });

  it('fails a book whose whole result is one coin, which v005 could not', () => {
    const trades = [
      trade('ZECUSDT', '2026-01-05', '2026-02-20', 24_000),
      trade('AAAUSDT', '2026-01-08', '2026-01-25', -40),
      trade('BBBUSDT', '2026-01-12', '2026-02-02', -60),
      trade('CCCUSDT', '2026-01-15', '2026-02-10', -30),
      trade('DDDUSDT', '2026-01-20', '2026-02-18', -50),
      trade('EEEUSDT', '2026-03-02', '2026-03-18', -20),
      trade('AAAUSDT', '2026-03-05', '2026-03-24', 10),
      trade('BBBUSDT', '2026-03-09', '2026-03-29', -30),
      trade('CCCUSDT', '2026-03-12', '2026-04-04', -25),
      trade('DDDUSDT', '2026-03-18', '2026-04-09', -15),
    ];
    const result = portfolioGate(trades, criteria, segments);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('pnl_concentration');
    expect(result.reasons).toContain('symbol_breadth');
  });

  it('fails a book that only works when Bitcoin rises', () => {
    const trades = healthy().map((entry) =>
      entry.entryTs < at('2026-03-01')
        ? entry
        : { ...entry, netBps: -entry.netBps },
    );
    const result = portfolioGate(trades, criteria, segments);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('regime_instability');
  });

  it('fails when no regime split was supplied instead of passing quietly', () => {
    const result = portfolioGate(healthy(), criteria, []);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('regime_split_unavailable');
  });

  it('fails a thin sample even when every trade won', () => {
    const trades = healthy()
      .slice(0, 6)
      .map((entry) => ({ ...entry, netBps: 400 }));
    const result = portfolioGate(trades, criteria, segments);
    expect(result.reasons).toContain('insufficient_closed_trades');
  });

  it('counts open positions as unfinished rather than dropping them', () => {
    const trades = [
      ...healthy(),
      { ...trade('AAAUSDT', '2026-04-20', '2026-04-20', 0) },
    ];
    const result = portfolioGate(trades, criteria, segments);
    expect(result.reasons).toContain('unfinished_positions');
  });
});

describe('symbolClusteredCi', () => {
  it('is deterministic for a fixed seed', () => {
    const a = symbolClusteredCi(healthy());
    const b = symbolClusteredCi(healthy());
    expect(a).toEqual(b);
  });

  it('cannot manufacture confidence from one symbol', () => {
    const oneCoin = Array.from({ length: 40 }, (_, index) =>
      trade('ZECUSDT', '2026-01-05', '2026-01-20', 100 + index),
    );
    expect(symbolClusteredCi(oneCoin)).toBeNull();
  });

  it('widens when the coins disagree', () => {
    const mixed = [
      ...Array.from({ length: 5 }, () =>
        trade('AAAUSDT', '2026-01-05', '2026-01-20', 500),
      ),
      ...Array.from({ length: 5 }, () =>
        trade('BBBUSDT', '2026-01-05', '2026-01-20', -500),
      ),
      ...Array.from({ length: 5 }, () =>
        trade('CCCUSDT', '2026-01-05', '2026-01-20', 20),
      ),
      ...Array.from({ length: 5 }, () =>
        trade('DDDUSDT', '2026-01-05', '2026-01-20', -20),
      ),
    ];
    const ci = symbolClusteredCi(mixed)!;
    expect(ci[0]).toBeLessThan(0);
    expect(ci[1]).toBeGreaterThan(0);
  });
});

describe('risk helpers', () => {
  it('measures drawdown on an equal-notional curve', () => {
    const trades = [
      trade('AAAUSDT', '2026-01-05', '2026-01-10', 300),
      trade('BBBUSDT', '2026-01-06', '2026-01-12', -500),
      trade('CCCUSDT', '2026-01-07', '2026-01-14', -100),
    ];
    // 600 bps of slot returns spread over three coins is 200 bps of capital.
    expect(maxDrawdownBps(trades)).toBe(200);
  });

  it('splits expectancy by segment and marks empty ones', () => {
    const stats = segmentStats(healthy(), [
      ...segments,
      { label: 'empty', from: at('2026-06-01'), to: at('2026-07-01') },
    ]);
    expect(stats[0]!.trades).toBe(6);
    expect(stats[0]!.netExpectancyBps).toBeGreaterThan(0);
    expect(stats[2]!.netExpectancyBps).toBeNull();
  });
});
