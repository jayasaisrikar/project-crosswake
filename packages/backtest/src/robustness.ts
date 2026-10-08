import { PriceSeries, relationship, regress } from '../../quant/src/index.js';
import { referencePrice, type Snapshot } from '../../domain/src/index.js';
import type { Candidate } from '../../signals/src/index.js';
import { metrics, type PaperTrade } from './index.js';

/** Maximum-grid permutation control; research diagnostics never modify signal selection. */
export function lagStudy(
  btc: PriceSeries,
  asset: PriceSeries,
  asOf: number,
  windowMs: number,
  horizonMs: number,
  lags: readonly number[],
  minSamples = 20,
  resamples = 199,
  seed = 17,
) {
  if (!Number.isInteger(resamples) || resamples < 99 || !lags.length)
    throw new Error('Invalid lag study');
  const pairs = (lag: number, shift = 0) => {
    const x: number[] = [],
      y: number[] = [];
    for (
      let t = asOf - windowMs + horizonMs;
      t <= asOf - Math.max(0, shift);
      t += horizonMs
    ) {
      const a = btc.returnAt(t - lag + shift, horizonMs),
        b = asset.returnAt(t, horizonMs);
      if (a !== null && b !== null) {
        x.push(a);
        y.push(b);
      }
    }
    return { x, y };
  };
  const candidates = lags
    .map((lag) => {
      const p = pairs(lag);
      return { lag, ...p, fit: regress(p.x, p.y) };
    })
    .filter((p) => p.fit && p.fit.n >= minSamples);
  candidates.sort(
    (a, b) => b.fit!.correlation - a.fit!.correlation || a.lag - b.lag,
  );
  const best = candidates[0];
  if (!best)
    return {
      qualified: false,
      reason: 'insufficient_samples',
      best: null,
      correctedPermutationP: null,
      shifts: [],
    };
  // Shuffle blocks, preserving within-block serial dependence. Max over the full grid corrects lag search.
  let exceeded = 0;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let n = 0; n < resamples; n++) {
    let maximum = -1;
    for (const p of candidates) {
      const blocks: number[][] = [];
      for (let i = 0; i < p.x.length; i += 5) blocks.push(p.x.slice(i, i + 5));
      for (let i = blocks.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
      }
      const fit = regress(blocks.flat(), p.y);
      maximum = Math.max(maximum, fit?.correlation ?? -1);
    }
    exceeded += Number(maximum >= best.fit!.correlation);
  }
  return {
    qualified: true,
    reason: null,
    best: { lagMs: best.lag, ...best.fit! },
    correctedPermutationP: (exceeded + 1) / (resamples + 1),
    resamples,
    shifts: [-15000, -5000, 1000, 5000, 15000].map((shift) => {
      const p = pairs(best.lag, shift);
      return { shiftMs: shift, fit: regress(p.x, p.y) };
    }),
    limitations: [
      'Block-shuffle diagnostic, not independent-event proof',
      'Window/horizon searches need separate multiplicity control',
      'Clock shifts are negative controls, not tuning inputs',
    ],
  };
}
export class RelationshipStudy {
  private series = new Map<string, PriceSeries>();
  constructor(private capacitySeconds = 43200 + 600) {}
  update(rows: Snapshot[]) {
    for (const row of rows) {
      let series = this.series.get(row.symbol);
      if (!series) {
        series = new PriceSeries(this.capacitySeconds);
        this.series.set(row.symbol, series);
      }
      series.add({
        ts: row.ts,
        price: referencePrice(row),
        complete: row.isComplete,
        quoteVolume: row.quoteVolume,
      });
    }
  }
  report(
    asOf: number,
    windows = [3600000, 14400000, 43200000],
    horizons = [15000, 30000, 60000, 180000, 300000],
    lags = [1000, 5000, 15000, 30000, 60000, 120000, 180000, 300000],
  ) {
    const btc = this.series.get('BTCUSDT');
    if (!btc) return [];
    return [...this.series]
      .filter(([s]) => s !== 'BTCUSDT')
      .map(([symbol, asset]) => ({
        symbol,
        asOf,
        windows: windows.flatMap((windowMs) =>
          horizons.map((horizonMs) => ({
            windowMs,
            horizonMs,
            windowBoundaryAvailable: Boolean(
              btc.get(asOf - windowMs - Math.max(...lags)) &&
              asset.get(asOf - windowMs),
            ),
            relationship: relationship(
              btc,
              asset,
              asOf,
              windowMs,
              horizonMs,
              lags,
              20,
            ),
            controls: lagStudy(btc, asset, asOf, windowMs, horizonMs, lags),
          })),
        ),
      }));
  }
}
export function costStress(
  trades: PaperTrade[],
  scenarios = [
    {
      id: 'base',
      feeMultiplier: 1,
      slippageMultiplier: 1,
      extraRoundTripBps: 0,
    },
    {
      id: 'double-slippage',
      feeMultiplier: 1,
      slippageMultiplier: 2,
      extraRoundTripBps: 0,
    },
    {
      id: 'adverse-10bps',
      feeMultiplier: 1.25,
      slippageMultiplier: 3,
      extraRoundTripBps: 10,
    },
  ],
) {
  return {
    basis: 'SAME_FILLS_COST_SENSITIVITY_ONLY',
    scenarios: scenarios.map((s) => {
      if (
        [s.feeMultiplier, s.slippageMultiplier, s.extraRoundTripBps].some(
          (v) => !Number.isFinite(v) || v < 0,
        )
      )
        throw new Error('Invalid stress scenario');
      return {
        ...s,
        metrics: metrics(
          trades.map((t) => ({
            ...t,
            netReturnBps:
              t.grossReturnBps -
              t.feeBps * s.feeMultiplier -
              t.slippageBps * s.slippageMultiplier -
              s.extraRoundTripBps,
          })),
        ),
      };
    }),
    limitations: [
      'Spread is already embedded in ask/bid fills',
      'Does not simulate changed selection, depth or queue fills',
      'Use size/volatility fill reruns separately',
    ],
  };
}
export interface HorizonOutcome {
  signalId: string;
  side: 'LONG' | 'SHORT';
  symbol: string;
  horizonMs: number;
  status: 'complete' | 'missing_path' | 'boundary';
  returnBps: number | null;
}
interface Pending {
  candidate: Candidate;
  startTs: number | null;
  price: number | null;
  lastTs: number;
  horizonMs: number;
  invalid: boolean;
}
/** Midpoint research outcomes, distinct from executable strategy PnL. */
export class FixedHorizonTracker {
  private pending: Pending[] = [];
  readonly outcomes: HorizonOutcome[] = [];
  constructor(private horizons = [15000, 30000, 60000, 180000, 300000]) {
    if (
      horizons.some((h) => h < 1000 || h % 1000) ||
      new Set(horizons).size !== horizons.length
    )
      throw new Error('Invalid horizons');
  }
  submit(candidates: Candidate[]) {
    for (const candidate of candidates.filter((c) => c.accepted))
      for (const horizonMs of this.horizons)
        this.pending.push({
          candidate,
          startTs: null,
          price: null,
          lastTs: 0,
          horizonMs,
          invalid: false,
        });
  }
  update(rows: Snapshot[]) {
    if (!rows.length) return;
    const ts = rows[0]!.ts,
      map = new Map(rows.map((r) => [r.symbol, r])),
      remaining: Pending[] = [];
    for (const p of this.pending) {
      const row = map.get(p.candidate.symbol),
        price = row && referencePrice(row);
      if (p.startTs === null) {
        if (ts <= (p.candidate.entryEligibleTs ?? p.candidate.decisionTs)) {
          remaining.push(p);
          continue;
        }
        if (!row?.isComplete || price == null) {
          this.finish(p, 'missing_path', null);
          continue;
        }
        p.startTs = ts;
        p.price = price;
        p.lastTs = ts;
        remaining.push(p);
        continue;
      }
      p.invalid ||= ts !== p.lastTs + 1000 || !row?.isComplete || price == null;
      p.lastTs = ts;
      if (ts >= p.startTs + p.horizonMs)
        this.finish(
          p,
          p.invalid || ts !== p.startTs + p.horizonMs
            ? 'missing_path'
            : 'complete',
          p.invalid || price == null
            ? null
            : (price / p.price! - 1) *
                10000 *
                (p.candidate.side === 'LONG' ? 1 : -1),
        );
      else remaining.push(p);
    }
    this.pending = remaining;
  }
  private finish(
    p: Pending,
    status: HorizonOutcome['status'],
    returnBps: number | null,
  ) {
    this.outcomes.push({
      signalId: p.candidate.id,
      side: p.candidate.side,
      symbol: p.candidate.symbol,
      horizonMs: p.horizonMs,
      status,
      returnBps,
    });
  }
  close() {
    for (const p of this.pending) this.finish(p, 'boundary', null);
    this.pending = [];
  }
  summary() {
    return this.horizons.flatMap((horizonMs) =>
      (['LONG', 'SHORT'] as const).map((side) => {
        const all = this.outcomes.filter(
            (o) => o.horizonMs === horizonMs && o.side === side,
          ),
          values = all
            .filter((o) => o.status === 'complete')
            .map((o) => o.returnBps!);
        return {
          horizonMs,
          side,
          researchOnly: true,
          n: values.length,
          censored: all.length - values.length,
          meanReturnBps: values.length
            ? values.reduce((a, b) => a + b, 0) / values.length
            : null,
          positiveFraction: values.length
            ? values.filter((x) => x > 0).length / values.length
            : null,
        };
      }),
    );
  }
}
