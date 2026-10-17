/** Spread series, rolling z and diagnostics for hedged residual pairs (v009). All functions are causal. */
import type { KalmanStep } from './kalman.js';

/** spread_t = ln(alt_t) − betaPrior_t·ln(btc_t) − alphaPrior_t; NaN where either price is missing. */
export function kalmanSpread(
  lnAlt: number[],
  lnBtc: number[],
  steps: KalmanStep[],
) {
  return lnAlt.map(
    (y, t) => y - steps[t]!.betaPrior * lnBtc[t]! - steps[t]!.alphaPrior,
  );
}

/** One OLS of ln(alt) on ln(btc) over the finite pairs; null when x has no variance. */
export function olsHedge(lnAlt: number[], lnBtc: number[]) {
  const ys: number[] = [],
    xs: number[] = [];
  for (let t = 0; t < lnAlt.length; t++)
    if (Number.isFinite(lnAlt[t]) && Number.isFinite(lnBtc[t]))
      (ys.push(lnAlt[t]!), xs.push(lnBtc[t]!));
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n,
    my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++)
    ((sxy += (xs[i]! - mx) * (ys[i]! - my)), (sxx += (xs[i]! - mx) ** 2));
  if (sxx <= Number.EPSILON) return null;
  const beta = sxy / sxx;
  return { beta, alpha: my - beta * mx };
}

export const olsSpread = (
  lnAlt: number[],
  lnBtc: number[],
  h: { beta: number; alpha: number },
) => lnAlt.map((y, t) => y - h.beta * lnBtc[t]! - h.alpha);

/** Sample standard deviation (n−1) of the finite values; NaN with fewer than two. */
export function sampleSd(values: number[]) {
  const v = values.filter(Number.isFinite),
    n = v.length;
  if (n < 2) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}

/**
 * z of the last value against the last `window` values (including it). Null
 * unless all `window` values are finite and the sd is positive.
 */
export function rollingZ(spread: number[], window: number) {
  if (spread.length < window) return null;
  const w = spread.slice(-window);
  if (!w.every(Number.isFinite)) return null;
  const mean = w.reduce((a, b) => a + b, 0) / window,
    sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / (window - 1));
  if (!(sd > 0)) return null;
  return { z: (w.at(-1)! - mean) / sd, mean, sd };
}

/** sd(Kalman spread) / sd(OLS spread) over the same window; < 1 means the filter absorbs part of the spread. */
export const dispersionRatio = (kalman: number[], ols: number[]) =>
  sampleSd(kalman) / sampleSd(ols);
