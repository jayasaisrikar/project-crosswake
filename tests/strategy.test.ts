import { describe, it, expect } from 'vitest';
import {
  SignalEngine,
  strategySchema,
  type Candidate,
} from '../packages/signals/src/index.js';
import {
  PaperBacktester,
  metrics,
  wilson,
  clusterBootstrap,
} from '../packages/backtest/src/index.js';
import type { Snapshot } from '../packages/domain/src/index.js';
import defaults from '../configs/catch-up-v001.json' with { type: 'json' };
const start = 1700000000000;
const config = strategySchema.parse({
  ...defaults,
  horizonMs: 1000,
  windowMs: 60000,
  minSamples: 20,
  relationshipRefreshMs: 1000,
  lagGridMs: [1000, 2000],
  minLagMs: 1000,
  maxLagMs: 2000,
  minLagCorrelation: -1,
  impulseMinMove: 0.005,
  impulseZMin: 1,
  minBtcQuoteVolume: 0,
  minStability: 0,
  feeBpsPerSide: 1,
  slippageBpsPerSide: 1,
  minConfidence: 50,
  maxHoldMs: 3000,
  costSafetyMultiple: 1,
});
function snapshot(symbol: string, ts: number, price: number): Snapshot {
  return {
    ts,
    symbol,
    open: price,
    high: price,
    low: price,
    close: price,
    baseVolume: 1,
    quoteVolume: 1000,
    buyQuoteVolume: 500,
    sellQuoteVolume: 500,
    tradeCount: 1,
    bestBid: price * (1 - 0.0001),
    bestAsk: price * (1 + 0.0001),
    spreadBps: 2,
    sourceLatencyMs: 5,
    isComplete: true,
    quoteClock: 'receipt',
    quoteTs: ts - 1,
  };
}
function candidate(direction = 1) {
  const engine = new SignalEngine(config);
  let b = 100,
    a = 100,
    seed = 17;
  for (let i = 0; i < 180; i++) {
    seed = (seed * 16807) % 2147483647;
    const r = (seed / 2147483647 - 0.5) * 0.001;
    b *= Math.exp(r);
    a *= Math.exp(2 * r + (i % 2 ? 1 : -1) * 0.00001);
    engine.update([
      snapshot('BTCUSDT', start + i * 1000, b),
      snapshot('ETHUSDT', start + i * 1000, a),
    ]);
  }
  b *= Math.exp(direction * 0.01);
  const rows = [
    snapshot('BTCUSDT', start + 180000, b),
    snapshot('ETHUSDT', start + 180000, a),
  ];
  const signals = engine.update(rows);
  return { signal: signals[0]!, rows };
}
describe('causal signals and long-only paper fills', () => {
  it('keeps the gap target anchored at decision price rather than chasing entry price', () => {
    const { signal } = candidate();
    const bt = new PaperBacktester(config);
    bt.submit([signal]);
    const ts = signal.decisionTs + 1000;
    bt.update([
      snapshot('BTCUSDT', ts, signal.btcDecisionPrice),
      snapshot(
        signal.symbol,
        ts,
        signal.decisionPrice * Math.exp(signal.reactionGap * 0.4),
      ),
    ]);
    bt.update([
      snapshot('BTCUSDT', ts + 1000, signal.btcDecisionPrice),
      snapshot(
        signal.symbol,
        ts + 1000,
        signal.decisionPrice * Math.exp(signal.reactionGap * 0.75),
      ),
    ]);
    expect(bt.trades[0]?.exitReason).toBe('target');
    const missed = new PaperBacktester(config);
    missed.submit([signal]);
    missed.update([
      snapshot('BTCUSDT', ts, signal.btcDecisionPrice),
      snapshot(
        signal.symbol,
        ts,
        signal.decisionPrice * Math.exp(signal.reactionGap * 0.8),
      ),
    ]);
    expect(missed.rejections[0]?.reason).toBe('target_reached_before_entry');
  });

  it('bootstraps entire BTC events deterministically and declines one-event evidence', () => {
    const { signal } = candidate();
    const bt = new PaperBacktester(config);
    bt.submit([signal]);
    const ts = signal.decisionTs + 1000;
    bt.update([
      snapshot('BTCUSDT', ts, signal.btcDecisionPrice),
      snapshot(signal.symbol, ts, signal.decisionPrice),
    ]);
    bt.update([
      snapshot('BTCUSDT', ts + 4000, signal.btcDecisionPrice),
      snapshot(signal.symbol, ts + 4000, signal.decisionPrice),
    ]);
    const base = bt.trades[0]!;
    expect(clusterBootstrap([base])).toBeNull();
    const trades = [
      { ...base, btcImpulseId: 'a', netReturnBps: 10 },
      { ...base, btcImpulseId: 'a', netReturnBps: 20 },
      { ...base, btcImpulseId: 'b', netReturnBps: -10 },
    ];
    const result = clusterBootstrap(trades)!;
    expect(result.eventCount).toBe(2);
    expect(result).toEqual(clusterBootstrap(trades));
    expect(result.netExpectancyBps95[0]).toBe(-10);
    expect(result.netExpectancyBps95[1]).toBe(15);
  });
  it('fits pre-impulse history and freezes deterministic candidate evidence', () => {
    const a = candidate(),
      b = candidate();
    expect(a.signal).toEqual(b.signal);
    expect(a.signal.relationship.beta).toBeCloseTo(2, 1);
    expect(a.signal.relationship.asOf).toBeLessThan(a.signal.ts);
    expect(a.signal).toMatchObject({
      side: 'LONG',
      accepted: true,
      executable: true,
    });
  });
  it('stores valid short candidates without executable trades', () => {
    const { signal } = candidate(-1);
    expect(signal).toMatchObject({
      side: 'SHORT',
      accepted: true,
      executable: false,
    });
    const bt = new PaperBacktester(config);
    bt.submit([{ ...signal, executable: true }]);
    expect(bt.unfinished.pending).toBe(0);
  });
  it('requires post-decision quote receipt and charges spread once', () => {
    const { signal } = candidate();
    const bt = new PaperBacktester(config);
    bt.submit([signal]);
    const at = signal.decisionTs + 1000;
    const batch = (ts: number, quoteTs = ts - 1) => [
      snapshot('BTCUSDT', ts, signal.btcDecisionPrice),
      { ...snapshot(signal.symbol, ts, signal.decisionPrice), quoteTs },
    ];
    bt.update(batch(at, signal.decisionTs));
    expect(bt.unfinished).toMatchObject({ pending: 1, openPositions: 0 });
    bt.update(batch(at + 1000));
    expect(bt.unfinished.openPositions).toBe(1);
    bt.update(batch(at + 4000));
    expect(bt.trades).toHaveLength(1);
    const trade = bt.trades[0]!;
    expect(trade.entryTs).toBeGreaterThan(signal.decisionTs);
    expect(trade.grossReturnBps).toBeCloseTo(-2, 2);
    expect(trade.netReturnBps).toBeCloseTo(-6, 2);
    expect(trade.exitReason).toBe('time');
  });
  it('rejects failed BTC impulses and prevents multiple positions per event', () => {
    const { signal } = candidate();
    const bt = new PaperBacktester(config);
    bt.submit([signal]);
    const ts = signal.decisionTs + 1000;
    bt.update([
      snapshot('BTCUSDT', ts, signal.btcDecisionPrice * 0.98),
      snapshot(signal.symbol, ts, signal.decisionPrice),
    ]);
    expect(bt.rejections[0]?.reason).toBe('btc_impulse_retraced');
    const single = new PaperBacktester(config);
    const other: Candidate = {
      ...signal,
      id: 'other',
      symbol: 'SOLUSDT',
      confidence: signal.confidence - 1,
    };
    single.submit([other, signal]);
    single.update([
      snapshot('BTCUSDT', ts, signal.btcDecisionPrice),
      snapshot('ETHUSDT', ts, signal.decisionPrice),
      snapshot('SOLUSDT', ts, signal.decisionPrice),
    ]);
    expect(single.unfinished.openPositions).toBe(1);
    expect(single.rejections[0]?.reason).toBe('exposure_limit');
  });
  it('reports empty samples honestly with confidence intervals', () => {
    expect(metrics([])).toMatchObject({
      closedTrades: 0,
      winRate: null,
      netExpectancyBps: null,
    });
    expect(wilson(0, 0)).toBeNull();
    const ci = wilson(55, 100)!;
    expect(ci[0]).toBeLessThan(0.55);
    expect(ci[1]).toBeGreaterThan(0.55);
  });
});
