import { describe, it, expect } from 'vitest';
import {
  adfTest,
  asSignificance,
  benjaminiHochberg,
  dickeyFullerCritical,
  engleGranger,
  engleGrangerCritical,
  halfLife,
  isTradeableHalfLife,
  macKinnonPValue,
  normCdf,
} from '../packages/quant/src/stationarity.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(n: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(r(), 1e-12);
    const u2 = r();
    const mag = Math.sqrt(-2 * Math.log(u1));
    out.push(mag * Math.cos(2 * Math.PI * u2));
    out.push(mag * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

function randomWalk(n: number, seed: number): number[] {
  const steps = normals(n, seed);
  const out: number[] = [];
  let x = 0;
  for (const s of steps) {
    x += s;
    out.push(x);
  }
  return out;
}

function ar1(n: number, phi: number, seed: number): number[] {
  const e = normals(n, seed);
  const out: number[] = [];
  let s = 0;
  for (const v of e) {
    s = phi * s + v;
    out.push(s);
  }
  return out;
}

describe('normCdf', () => {
  it('matches known standard-normal quantiles', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.6448536)).toBeCloseTo(0.95, 4);
    expect(normCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normCdf(2.326348)).toBeCloseTo(0.99, 4);
  });
});

describe('macKinnonPValue (Engle-Granger, n=2)', () => {
  it('recovers the tabulated critical points', () => {
    expect(macKinnonPValue(-3.9, 2)).toBeCloseTo(0.01, 2);
    expect(macKinnonPValue(-3.34, 2)).toBeCloseTo(0.05, 2);
    expect(macKinnonPValue(-3.04, 2)).toBeCloseTo(0.1, 2);
  });

  it('is monotonic: more-negative tau gives smaller p', () => {
    expect(macKinnonPValue(-5, 2)).toBeLessThan(macKinnonPValue(-3.5, 2));
    expect(macKinnonPValue(-3.5, 2)).toBeLessThan(macKinnonPValue(-2, 2));
  });

  it('saturates outside the tabulated range', () => {
    expect(macKinnonPValue(5, 2)).toBe(1);
    expect(macKinnonPValue(-30, 2)).toBe(0);
  });

  it('plain ADF (n=1) is more lenient than EG (n=2) at the same tau', () => {
    expect(macKinnonPValue(-3.34, 1)).toBeLessThan(macKinnonPValue(-3.34, 2));
  });

  it('rejects an out-of-range n', () => {
    expect(() => macKinnonPValue(-3, 0)).toThrow();
    expect(() => macKinnonPValue(-3, 7)).toThrow();
  });
});

describe('adfTest', () => {
  it('rejects unit root for white noise (stationary)', () => {
    const r = adfTest(normals(500, 1));
    expect(r).not.toBeNull();
    expect(r!.tStat).toBeLessThan(-2.86);
    expect(r!.critical).toBe(dickeyFullerCritical(0.05));
  });

  it('fails to reject for a random walk (non-stationary)', () => {
    const r = adfTest(randomWalk(500, 2));
    expect(r).not.toBeNull();
    expect(r!.tStat).toBeGreaterThan(-2.86);
  });

  it('reports lags and observation count', () => {
    const r = adfTest(normals(300, 3));
    expect(r!.lagsUsed).toBeGreaterThanOrEqual(0);
    expect(r!.nobs).toBeGreaterThan(0);
  });

  it('returns null for a too-short series', () => {
    expect(adfTest([1, 2, 3])).toBeNull();
  });
});

describe('engleGranger', () => {
  it('finds cointegration when A = 2*B + mean-reverting noise', () => {
    const n = 600;
    const b = randomWalk(n, 10).map((v) => v + 100);
    const noise = normals(n, 11);
    const a = b.map((v, i) => 2 * v + noise[i]!);
    const r = engleGranger(a, b);
    expect(r).not.toBeNull();
    expect(r!.cointegrated).toBe(true);
    expect(r!.pValue).toBeLessThan(0.05);
    expect(r!.beta).toBeCloseTo(2, 1);
  });

  it('rejects two independent random walks', () => {
    const a = randomWalk(600, 20).map((v) => v + 100);
    const b = randomWalk(600, 21).map((v) => v + 100);
    const r = engleGranger(a, b);
    expect(r!.cointegrated).toBe(false);
  });

  it('keeps the false-positive rate near nominal on independent walks', () => {
    let fp = 0;
    const trials = 60;
    for (let k = 0; k < trials; k++) {
      const a = randomWalk(600, 1000 + k * 2).map((v) => v + 100);
      const b = randomWalk(600, 1001 + k * 2).map((v) => v + 100);
      if (engleGranger(a, b)!.cointegrated) fp++;
    }
    expect(fp / trials).toBeLessThan(0.1);
  });

  it('returns null for a degenerate (constant) series', () => {
    expect(engleGranger(new Array(100).fill(5), randomWalk(100, 4))).toBeNull();
  });
});

describe('halfLife', () => {
  it('recovers the half-life of an AR(1) process', () => {
    const phi = 0.9;
    const expected = -Math.LN2 / Math.log(phi);
    const hl = halfLife(ar1(5000, phi, 1));
    expect(hl).toBeGreaterThan(expected * 0.7);
    expect(hl).toBeLessThan(expected * 1.4);
  });

  it('reverts faster (shorter half-life) for smaller phi', () => {
    const fast = halfLife(ar1(5000, 0.5, 2));
    const slow = halfLife(ar1(5000, 0.95, 3));
    expect(fast).toBeLessThan(slow);
  });

  it('fails a tradeability gate for a random walk (sample half-life is noise)', () => {
    const hl = halfLife(randomWalk(600, 5));
    expect(hl).toBeGreaterThan(75);
    expect(isTradeableHalfLife(randomWalk(600, 5), 8, 75)).toBe(false);
    expect(halfLife([1])).toBe(Infinity);
  });

  it('gates a tradeable band', () => {
    const phi09 = halfLife(ar1(5000, 0.9, 1));
    expect(phi09).toBeGreaterThan(1);
    expect(phi09).toBeLessThan(75);
    expect(isTradeableHalfLife(ar1(5000, 0.9, 1), 1, 75)).toBe(true);
    expect(isTradeableHalfLife(ar1(2000, 0.3, 6), 8, 75)).toBe(false);
  });
});

describe('benjaminiHochberg', () => {
  it('rejects nothing when every p-value is large', () => {
    const r = benjaminiHochberg([0.4, 0.7, 0.9, 0.95], 0.1);
    expect(r.count).toBe(0);
    expect(r.threshold).toBe(0);
    expect(r.rejected.every((x) => !x)).toBe(true);
  });

  it('rejects the clear discoveries and controls the cutoff', () => {
    const pValues = [
      0.0001, 0.0002, 0.0003, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99,
    ];
    const r = benjaminiHochberg(pValues, 0.1);
    expect(r.count).toBe(3);
    expect(r.rejected.slice(0, 3)).toEqual([true, true, true]);
    expect(r.rejected.slice(3).every((x) => !x)).toBe(true);
  });

  it('handles the empty family', () => {
    expect(benjaminiHochberg([], 0.1)).toEqual({
      rejected: [],
      threshold: 0,
      count: 0,
    });
  });
});

describe('significance helpers', () => {
  it('maps alpha to the coarsest supported level', () => {
    expect(asSignificance(0.001)).toBe(0.01);
    expect(asSignificance(0.05)).toBe(0.05);
    expect(asSignificance(0.1)).toBe(0.1);
    expect(engleGrangerCritical(0.05)).toBeCloseTo(-3.34, 2);
  });
});
