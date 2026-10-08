import { describe, expect, it } from 'vitest';
import {
  M15,
  adx,
  ema,
  rsi,
  rStats,
  runHtfRsi,
  sessionVwap,
  simulate,
  to4h,
  type Bar15,
  type HtfRsiRules,
  type HtfSignal,
} from '../packages/backtest/src/htf-rsi.js';

const bar = (i: number, o: number, h: number, l: number, c: number): Bar15 => ({
  ts: i * M15,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1,
});
const flat = (i: number, p: number) => bar(i, p, p, p, p);
const rules: HtfRsiRules = {
  emaFast: 20,
  emaSlow: 50,
  minEmaSpreadFrac: 0.003,
  adxPeriod: 14,
  adxMin: 20,
  rsiPeriod: 14,
  cooldownHours: 4,
  fundingMaxAgainst: 0.0005,
  atrPeriod: 14,
  atrMult: 1.2,
  maxStopFrac: 0.012,
  maxConcurrent: 2,
  scaleOutR: 1.5,
  scaleOutFrac: 0.5,
  breakevenAfterR: 1,
  trailAtrMult: 2,
  timeStopBars: 16,
  costBpsRoundTrip: 0,
};
// A long candidate at index 0 with stop 99; the fill is bar 1's open.
const cand = (stop = 99) =>
  ({
    index: 0,
    id: 'X',
    symbol: 'X',
    side: 'long',
    ts: M15,
    status: 'taken',
    close: 100,
    stop,
  }) as unknown as HtfSignal & { index: number };

describe('htf-rsi v007 indicators', () => {
  it('seeds EMA with the SMA and is causal', () => {
    const e = ema([1, 2, 3, 4], 3);
    expect(e[1]).toBeNaN();
    expect(e[2]).toBe(2);
    expect(e[3]).toBe(3);
    expect(ema([1, 2, 3, 99], 3).slice(0, 3)).toEqual(e.slice(0, 3));
  });
  it('computes Wilder RSI at the extremes', () => {
    expect(rsi([1, 2, 3, 4, 5], 2).at(-1)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 2).at(-1)).toBe(0);
  });
  it('ADX is high in a steady trend', () => {
    const up = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i, 101 + i, 99.5 + i, 100.5 + i));
    expect(adx(up, 14).at(-1)).toBeGreaterThan(50);
  });
  it('resets VWAP each UTC day', () => {
    const perDay = 86_400_000 / M15;
    const v = sessionVwap([flat(0, 10), flat(1, 20), flat(perDay, 50)]);
    expect(v).toEqual([10, 15, 50]);
  });
  it('builds only complete 4h bars', () => {
    const bars = Array.from({ length: 20 }, (_, i) => flat(i, i + 1));
    const h = to4h(bars);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ open: 1, close: 16, high: 16, low: 1 });
  });
});

describe('htf-rsi v007 trade management', () => {
  const atrs = new Array(40).fill(0.5);
  it('stops out at -1R with the stop checked before the target', () => {
    const bars = [flat(0, 100), flat(1, 100), bar(2, 100, 102, 98, 100)];
    const t = simulate(cand(), bars, atrs, [], rules);
    expect(t.exitReason).toBe('stop');
    expect(t.realizedR).toBeCloseTo(-1);
  });
  it('scales half at 1.5R, moves to breakeven and trails the rest', () => {
    const bars = [
      flat(0, 100),
      flat(1, 100),
      bar(2, 100, 101.6, 100, 101.5), // 1.5R hit: half at 101.5, stop to 100
      bar(3, 101.5, 104, 101.5, 104), // trail = 104 - 1 = 103
      bar(4, 104, 104, 102.5, 103),
    ];
    const t = simulate(cand(), bars, atrs, [], rules);
    expect(t.scaled).toBe(true);
    expect(t.exitReason).toBe('trail');
    expect(t.realizedR).toBeCloseTo(0.5 * 1.5 + 0.5 * 3);
  });
  it('exits at breakeven after 1R if price returns', () => {
    const bars = [flat(0, 100), flat(1, 100), bar(2, 100, 101.2, 100.2, 101), bar(3, 101, 101, 99.5, 99.8)];
    const t = simulate(cand(), bars, atrs, [], rules);
    expect(t.exitReason).toBe('stop');
    expect(t.realizedR).toBeCloseTo(0);
  });
  it('takes the time stop after 16 bars', () => {
    const bars = Array.from({ length: 30 }, (_, i) => flat(i, 100.3));
    bars[1] = flat(1, 100);
    const t = simulate(cand(), bars, atrs, [], rules);
    expect(t.exitReason).toBe('time');
    expect(t.exitTs).toBe(17 * M15);
    expect(t.realizedR).toBeCloseTo(0.3);
  });
  it('charges costs and funding in R', () => {
    const bars = Array.from({ length: 30 }, (_, i) => flat(i, 100));
    const t = simulate(cand(), bars, atrs, [{ ts: 5 * M15, rate: 0.001 }], { ...rules, costBpsRoundTrip: 10 });
    expect(t.costR).toBeCloseTo(0.1);
    expect(t.fundingR).toBeCloseTo(-0.1);
    expect(t.realizedR).toBeCloseTo(-0.2);
  });
  it('reports stats only on closed taken trades', () => {
    const mk = (r: number, w: number, status = 'taken', exitReason = 'stop') =>
      ({ ts: w * 7 * 86_400_000, status, exitReason, realizedR: r, costR: 0, fundingR: 0, rDistance: 1, entry: 100, symbol: 'X', side: 'long' }) as HtfSignal;
    const s = rStats([mk(2, 0), mk(-1, 1), mk(-1, 2), mk(5, 3, 'taken', 'open'), mk(9, 4, 'skipped')], 200)!;
    expect(s.trades).toBe(3);
    expect(s.expectancyR).toBe(0);
    expect(s.profitFactor).toBe(1);
  });
  it('produces no signals on flat data', () => {
    const bars = Array.from({ length: 2000 }, (_, i) => flat(i, 100));
    expect(runHtfRsi(new Map([['X', bars]]), new Map(), rules)).toEqual([]);
  });
});
