import { mean } from './index.js';

export const MINUTE = 60000;
export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  quoteVolume: number;
}
interface Columns {
  close: Float64Array;
  volume: Float64Array;
}
/**
 * Minute bars on one shared clock. Bar i opens at startTs + i minutes and is
 * known only at its close, closeTimeAt(i). Missing bars stay NaN; nothing is
 * interpolated.
 */
export class BarStore {
  readonly symbols: string[];
  private cols = new Map<string, Columns>();
  private capacity: number;
  private n = 0;
  constructor(
    readonly startTs: number,
    symbols: readonly string[],
    capacity = 1024,
  ) {
    if (startTs % MINUTE) throw new Error('Bar clock must start on a minute');
    if (
      new Set(symbols).size !== symbols.length ||
      !symbols.includes('BTCUSDT')
    )
      throw new Error('Bar universe must contain BTC and unique symbols');
    this.symbols = [...symbols];
    this.capacity = Math.max(1, capacity);
    for (const s of symbols)
      this.cols.set(s, {
        close: new Float64Array(this.capacity).fill(NaN),
        volume: new Float64Array(this.capacity).fill(NaN),
      });
  }
  get length() {
    return this.n;
  }
  tsAt(i: number) {
    return this.startTs + i * MINUTE;
  }
  closeTimeAt(i: number) {
    return this.tsAt(i) + MINUTE;
  }
  /** Index of the bar whose close time is exactly `closeTs`. */
  indexClosingAt(closeTs: number) {
    if ((closeTs - this.startTs) % MINUTE)
      throw new Error('Clock is not on the bar grid');
    return (closeTs - this.startTs) / MINUTE - 1;
  }
  private grow(size: number) {
    if (size <= this.capacity) return;
    let next = this.capacity;
    while (next < size) next *= 2;
    for (const col of this.cols.values()) {
      for (const key of ['close', 'volume'] as const) {
        const array = new Float64Array(next).fill(NaN);
        array.set(col[key]);
        col[key] = array;
      }
    }
    this.capacity = next;
  }
  set(symbol: string, bar: Pick<Bar, 'ts' | 'close' | 'quoteVolume'>) {
    const col = this.cols.get(symbol);
    if (!col) throw new Error(`Symbol outside bar universe: ${symbol}`);
    if (bar.ts % MINUTE || bar.ts < this.startTs)
      throw new Error('Bar time is off the store clock');
    if (!(bar.close > 0) || !(bar.quoteVolume >= 0))
      throw new Error('Bars require a positive close and nonnegative volume');
    const i = (bar.ts - this.startTs) / MINUTE;
    this.grow(i + 1);
    this.cols.get(symbol)!.close[i] = bar.close;
    this.cols.get(symbol)!.volume[i] = bar.quoteVolume;
    this.n = Math.max(this.n, i + 1);
  }
  close(symbol: string, i: number) {
    if (i < 0 || i >= this.n) return NaN;
    return this.cols.get(symbol)?.close[i] ?? NaN;
  }
  /** Log return over `minutes` ending at bar i; null when either endpoint is missing. */
  logReturn(symbol: string, end: number, minutes: number) {
    const a = this.close(symbol, end - minutes),
      b = this.close(symbol, end);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.log(b / a) : null;
  }
  /** Quote volume and missing-bar count over the `minutes` bars ending at i. */
  activity(symbol: string, end: number, minutes: number) {
    const col = this.cols.get(symbol);
    let volume = 0,
      missing = 0;
    for (let i = end - minutes + 1; i <= end; i++) {
      const v = i >= 0 && i < this.n && col ? col.volume[i]! : NaN;
      if (Number.isFinite(v)) volume += v;
      else missing++;
    }
    return { volume, missing };
  }
}

export interface FitParams {
  estimationWindowMs: number;
  sampleIntervalMs: number;
  lookbackMs: number;
  holdMs: number;
  minFitSamples: number;
  minReversionSamples: number;
}
export interface ResidualFit {
  symbol: string;
  /** Close time of the last bar used; every input was known by then. */
  asOf: number;
  samples: number;
  alpha: number;
  beta: number;
  correlation: number;
  /** Standard deviations per sample interval. */
  residualVol: number;
  btcVol: number;
  altVol: number;
  /** Fraction of a past lookback residual that closed over the following hold (positive means catch-up). */
  reversion: number;
  reversionT: number;
  reversionSamples: number;
}
function ols(x: number[], y: number[]) {
  const n = x.length;
  if (n < 3) return null;
  const mx = mean(x),
    my = mean(y);
  let xx = 0,
    yy = 0,
    xy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx,
      dy = y[i]! - my;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  if (xx <= Number.EPSILON || yy <= Number.EPSILON) return null;
  const slope = xy / xx,
    intercept = my - slope * mx;
  let residual = 0;
  for (let i = 0; i < n; i++)
    residual += (y[i]! - intercept - slope * x[i]!) ** 2;
  const residualSd = Math.sqrt(residual / (n - 2));
  return {
    n,
    slope,
    intercept,
    correlation: Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))),
    residualSd,
    slopeSe: residualSd / Math.sqrt(xx),
    xSd: Math.sqrt(xx / (n - 1)),
    ySd: Math.sqrt(yy / (n - 1)),
  };
}
/**
 * Fits alt = alpha + beta * BTC on sample-interval returns, then measures how
 * past lookback residuals evolved over the next hold. Sample and reversion
 * anchors sit on absolute clock multiples, so a fit depends only on its
 * as-of bar, not on when a run started. All labels end by bar i.
 */
export function fitResidual(
  store: BarStore,
  symbol: string,
  i: number,
  p: FitParams,
): ResidualFit | null {
  const step = p.sampleIntervalMs / MINUTE,
    look = p.lookbackMs / MINUTE,
    hold = p.holdMs / MINUTE,
    asOf = store.closeTimeAt(i),
    windowStart = asOf - p.estimationWindowMs;
  const xs: number[] = [],
    ys: number[] = [];
  let end = store.indexClosingAt(
    Math.floor(asOf / p.sampleIntervalMs) * p.sampleIntervalMs,
  );
  for (; store.closeTimeAt(end - step) >= windowStart; end -= step) {
    const b = store.logReturn('BTCUSDT', end, step),
      a = store.logReturn(symbol, end, step);
    if (b !== null && a !== null) {
      xs.push(b);
      ys.push(a);
    }
  }
  if (xs.length < p.minFitSamples) return null;
  const fit = ols(xs, ys);
  if (!fit) return null;
  const past: number[] = [],
    future: number[] = [];
  let anchor = store.indexClosingAt(
    Math.floor((asOf - p.holdMs) / p.holdMs) * p.holdMs,
  );
  for (; store.closeTimeAt(anchor - look) >= windowStart; anchor -= hold) {
    const rb = store.logReturn('BTCUSDT', anchor, look),
      ra = store.logReturn(symbol, anchor, look),
      fb = store.logReturn('BTCUSDT', anchor + hold, hold),
      fa = store.logReturn(symbol, anchor + hold, hold);
    if (rb === null || ra === null || fb === null || fa === null) continue;
    past.push(ra - fit.slope * rb);
    future.push(fa - fit.slope * fb);
  }
  const rev = past.length >= p.minReversionSamples ? ols(past, future) : null;
  return {
    symbol,
    asOf,
    samples: fit.n,
    alpha: fit.intercept,
    beta: fit.slope,
    correlation: fit.correlation,
    residualVol: fit.residualSd,
    btcVol: fit.xSd,
    altVol: fit.ySd,
    reversion: rev ? -rev.slope : 0,
    reversionT: rev && rev.slopeSe > 0 ? -rev.slope / rev.slopeSe : 0,
    reversionSamples: rev?.n ?? past.length,
  };
}
