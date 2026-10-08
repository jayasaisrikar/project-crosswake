import { describe, expect, it } from 'vitest';
import { regimeByDay, runTrend, trendStats, type DailyBar } from '../packages/backtest/src/trend.js';

const DAY = 86_400_000;
const series = (closes: number[]): DailyBar[] =>
  closes.map((c, i) => ({ ts: i * DAY, open: c, high: c, low: c, close: c }));
const rules = { breakoutDays: 3, breakdownDays: 2, regimeSmaDays: 2, costBpsRoundTrip: 30 };

describe('trend v005', () => {
  it('enters at the next open after a breakout and exits on breakdown', () => {
    const bars = series([10, 10, 10, 11, 12, 13, 12, 11, 10, 10]);
    const regime = new Map(bars.map((b) => [b.ts, true]));
    const [t] = runTrend('X', bars, regime, rules);
    expect(t!.entryTs).toBe(4 * DAY);
    expect(t!.entry).toBe(12);
    expect(t!.exit).toBe(10);
    expect(t!.netBps).toBeCloseTo((10 / 12 - 1) * 1e4 - 30);
  });
  it('takes no trades while the regime is off and exits when it turns off', () => {
    const bars = series([10, 10, 10, 11, 12, 13, 14, 15]);
    expect(runTrend('X', bars, new Map(), rules)).toEqual([]);
    const regime = new Map(bars.map((b) => [b.ts, b.ts < 5 * DAY]));
    const [t] = runTrend('X', bars, regime, rules);
    expect(t!.reason).toBe('regime');
    expect(t!.exitTs).toBe(6 * DAY);
  });
  it('closes positions at a calendar gap', () => {
    const bars = series([10, 10, 10, 11, 12, 13]);
    bars[5]!.ts += DAY;
    const [t] = runTrend('X', bars, new Map(bars.map((b) => [b.ts, true])), rules);
    expect(t!.exitTs).toBe(4 * DAY);
  });
  it('computes the regime from the trailing SMA only', () => {
    const r = regimeByDay(series([1, 3, 2, 5]), 2);
    expect([...r.values()]).toEqual([true, false, true]);
  });
  it('reports win rate, expectancy and a bootstrap interval', () => {
    const t = (bps: number, w: number) => ({ symbol: 'X', entryTs: w * 7 * DAY, exitTs: w * 7 * DAY + DAY, entry: 1, exit: 1, netBps: bps, reason: 'breakdown' as const });
    const s = trendStats([t(300, 0), t(-100, 1), t(-100, 2)], 500);
    expect(s?.trades).toBe(3);
    if (s) {
      expect(s.winRate).toBeCloseTo(1 / 3);
      expect(s.netExpectancyBps).toBeCloseTo(100 / 3);
      expect(s.profitFactor).toBeCloseTo(1.5);
      expect(s.ci95[0]).toBeLessThanOrEqual(s.ci95[1]);
    }
  });
});
