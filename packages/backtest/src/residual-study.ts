import { mean } from '../../quant/src/index.js';
import {
  MINUTE,
  fitResidual,
  type BarStore,
  type ResidualFit,
} from '../../quant/src/residual.js';
import {
  roundTripCostBps,
  type ResidualConfig,
} from '../../signals/src/residual.js';

const EDGES = [-Infinity, -3, -2.5, -2, -1.5, -1, 1, 1.5, 2, 2.5, 3, Infinity];
function summary(values: number[]) {
  if (values.length < 2) return { n: values.length, meanBps: null, t: null };
  const m = mean(values),
    sd = Math.sqrt(
      values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1),
    );
  return {
    n: values.length,
    meanBps: m,
    t: sd > 0 ? m / (sd / Math.sqrt(values.length)) : null,
  };
}

/**
 * Filter-free edge study. At non-overlapping anchors spaced one hold apart,
 * it buckets each alt's lookback residual z and records what followed after
 * the entry delay: the alt's own return (what an outright trader earns) and
 * the residual change (what a hedged trader earns). Returns are signed so
 * that positive means the lag closed. Fits use only bars closed by the
 * anchor's last hourly refit clock.
 */
export function residualStudy(
  store: BarStore,
  config: ResidualConfig,
  range: { startTs: number; endTs: number },
) {
  const c = config,
    look = c.lookbackMs / MINUTE,
    hold = c.holdMs / MINUTE,
    delay = c.entryDelayMs / MINUTE,
    scale = Math.sqrt(c.lookbackMs / c.sampleIntervalMs),
    fits = new Map<string, ResidualFit | null>();
  const buckets = EDGES.slice(1).map((upper, k) => ({
    from: EDGES[k]!,
    to: upper,
    outright: [] as number[],
    hedged: [] as number[],
    confirmed: [] as number[],
  }));
  let anchors = 0;
  for (
    let t = Math.ceil(range.startTs / c.holdMs) * c.holdMs;
    t + c.entryDelayMs + c.holdMs <= range.endTs;
    t += c.holdMs
  ) {
    const i = store.indexClosingAt(t),
      clock = Math.floor(t / c.refitEveryMs) * c.refitEveryMs,
      btcPast = store.logReturn('BTCUSDT', i, look),
      btcNext = store.logReturn('BTCUSDT', i + delay + hold, hold);
    if (btcPast === null || btcNext === null) continue;
    anchors++;
    for (const symbol of c.symbols) {
      if (symbol === 'BTCUSDT') continue;
      const key = `${symbol}|${clock}`;
      if (!fits.has(key))
        fits.set(
          key,
          fitResidual(store, symbol, store.indexClosingAt(clock), c),
        );
      const fit = fits.get(key);
      const past = store.logReturn(symbol, i, look),
        next = store.logReturn(symbol, i + delay + hold, hold);
      if (!fit || past === null || next === null) continue;
      const z = (past - fit.beta * btcPast) / (fit.residualVol * scale),
        direction = z < 0 ? 1 : -1,
        bucket = buckets.find((b) => z >= b.from && z < b.to)!;
      bucket.outright.push(direction * next * 1e4);
      bucket.hedged.push(direction * (next - fit.beta * btcNext) * 1e4);
      if (direction * btcPast > 0)
        bucket.confirmed.push(direction * next * 1e4);
    }
  }
  return {
    lookbackMs: c.lookbackMs,
    holdMs: c.holdMs,
    entryDelayMs: c.entryDelayMs,
    anchors,
    outrightCostBps: roundTripCostBps({ ...c, instrument: 'outright' }, 0),
    buckets: buckets.map((b) => ({
      z: [b.from, b.to],
      side: b.to <= 0 ? 'LONG' : b.from >= 0 ? 'SHORT' : 'NONE',
      outright: summary(b.outright),
      hedged: summary(b.hedged),
      btcConfirmedOutright: summary(b.confirmed),
    })),
    limitations: [
      'Signed so positive means the lag closed; NONE rows are signed as if trading the reversal',
      'Gross of costs; compare meanBps with outrightCostBps or the hedged cost',
      'Fits are re-estimated hourly from trailing bars; anchors are non-overlapping per symbol but alts are cross-correlated',
    ],
  };
}
