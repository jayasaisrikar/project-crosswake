export function logReturn(current: number, previous: number) {
  if (!(current > 0 && previous > 0) || !Number.isFinite(current + previous))
    throw new Error('Returns require finite positive prices');
  return Math.log(current / previous);
}
export function mean(values: readonly number[]) {
  if (!values.length) throw new Error('Empty sample');
  return values.reduce((a, b) => a + b, 0) / values.length;
}
export function variance(values: readonly number[]) {
  if (values.length < 2) return null;
  const m = mean(values);
  return values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
}
export interface Regression {
  n: number;
  alpha: number;
  beta: number;
  correlation: number;
  r2: number;
  residualVol: number;
}
export function regress(
  x: readonly number[],
  y: readonly number[],
): Regression | null {
  if (x.length !== y.length) throw new Error('Unequal aligned sample');
  if (x.length < 3) return null;
  if ([...x, ...y].some((v) => !Number.isFinite(v)))
    throw new Error('Non-finite observation');
  const mx = mean(x),
    my = mean(y);
  let xx = 0,
    yy = 0,
    xy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx,
      dy = y[i]! - my;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  if (xx <= Number.EPSILON || yy <= Number.EPSILON) return null;
  const beta = xy / xx,
    alpha = my - beta * mx,
    correlation = Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)));
  let residual = 0;
  for (let i = 0; i < x.length; i++)
    residual += (y[i]! - alpha - beta * x[i]!) ** 2;
  return {
    n: x.length,
    alpha,
    beta,
    correlation,
    r2: correlation ** 2,
    residualVol: Math.sqrt(residual / (x.length - 2)),
  };
}
export interface Point {
  ts: number;
  price: number | null;
  complete: boolean;
  quoteVolume: number;
}
/** Exact clock lookups, bounded retention, and no interpolation across gaps. */
export class PriceSeries {
  private points = new Map<number, Point>();
  private order: number[] = [];
  private lastTs = 0;
  constructor(private capacity: number) {
    if (capacity < 2) throw new Error('Capacity too small');
  }
  add(point: Point) {
    if (point.ts <= this.lastTs)
      throw new Error('Price series requires strictly increasing timestamps');
    this.lastTs = point.ts;
    this.points.set(point.ts, point);
    this.order.push(point.ts);
    while (this.order.length > this.capacity)
      this.points.delete(this.order.shift()!);
  }
  get(ts: number) {
    return this.points.get(ts);
  }
  returnAt(ts: number, horizonMs: number): number | null {
    if (horizonMs < 1000 || horizonMs % 1000)
      throw new Error('Horizon must be whole seconds');
    const current = this.points.get(ts),
      prior = this.points.get(ts - horizonMs);
    if (
      !current?.complete ||
      !prior?.complete ||
      current.price === null ||
      prior.price === null
    )
      return null;
    for (let t = ts - horizonMs + 1000; t <= ts; t += 1000)
      if (!this.points.get(t)?.complete) return null;
    return logReturn(current.price, prior.price);
  }
  volumeAt(ts: number, horizonMs: number) {
    let volume = 0;
    for (let t = ts - horizonMs + 1000; t <= ts; t += 1000) {
      const p = this.points.get(t);
      if (!p?.complete) return null;
      volume += p.quoteVolume;
    }
    return volume;
  }
}
export interface Relationship extends Regression {
  asOf: number;
  lagMs: number;
  lagCorrelation: number;
  lagSamples: number;
  stability: number;
  btcVol: number;
}
export function relationship(
  btc: PriceSeries,
  asset: PriceSeries,
  asOf: number,
  windowMs: number,
  horizonMs: number,
  lags: readonly number[],
  minSamples: number,
): Relationship | null {
  const sample = (lag: number) => {
    const x: number[] = [],
      y: number[] = [];
    for (let end = asOf - windowMs + horizonMs; end <= asOf; end += horizonMs) {
      const a = btc.returnAt(end - lag, horizonMs),
        b = asset.returnAt(end, horizonMs);
      if (a !== null && b !== null) {
        x.push(a);
        y.push(b);
      }
    }
    return { x, y, fit: regress(x, y) };
  };
  const base = sample(0);
  if (!base.fit || base.fit.n < minSamples) return null;
  const v = variance(base.x);
  if (v === null || v === 0) return null;
  // Compare a predefined grid; selection remains exploratory until walk-forward confirmed.
  const lagged = lags
    .map((lag) => ({ lag, ...sample(lag) }))
    .filter((p) => p.fit && p.fit.n >= minSamples)
    .sort((a, b) => b.fit!.correlation - a.fit!.correlation || a.lag - b.lag);
  const best = lagged[0];
  if (!best?.fit) return null;
  const mid = Math.floor(base.x.length / 2),
    first = regress(base.x.slice(0, mid), base.y.slice(0, mid)),
    second = regress(base.x.slice(mid), base.y.slice(mid));
  const stability =
    first && second
      ? Math.max(0, 1 - Math.abs(first.correlation - second.correlation))
      : 0;
  return {
    ...base.fit,
    asOf,
    lagMs: best.lag,
    lagCorrelation: best.fit.correlation,
    lagSamples: best.fit.n,
    stability,
    btcVol: Math.sqrt(v),
  };
}
