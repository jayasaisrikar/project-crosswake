import { describe, expect, it } from 'vitest';
import {
  alphaBeta,
  momentumStats,
  momentumVerdict,
  runMomentum,
  type MomentumRules,
} from '../packages/backtest/src/momentum.js';
import type { DailyBar } from '../packages/backtest/src/trend.js';

const DAY = 86_400_000;
const series = (closes: number[]): DailyBar[] =>
  closes.map((c, i) => ({ ts: i * DAY, open: c, high: c, low: c, close: c }));
// Deterministic noisy path with drift, so vol is non-zero.
const path = (n: number, drift: number, seed: number) => {
  let x = 100,
    s = seed;
  return Array.from({ length: n }, () => {
    s = (s * 16807) % 2147483647;
    x *= 1 + drift + (s / 2147483647 - 0.5) * 0.04;
    return x;
  });
};
const rules: MomentumRules = {
  trend: { lookbacksDays: [5, 10] },
  xsmom: { formationDays: 5, skipDays: 1, rebalanceDays: 7 },
  volTargetAnnual: 0.2,
  volLookbackDays: 10,
  maxWeightPerAsset: 0.25,
  maxGrossLeverage: 2,
  allocation: { trend: 0.5, xsmom: 0.5 },
  costBpsPerSide: 7,
};

describe('momentum v008', () => {
  const bars = new Map([
    ['UP', series(path(80, 0.01, 1))],
    ['FLAT', series(path(80, 0, 2))],
    ['DOWN', series(path(80, -0.01, 3))],
  ]);
  const run = runMomentum(bars, rules);

  it('trend goes long rising and short falling coins after warmup', () => {
    const w = run.weights.trend[60]!;
    expect(w[0]).toBeGreaterThan(0);
    expect(w[2]).toBeLessThan(0);
    expect(run.weights.trend[5]!.every((x) => x === 0)).toBe(true);
  });

  it('cross-sectional book is dollar neutral and holds between weekly rebalances', () => {
    const i = run.days.findIndex(
        (d, k) => k > 20 && Math.round(d / DAY) % 7 === 0,
      ),
      w = run.weights.xsmom[i]!;
    expect(w[0]).toBeGreaterThan(0);
    expect(w[2]).toBeLessThan(0);
    expect(w[0]! + w[1]! + w[2]!).toBeCloseTo(0);
    expect([...run.weights.xsmom[i + 1]!]).toEqual([...w]);
  });

  it('respects per-coin and gross caps', () => {
    for (const w of run.weights.book) {
      expect(w.every((x) => Math.abs(x) <= 0.25 + 1e-12)).toBe(true);
      expect(w.reduce((a, x) => a + Math.abs(x), 0)).toBeLessThanOrEqual(
        2 + 1e-12,
      );
    }
  });

  it('is causal: changing a future price does not change earlier weights', () => {
    const changed = new Map(bars);
    const up = series(path(80, 0.01, 1));
    up[70]!.close = up[70]!.open = up[70]!.close * 3;
    changed.set('UP', up);
    const r2 = runMomentum(changed, rules);
    for (let i = 0; i < 70; i++)
      expect([...r2.weights.book[i]!]).toEqual([...run.weights.book[i]!]);
  });

  it('earns next-open to following-open returns and charges cost on turnover', () => {
    const flat = runMomentum(
      new Map([['A', series(Array(40).fill(100))]]),
      rules,
    );
    expect(
      flat.returns.book.filter(Number.isFinite).every((x) => x === 0),
    ).toBe(true);
    const i = 60,
      w = run.weights.book[i]!,
      prev = run.weights.book[i - 1]!,
      opens = [...bars.values()].map(
        (b) => b[i + 2]!.open / b[i + 1]!.open - 1,
      ),
      turnover = [...w].reduce((a, x, j) => a + Math.abs(x - prev[j]!), 0);
    expect(run.returns.book[i]).toBeCloseTo(
      [...w].reduce((a, x, j) => a + x * opens[j]!, 0) - (turnover * 7) / 1e4,
    );
    expect(Number.isNaN(run.returns.book.at(-1)!)).toBe(true);
  });

  it('stats, alpha and verdict', () => {
    const s = momentumStats(run, run.returns.book)!;
    expect(s.days).toBe(78);
    expect(s.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(alphaBeta(run, 0)).not.toBeNull();
    const a = {
      minDays: 90,
      minSharpe: 0.5,
      minSleeveSharpe: 0,
      maxDrawdown: 0.25,
      minAlphaVsEqualWeight: 0,
    };
    expect(momentumVerdict(run, a, 0).verdict).toBe('PENDING');
    expect(['PASS', 'FAIL']).toContain(
      momentumVerdict(run, { ...a, minDays: 10 }, 0).verdict,
    );
  });
});
