import { z } from 'zod';
import { createHash } from 'node:crypto';
import { referencePrice, type Snapshot } from '../../domain/src/index.js';
import {
  PriceSeries,
  relationship,
  type Relationship,
} from '../../quant/src/index.js';
export const strategySchema = z
  .object({
    version: z.string().min(1),
    relationshipRefreshMs: z.number().int().min(1000).multipleOf(1000),
    btcRetraceInvalidation: z.number().positive().max(1),
    horizonMs: z.number().int().min(1000).multipleOf(1000),
    windowMs: z.number().int().min(60000).multipleOf(1000),
    minSamples: z.number().int().min(6),
    minLagMs: z.number().int().min(1000).multipleOf(1000),
    maxLagMs: z.number().int().min(1000).multipleOf(1000),
    minLagCorrelation: z.number().min(-1).max(1),
    lagGridMs: z.array(z.number().int().min(1000).multipleOf(1000)).min(1),
    correlationFloor: z.number().min(0).max(1),
    minStability: z.number().min(0).max(1),
    impulseMinMove: z.number().positive(),
    impulseZMin: z.number().positive(),
    minBtcQuoteVolume: z.number().nonnegative(),
    gapZMin: z.number().positive(),
    maxSpreadBps: z.number().positive(),
    feeBpsPerSide: z.number().nonnegative(),
    slippageBpsPerSide: z.number().nonnegative(),
    costSafetyMultiple: z.number().positive(),
    minConfidence: z.number().min(0).max(100),
    cooldownMs: z.number().int().nonnegative(),
    decisionLatencyMs: z.number().int().nonnegative(),
    maxHoldMs: z.number().int().positive(),
    maxEntryWaitMs: z.number().int().positive(),
    takeProfitGapFraction: z.number().positive().max(1),
    stopLossBps: z.number().positive(),
    executionCost: z
      .object({
        notionalUsdt: z.number().positive(),
        maxParticipation: z.number().positive().max(1),
        impactCoefficientBps: z.number().nonnegative(),
        volatilityMultiplier: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.minLagMs > c.maxLagMs)
      ctx.addIssue({
        code: 'custom',
        message: 'Minimum lag exceeds maximum lag',
      });
    if (c.windowMs < c.horizonMs * c.minSamples)
      ctx.addIssue({
        code: 'custom',
        message: 'Window cannot provide requested non-overlapping sample count',
      });
    if (new Set(c.lagGridMs).size !== c.lagGridMs.length)
      ctx.addIssue({ code: 'custom', message: 'Lag grid contains duplicates' });
  });
export type StrategyConfig = z.infer<typeof strategySchema>;
export interface Candidate {
  id: string;
  ts: number;
  decisionTs: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  btcImpulseId: string;
  btcImpulseReturn: number;
  decisionPrice: number;
  btcDecisionPrice: number;
  expectedReturn: number;
  actualReturn: number;
  reactionGap: number;
  gapZ: number;
  confidence: number;
  estimatedCostBps: number | null;
  relationship: Relationship;
  configHash: string;
  modelVersion: string;
  accepted: boolean;
  executable: boolean;
  reasons: string[];
}
export class SignalEngine {
  private series = new Map<string, PriceSeries>();
  private cached = new Map<string, Relationship>();
  private lastFit = 0;
  private lastImpulse = 0;
  private lastTimestamp = 0;
  private relationshipsFrozen = false;
  readonly config: StrategyConfig;
  readonly configHash: string;
  constructor(config: StrategyConfig) {
    this.config = strategySchema.parse(config);
    this.configHash = createHash('sha256')
      .update(JSON.stringify(this.config))
      .digest('hex');
  }
  freezeRelationships() {
    const btc = this.series.get('BTCUSDT');
    this.cached.clear();
    if (btc)
      for (const [symbol, asset] of this.series) {
        if (symbol === 'BTCUSDT') continue;
        const fit = relationship(
          btc,
          asset,
          this.lastTimestamp,
          this.config.windowMs,
          this.config.horizonMs,
          this.config.lagGridMs,
          this.config.minSamples,
        );
        if (fit) this.cached.set(symbol, fit);
      }
    this.relationshipsFrozen = true;
    return this.relationships;
  }
  get relationships() {
    return Object.fromEntries(
      [...this.cached].map(([symbol, fit]) => [symbol, { ...fit }]),
    );
  }
  get diagnostics() {
    return {
      lastTimestamp: this.lastTimestamp,
      relationshipCount: this.cached.size,
      frozen: this.relationshipsFrozen,
    };
  }
  update(rows: Snapshot[]): Candidate[] {
    if (!rows.length) return [];
    const ts = rows[0]!.ts;
    if (
      rows.some((r) => r.ts !== ts) ||
      new Set(rows.map((r) => r.symbol)).size !== rows.length
    )
      throw new Error(
        'Batch must contain one unique row per symbol at one timestamp',
      );
    if (ts <= this.lastTimestamp)
      throw new Error('Signals require chronological unique batches');
    this.lastTimestamp = ts;
    const c = this.config,
      btc = this.series.get('BTCUSDT');
    // Fit using only previous snapshots; the triggering bucket is excluded from estimates.
    const fitted = this.cached;
    if (
      !this.relationshipsFrozen &&
      btc &&
      ts - this.lastFit >= c.relationshipRefreshMs
    ) {
      fitted.clear();
      for (const row of rows) {
        const s = this.series.get(row.symbol);
        if (row.symbol !== 'BTCUSDT' && s) {
          const fit = relationship(
            btc,
            s,
            ts - 1000,
            c.windowMs,
            c.horizonMs,
            c.lagGridMs,
            c.minSamples,
          );
          if (fit) fitted.set(row.symbol, fit);
        }
      }
      this.lastFit = ts;
    }
    for (const row of rows) {
      let s = this.series.get(row.symbol);
      if (!s) {
        s = new PriceSeries(
          (c.windowMs + c.horizonMs + Math.max(...c.lagGridMs)) / 1000 + 2,
        );
        this.series.set(row.symbol, s);
      }
      s.add({
        ts,
        price: referencePrice(row),
        complete: row.isComplete,
        quoteVolume: row.quoteVolume,
      });
    }
    const btcSeries = this.series.get('BTCUSDT');
    if (!btcSeries || ts - this.lastImpulse < c.cooldownMs) return [];
    const impulse = btcSeries.returnAt(ts, c.horizonMs),
      volume = btcSeries.volumeAt(ts, c.horizonMs);
    if (
      impulse === null ||
      volume === null ||
      Math.abs(impulse) < c.impulseMinMove ||
      volume < c.minBtcQuoteVolume
    )
      return [];
    const qualifying = [...fitted.values()].filter(
      (f) => Math.abs(impulse) / f.btcVol >= c.impulseZMin,
    );
    if (!qualifying.length) return [];
    this.lastImpulse = ts;
    const btcImpulseId = `btc-${ts}-${this.configHash.slice(0, 12)}`;
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const fit = fitted.get(row.symbol);
      if (!fit) continue;
      const actual = this.series.get(row.symbol)!.returnAt(ts, c.horizonMs);
      if (actual === null) continue;
      const expected = fit.alpha + fit.beta * impulse,
        gap = expected - actual,
        side = impulse > 0 ? 'LONG' : 'SHORT',
        direction = side === 'LONG' ? 1 : -1,
        gapZ = (direction * gap) / Math.max(fit.residualVol, 1e-12);
      const cost =
        (row.spreadBps ?? Infinity) +
        2 * (c.feeBpsPerSide + c.slippageBpsPerSide);
      const confidence = Math.round(
        100 *
          (0.3 * Math.max(0, fit.correlation) * fit.stability +
            0.25 * Math.max(0, fit.lagCorrelation) +
            0.25 * Math.min(1, Math.max(0, gapZ) / (2 * c.gapZMin)) +
            0.2 *
              Math.min(
                1,
                Math.max(0, direction * gap * 10000) /
                  (Math.max(cost, 1e-12) * c.costSafetyMultiple),
              )),
      );
      const reasons: string[] = [];
      if (
        fit.lagMs < c.minLagMs ||
        fit.lagMs > c.maxLagMs ||
        fit.lagCorrelation < c.minLagCorrelation
      )
        reasons.push('insufficient_lag_evidence');
      if (fit.correlation < c.correlationFloor)
        reasons.push('weak_relationship');
      if (fit.stability < c.minStability) reasons.push('unstable_relationship');
      if (fit.beta <= 0) reasons.push('nonpositive_beta');
      if (Math.abs(impulse) / fit.btcVol < c.impulseZMin)
        reasons.push('weak_impulse');
      if (gapZ < c.gapZMin) reasons.push('small_or_wrong_direction_gap');
      if (
        row.spreadBps === null ||
        !row.isComplete ||
        row.bestAsk === null ||
        row.bestBid === null
      )
        reasons.push('missing_quote_evidence');
      else if (row.spreadBps > c.maxSpreadBps) reasons.push('wide_spread');
      if (direction * gap * 10000 < cost * c.costSafetyMultiple)
        reasons.push('edge_below_cost');
      if (confidence < c.minConfidence) reasons.push('low_confidence');
      candidates.push({
        id: `${btcImpulseId}-${row.symbol}-${side}`,
        ts,
        decisionTs: Math.max(
          ts + c.decisionLatencyMs,
          row.availableAt ?? ts,
          rows.find((r) => r.symbol === 'BTCUSDT')!.availableAt ?? ts,
        ),
        symbol: row.symbol,
        side,
        btcImpulseId,
        btcImpulseReturn: impulse,
        decisionPrice: referencePrice(row)!,
        btcDecisionPrice: referencePrice(
          rows.find((r) => r.symbol === 'BTCUSDT')!,
        )!,
        expectedReturn: expected,
        actualReturn: actual,
        reactionGap: gap,
        gapZ,
        confidence,
        estimatedCostBps: Number.isFinite(cost) ? cost : null,
        relationship: fit,
        configHash: this.configHash,
        modelVersion: c.version,
        accepted: reasons.length === 0,
        executable: reasons.length === 0 && side === 'LONG',
        reasons,
      });
    }
    return candidates;
  }
}
