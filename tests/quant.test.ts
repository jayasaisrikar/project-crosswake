import { describe, it, expect } from 'vitest';
import {
  regress,
  PriceSeries,
  relationship,
  logReturn,
} from '../packages/quant/src/index.js';
const start = 1700000000000;
describe('quant calculations', () => {
  it('recovers alpha and beta and handles degenerate inputs', () => {
    const fit = regress([1, 2, 3, 4], [5, 8, 11, 14]);
    expect(fit?.beta).toBeCloseTo(3);
    expect(fit?.alpha).toBeCloseTo(2);
    expect(fit?.r2).toBeCloseTo(1);
    expect(fit?.residualVol).toBeCloseTo(0);
    expect(regress([1, 1, 1], [2, 3, 4])).toBeNull();
    expect(() => regress([1], [2, 3])).toThrow();
    expect(() => logReturn(0, 1)).toThrow();
  });
  it('does not cross gaps or retain unbounded price history', () => {
    const s = new PriceSeries(3);
    for (let i = 0; i < 4; i++)
      s.add({
        ts: start + i * 1000,
        price: 100 + i,
        complete: i !== 2,
        quoteVolume: 1,
      });
    expect(s.get(start)).toBeUndefined();
    expect(s.returnAt(start + 3000, 2000)).toBeNull();
    expect(() =>
      s.add({ ts: start + 3000, price: 1, complete: true, quoteVolume: 0 }),
    ).toThrow('increasing');
  });
  it('recovers the correct direction of a known two-second lag', () => {
    const btc = new PriceSeries(400),
      alt = new PriceSeries(400),
      moves: number[] = [];
    let seed = 17,
      b = 100,
      a = 100;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 16807) % 2147483647;
      const r = (seed / 2147483647 - 0.5) * 0.01;
      moves.push(r);
      b *= Math.exp(r);
      a *= Math.exp(2 * (moves[i - 2] ?? 0));
      btc.add({
        ts: start + i * 1000,
        price: b,
        complete: true,
        quoteVolume: 1,
      });
      alt.add({
        ts: start + i * 1000,
        price: a,
        complete: true,
        quoteVolume: 1,
      });
    }
    const fit = relationship(
      btc,
      alt,
      start + 299000,
      200000,
      1000,
      [1000, 2000, 4000],
      60,
    );
    expect(fit?.lagMs).toBe(2000);
    expect(fit?.lagCorrelation).toBeCloseTo(1);
    expect(fit?.lagSamples).toBeGreaterThan(60);
  });
});
