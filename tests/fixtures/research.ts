import defaults from '../../configs/catch-up-v001.json' with { type: 'json' };
import { strategySchema } from '../../packages/signals/src/index.js';
import {
  planSchema,
  freezeResearch,
} from '../../packages/backtest/src/research-plan.js';
import type { Snapshot } from '../../packages/domain/src/index.js';
export const start = 1700000000000;
export const config = strategySchema.parse({
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
  minConfidence: 50,
  feeBpsPerSide: 1,
  slippageBpsPerSide: 1,
  costSafetyMultiple: 1,
  maxHoldMs: 3000,
  cooldownMs: 10000,
});
export function snapshot(symbol: string, ts: number, price: number): Snapshot {
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
    sourceLatencyMs: 1,
    isComplete: true,
    quoteClock: 'receipt',
    quoteTs: ts - 1,
    availableAt: ts,
  };
}
export function frames(count = 540) {
  const frames: Snapshot[][] = [];
  let btc = 100,
    alt = 100,
    seed = 17;
  for (let i = 0; i < count; i++) {
    seed = (seed * 16807) % 2147483647;
    const move = (seed / 2147483647 - 0.5) * 0.001;
    btc *= Math.exp(move);
    alt *= Math.exp(move * 2 + (i % 2 ? 1 : -1) * 0.00001);
    if (i >= 180 && (i - 180) % 20 === 0) btc *= Math.exp(0.01);
    if (i >= 186 && (i - 186) % 20 === 0) alt *= Math.exp(0.016);
    frames.push([
      snapshot('BTCUSDT', start + i * 1000, btc),
      snapshot('ETHUSDT', start + i * 1000, alt),
    ]);
  }
  return frames;
}
const iso = (seconds: number) => new Date(start + seconds * 1000).toISOString();
export const plan = planSchema.parse({
  id: 'synthetic-protocol-only',
  source: 'live',
  symbols: ['BTCUSDT', 'ETHUSDT'],
  baseConfig: 'unused.json',
  variants: [
    { id: 'baseline', overrides: {} },
    { id: 'strict', overrides: { minConfidence: 100 } },
  ],
  minValidationTrades: 1,
  folds: [
    {
      id: 'fold-1',
      trainStart: iso(0),
      trainEnd: iso(180),
      validationEnd: iso(300),
      testEnd: iso(420),
    },
  ],
  holdout: { trainStart: iso(240), start: iso(420), end: iso(540) },
  acceptance: {
    minClosedTrades: 500,
    minWinRate: 0.55,
    minProfitFactor: 1.3,
    minEvents: 100,
    minAssets: 2,
  },
});
export const frozen = freezeResearch(plan, config, '2026-10-05T00:00:00.000Z');
export const loader = (data: Snapshot[][]) =>
  async function* (range: { startTs: number; endTs: number }) {
    for (const rows of data)
      if (rows[0]!.ts >= range.startTs && rows[0]!.ts < range.endTs) yield rows;
  };
