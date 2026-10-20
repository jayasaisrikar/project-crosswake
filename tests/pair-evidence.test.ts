import { describe, expect, it } from 'vitest';
import {
  pairEvidenceGate,
  pairReport,
  eventConcentration,
} from '../packages/backtest/src/pair-evidence.js';
import type { PaperTrade } from '../packages/backtest/src/index.js';

const HOUR = 3600000;
const start = Date.UTC(2026, 0, 1);

function trade(i: number, over: Partial<PaperTrade> = {}): PaperTrade {
  return {
    signalId: `s${i}`,
    btcImpulseId: `e${Math.floor(i / 2)}`,
    symbol: i % 2 ? 'ETHUSDT' : 'SOLUSDT',
    entryTs: start + i * HOUR,
    entryPrice: 100,
    exitTs: start + i * HOUR + 500,
    exitPrice: 100,
    grossReturnBps: 0,
    feeBps: 1,
    slippageBps: 1,
    netReturnBps: i % 10 < 7 ? 10 : -10,
    maeBps: -10,
    mfeBps: 10,
    exitReason: 'time',
    ...over,
  };
}

const criteria = {
  policy: 'net-expectancy' as const,
  minClosedTrades: 10,
  minWinRate: 0.3,
  minProfitFactor: 1.1,
  minEvents: 2,
  minAssets: 2,
  maxDrawdownBps: 100000,
  maxAssetPnlShare: 1,
};

describe('pairReport', () => {
  it('scores each symbol on its own net, not the pooled book', () => {
    const trades = [
      trade(0, { symbol: 'SOLUSDT', netReturnBps: 100 }),
      trade(1, { symbol: 'ETHUSDT', netReturnBps: -50 }),
      trade(2, { symbol: 'SOLUSDT', netReturnBps: 20 }),
    ];
    const report = pairReport(trades);
    expect(report.profitablePairs).toBe(1);
    const sol = report.pairs.find((p) => p.symbol === 'SOLUSDT');
    expect(sol).toMatchObject({ trades: 2, netBps: 120 });
  });
});

describe('eventConcentration', () => {
  it('groups trades on the impulse that produced them', () => {
    const trades = [
      trade(0, { btcImpulseId: 'e1', netReturnBps: 80 }),
      trade(1, { btcImpulseId: 'e1', netReturnBps: -20 }),
      trade(2, { btcImpulseId: 'e2', netReturnBps: 10 }),
    ];
    const events = eventConcentration(trades);
    expect(events.eventCount).toBe(2);
    expect(events.positiveEvents).toBe(2);
    expect(events.largestEventAbsolutePnlShare).toBeCloseTo(60 / 70, 5);
  });
});

describe('pairEvidenceGate', () => {
  it('passes a well-spread winning book and reports pair/event views alongside the metrics', () => {
    const trades = Array.from({ length: 1200 }, (_, i) => trade(i));
    const gate = pairEvidenceGate(trades, criteria);
    expect(gate.passed).toBe(true);
    expect(gate.pairs.profitablePairs).toBeGreaterThanOrEqual(1);
    expect(gate.events.eventCount).toBe(600);
  });

  it('fails when no pair is independently profitable even if the pooled book wins', () => {
    const trades = Array.from({ length: 60 }, (_, i) =>
      trade(i, { symbol: 'SOLUSDT', btcImpulseId: `e${i}` }),
    );
    const gate = pairEvidenceGate(trades, {
      ...criteria,
      minProfitPairs: 2,
      minEvents: 10,
    });
    expect(gate.reasons).toContain('insufficient_profitable_pairs');
    expect(gate.reasons).toContain('asset_concentration');
  });

  it('fails when one BTC event carries the whole book', () => {
    const trades = Array.from({ length: 60 }, (_, i) =>
      trade(i, {
        btcImpulseId: 'e-one',
        netReturnBps: i < 3 ? 200 : -1,
      }),
    );
    const gate = pairEvidenceGate(trades, {
      ...criteria,
      minEvents: 1,
      maxEventPnlShare: 0.5,
      maxAssetPnlShare: 1,
    });
    expect(gate.reasons).toContain('event_concentration');
  });

  it('keeps the legacy reasons: unfinished and unobserved paths still fail', () => {
    expect(pairEvidenceGate([trade(0)], criteria, 1).reasons).toContain(
      'unfinished_positions',
    );
    expect(
      pairEvidenceGate([trade(0, { observedGapMs: 1000 })], criteria).reasons,
    ).toContain('unobserved_position_path');
  });
});
