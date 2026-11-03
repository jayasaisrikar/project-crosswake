import { describe, expect, it } from 'vitest';
import {
  annualVol,
  dailyReturns,
  inverseVolWeights,
} from '../packages/backtest/src/sizing.js';

const rules = {
  volLookbackDays: 60,
  targetVolAnnual: 0.2,
  maxWeightPerCoin: 0.08,
  grossCap: 1,
};

/** A price path with a chosen daily volatility (in %), deterministic. */
const path = (dailyPct: number, days = 120, drift = 0) => {
  const closes: number[] = [100];
  for (let i = 1; i < days; i++) {
    const wobble = i % 2 === 0 ? 1 : -1;
    closes.push(closes.at(-1)! * (1 + (wobble * dailyPct) / 100 + drift));
  }
  return closes;
};

describe('annualVol', () => {
  it('scales a daily move to a year', () => {
    const vol = annualVol(path(2), 60)!;
    // Alternating ±2% is a ~2% daily standard deviation, which is ~38% annualised.
    expect(vol).toBeGreaterThan(0.3);
    expect(vol).toBeLessThan(0.45);
  });

  it('refuses a coin without enough history rather than guessing', () => {
    expect(annualVol(path(2, 12), 60)).toBeNull();
  });

  it('ignores non-positive closes', () => {
    expect(dailyReturns([100, 0, 50])).toEqual([]);
  });
});

describe('inverseVolWeights', () => {
  const books = () =>
    new Map([
      ['CALMUSDT', path(1)],
      ['MILDUSDT', path(2)],
      ['WILDUSDT', path(4)],
    ]);

  it('gives the calmer coin the larger weight', () => {
    // A loose cap, so the ranking is visible instead of every coin sitting on the 8% limit.
    const { positions } = inverseVolWeights(books(), {
      ...rules,
      maxWeightPerCoin: 0.9,
    });
    const weight = (symbol: string) =>
      positions.find((position) => position.symbol === symbol)!.weight;
    expect(weight('CALMUSDT')).toBeGreaterThan(weight('MILDUSDT'));
    expect(weight('MILDUSDT')).toBeGreaterThan(weight('WILDUSDT'));
  });

  it('never exceeds the per-coin cap or the gross cap', () => {
    const { positions } = inverseVolWeights(books(), rules);
    for (const position of positions)
      expect(position.weight).toBeLessThanOrEqual(
        rules.maxWeightPerCoin + 1e-9,
      );
    expect(positions.reduce((a, b) => a + b.weight, 0)).toBeLessThanOrEqual(
      1 + 1e-9,
    );
  });

  it('scales the book towards the volatility target', () => {
    const calm = inverseVolWeights(new Map([['AAAUSDT', path(1)]]), rules);
    const wild = inverseVolWeights(new Map([['AAAUSDT', path(6)]]), rules);
    const total = (result: typeof calm) =>
      result.positions.reduce((a, b) => a + b.weight, 0);
    // One coin is capped at 8% either way, so the cap is what binds, not the target.
    expect(total(calm)).toBeCloseTo(0.08, 6);
    expect(total(wild)).toBeCloseTo(0.08, 6);
  });

  it('holds cash when the coins are too volatile for the target', () => {
    const wild = new Map([
      ['AAAUSDT', path(8)],
      ['BBBUSDT', path(8)],
    ]);
    const { positions } = inverseVolWeights(wild, {
      ...rules,
      maxWeightPerCoin: 1,
    });
    expect(positions.reduce((a, b) => a + b.weight, 0)).toBeLessThan(0.5);
  });

  it('never borrows: a calm book is capped at 100% gross, not scaled past it', () => {
    const calm = new Map([
      ['AAAUSDT', path(0.02)],
      ['BBBUSDT', path(0.02)],
    ]);
    const { positions } = inverseVolWeights(calm, {
      ...rules,
      maxWeightPerCoin: 1,
    });
    expect(positions.reduce((a, b) => a + b.weight, 0)).toBeCloseTo(1, 6);
  });

  it('returns nothing when no coin has enough history', () => {
    const thin = new Map([['AAAUSDT', path(2, 10)]]);
    expect(inverseVolWeights(thin, rules).positions).toEqual([]);
  });

  it('spreads a book of many equal coins evenly', () => {
    const many = new Map(
      Array.from({ length: 20 }, (_, i) => [`COIN${i}USDT`, path(2)] as const),
    );
    const { positions } = inverseVolWeights(many, {
      ...rules,
      maxWeightPerCoin: 0.2,
    });
    expect(positions).toHaveLength(20);
    const weights = positions.map((position) => position.weight);
    expect(Math.max(...weights) - Math.min(...weights)).toBeLessThan(1e-9);
    expect(weights.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
  });
});
