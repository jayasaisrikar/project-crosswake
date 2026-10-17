import { describe, expect, it } from 'vitest';
import { kalmanHedge } from '../packages/quant/src/kalman.js';
import { kalmanSpread, rollingZ } from '../packages/quant/src/spread.js';
import parity from './fixtures/stat-arb-kalman.json' with { type: 'json' };

function random(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
}
const gaussian = (u: () => number) => () =>
  Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());

/** x: random walk; y = beta(t)·x + 0.2 + noise. */
function pair(n: number, beta: (t: number) => number, seed = 3, noise = 0.001) {
  const g = gaussian(random(seed)),
    x: number[] = [],
    y: number[] = [];
  let level = 0;
  for (let t = 0; t < n; t++) {
    level += 0.1 * g();
    x.push(level);
    y.push(beta(t) * level + 0.2 + noise * g());
  }
  return { x, y };
}

describe('kalman hedge (v009)', () => {
  it('recovers a known beta', () => {
    const { x, y } = pair(2000, () => 1.5);
    const { steps } = kalmanHedge(y, x, {
      delta: 1e-5,
      initBars: 200,
      scaleObsVar: true,
    });
    expect(Math.abs(steps.at(-1)!.beta - 1.5)).toBeLessThan(0.02);
  });

  it('tracks a beta step faster with more process noise', () => {
    const { x, y } = pair(3000, (t) => (t < 1000 ? 1 : 2), 5, 0.1);
    const cross = (delta: number) => {
      const { steps } = kalmanHedge(y, x, {
        delta,
        initBars: 200,
        scaleObsVar: true,
      });
      return steps.findIndex((s, t) => t >= 1000 && s.betaPrior > 1.5) - 1000;
    };
    const fast = cross(1e-4),
      slow = cross(1e-5),
      slower = cross(1e-6);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(100);
    expect(slow).toBeGreaterThan(fast);
    expect(slower).toBeGreaterThan(slow);
  });

  it('builds the innovation from the prior state, and the prior is the previous posterior', () => {
    const { x, y } = pair(300, () => 1.2);
    const { steps } = kalmanHedge(y, x, {
      delta: 1e-4,
      initBars: 50,
      scaleObsVar: true,
    });
    steps.forEach((s, t) => {
      expect(s.error).toBe(y[t]! - (s.betaPrior * x[t]! + s.alphaPrior));
      if (t > 0) {
        expect(s.betaPrior).toBe(steps[t - 1]!.beta);
        expect(s.alphaPrior).toBe(steps[t - 1]!.alpha);
      }
    });
  });

  it('is causal: truncating the input never changes earlier steps', () => {
    const { x, y } = pair(400, () => 0.8);
    const opts = { delta: 1e-4, initBars: 50, scaleObsVar: true },
      full = kalmanHedge(y, x, opts).steps;
    for (const k of [60, 200, 399]) {
      const part = kalmanHedge(
        y.slice(0, k + 1),
        x.slice(0, k + 1),
        opts,
      ).steps;
      expect(part).toEqual(full.slice(0, k + 1));
    }
  });

  it('skips missing observations without propagating NaN', () => {
    const { x, y } = pair(300, () => 1.1);
    x[120] = NaN;
    y[121] = NaN;
    const { steps } = kalmanHedge(y, x, {
      delta: 1e-4,
      initBars: 50,
      scaleObsVar: true,
    });
    expect(Number.isNaN(steps[120]!.error)).toBe(true);
    expect(steps[120]!.beta).toBe(steps[119]!.beta);
    expect(steps[121]!.beta).toBe(steps[120]!.beta);
    expect(
      steps
        .slice(122)
        .every((s) =>
          [s.beta, s.alpha, s.error, s.errorStd].every(Number.isFinite),
        ),
    ).toBe(true);
  });

  it('matches stat-arb kalmanHedge exactly on its own fixture', () => {
    const { steps } = kalmanHedge(parity.y, parity.x, parity.opts);
    parity.out.forEach((o, t) => {
      expect(Math.abs(steps[t]!.beta - o.beta)).toBeLessThan(1e-12);
      expect(Math.abs(steps[t]!.alpha - o.alpha)).toBeLessThan(1e-12);
      expect(Math.abs(steps[t]!.error - o.error)).toBeLessThan(1e-12);
      expect(Math.abs(steps[t]!.errorStd - o.errorStd)).toBeLessThan(1e-12);
    });
  });

  it('spread uses prior states and rolling z includes the current value', () => {
    const { x, y } = pair(200, () => 1.3);
    const { steps } = kalmanHedge(y, x, {
        delta: 1e-4,
        initBars: 50,
        scaleObsVar: true,
      }),
      spread = kalmanSpread(y, x, steps);
    expect(
      spread
        .map((s, t) => s - steps[t]!.error)
        .every((d) => Math.abs(d) < 1e-15),
    ).toBe(true);
    const r = rollingZ([1, 2, 3, 4, 10], 5)!;
    expect(r.mean).toBe(4);
    expect(r.z).toBeCloseTo((10 - 4) / Math.sqrt((9 + 4 + 1 + 0 + 36) / 4));
    expect(rollingZ([1, NaN, 3], 3)).toBeNull();
    expect(rollingZ([1, 2], 3)).toBeNull();
  });
});
