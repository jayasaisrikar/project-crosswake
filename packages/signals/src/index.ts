import { z } from 'zod';
import {
  forwardModel,
  predictForward,
  type ForwardModel,
} from '../../quant/src/forward.js';
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
    forward: z
      .object({
        entryDelayMs: z.number().int().nonnegative().multipleOf(1000),
        dataLatencyBudgetMs: z.number().int().nonnegative().multipleOf(1000),
        outcomeHorizonMs: z.number().int().min(1000).multipleOf(1000),
        minValidationSamples: z.number().int().min(10),
        minIncrementalSkill: z.number().positive().max(1),
        minNetRewardRisk: z.number().positive(),
        maxEntryDriftBps: z.number().positive(),
        signalTtlMs: z.number().int().positive().multipleOf(1000),
        universeWindowMs: z.number().int().min(60000).multipleOf(1000),
        minAssetQuoteVolume: z.number().positive(),
        minQuoteCoverage: z.number().positive().max(1),
        maxConcurrentPositions: z.number().int().positive(),
      })
      .strict()
      .optional(),
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
    if (c.forward) {
      const f = c.forward;
      const stride =
        c.horizonMs +
        f.entryDelayMs +
        f.dataLatencyBudgetMs +
        c.decisionLatencyMs +
        1000 +
        f.outcomeHorizonMs;
      if (
        c.decisionLatencyMs % 1000 ||
        c.windowMs <
          stride *
            Math.max(Math.ceil(c.minSamples / 0.75), 4 * f.minValidationSamples)
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Forward window must cover disjoint training and validation observations at whole-second clocks',
        });
      if (
        f.signalTtlMs <=
          f.entryDelayMs + c.decisionLatencyMs + f.dataLatencyBudgetMs + 1000 ||
        f.universeWindowMs > c.windowMs
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Forward lifetime must exceed total entry delay and universe window must fit history',
        });
      if (
        c.maxHoldMs !== f.outcomeHorizonMs ||
        !c.executionCost ||
        c.maxEntryWaitMs !== 1000
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Forward mode requires size-aware costs, a one-second entry quote window, and a holding horizon matching its labels',
        });
    }
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
  forecast?: ForwardModel;
  scoreKind?: 'HEURISTIC_NOT_WIN_PROBABILITY';
  entryEligibleTs?: number;
  expiresAt?: number;
  entryPriceLimit?: number;
  targetPrice?: number;
  predictedNetBps?: number;
  universeEvidence?: {
    asOf: number;
    quoteVolume: number;
    quoteCoverage: number;
  };
}
export class SignalEngine {
  private series = new Map<string, PriceSeries>();
  private forwardFits = new Map<string, ForwardModel>();
  private quoteHistory = new Map<
    string,
    { ts: number; eligible: boolean; volume: number }[]
  >();
  private funnel: Record<string, number> = {};
  private maxDataDelayMs = 0;
  private count(reason: string, n = 1) {
    this.funnel[reason] = (this.funnel[reason] ?? 0) + n;
  }
  private fitForward(asOf: number) {
    this.forwardFits.clear();
    const c = this.config,
      f = c.forward!,
      btc = this.series.get('BTCUSDT');
    if (!btc) return;
    for (const [symbol, alt] of this.series) {
      if (symbol === 'BTCUSDT') continue;
      this.count('fit_attempts');
      const fit = forwardModel(
        btc,
        alt,
        asOf,
        c.windowMs,
        c.horizonMs,
        f.entryDelayMs + f.dataLatencyBudgetMs + c.decisionLatencyMs + 1000,
        f.outcomeHorizonMs,
        c.minSamples,
        f.minValidationSamples,
      );
      if (fit) this.forwardFits.set(symbol, fit);
      else this.count('fit_unavailable');
    }
  }
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
    if (this.config.forward) {
      this.fitForward(this.lastTimestamp);
      this.relationshipsFrozen = true;
      return this.relationships;
    }
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
  private forwardRelationship(f: ForwardModel): Relationship {
    return {
      asOf: f.asOf,
      n: f.trainingSamples,
      alpha: f.alpha,
      beta: f.btcBeta,
      correlation: f.validationCorrelation,
      r2: f.validationCorrelation ** 2,
      residualVol: f.residualVol,
      btcVol: f.btcVol,
      lagMs: f.delayMs,
      lagCorrelation: f.validationCorrelation,
      lagSamples: f.validationSamples,
      stability: Math.max(0, f.incrementalSkill),
    };
  }
  get relationships() {
    if (this.config.forward)
      return Object.fromEntries(
        [...this.forwardFits].map(([symbol, fit]) => [
          symbol,
          this.forwardRelationship(fit),
        ]),
      );
    return Object.fromEntries(
      [...this.cached].map(([symbol, fit]) => [symbol, { ...fit }]),
    );
  }
  get diagnostics() {
    return {
      lastTimestamp: this.lastTimestamp,
      relationshipCount: this.config.forward
        ? this.forwardFits.size
        : this.cached.size,
      funnel: { ...this.funnel },
      maxDataDelayMs: this.maxDataDelayMs,
      modelKind: this.config.forward ? 'FORWARD_RETURN' : 'LEGACY_CATCH_UP',
      forwardModels: Object.fromEntries(this.forwardFits),
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
    this.count('batches');
    const delay = Math.max(...rows.map((r) => (r.availableAt ?? r.ts) - r.ts));
    this.maxDataDelayMs = Math.max(this.maxDataDelayMs, delay);
    this.count(
      delay <= 1000
        ? 'data_delay_le_1s'
        : delay <= 8000
          ? 'data_delay_le_8s'
          : delay <= 30000
            ? 'data_delay_le_30s'
            : 'data_delay_gt_30s',
    );
    this.count('incomplete_rows', rows.filter((r) => !r.isComplete).length);
    const c = this.config,
      btc = this.series.get('BTCUSDT');
    // Fit using only previous snapshots; the triggering bucket is excluded from estimates.
    const fitted = this.cached;
    if (
      this.config.forward &&
      !this.relationshipsFrozen &&
      ts - this.lastFit >= c.relationshipRefreshMs
    ) {
      this.fitForward(ts - 1000);
      this.lastFit = ts;
    }
    if (
      !c.forward &&
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
          this.count('fit_attempts');
          if (fit) fitted.set(row.symbol, fit);
          else this.count('fit_unavailable');
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
        complete:
          row.isComplete &&
          (!c.forward ||
            (row.bestAsk !== null &&
              row.bestBid !== null &&
              row.quoteTs != null &&
              row.quoteTs <= ts &&
              ts - row.quoteTs <= 1000)),
        quoteVolume: row.quoteVolume,
        ...(c.forward ? { availableAt: row.availableAt ?? ts } : {}),
      });
    }
    if (c.forward) {
      const candidates = this.forwardCandidates(rows);
      for (const row of rows) {
        const history = this.quoteHistory.get(row.symbol) ?? [];
        history.push({
          ts,
          eligible:
            row.isComplete &&
            row.bestAsk !== null &&
            row.bestBid !== null &&
            row.quoteTs != null &&
            row.quoteTs <= ts &&
            ts - row.quoteTs <= 1000 &&
            row.spreadBps !== null &&
            row.spreadBps <= c.maxSpreadBps,
          volume: row.quoteVolume,
        });
        while (
          history.length &&
          history[0]!.ts < ts - c.forward.universeWindowMs
        )
          history.shift();
        this.quoteHistory.set(row.symbol, history);
      }
      return candidates;
    }
    const btcSeries = this.series.get('BTCUSDT');
    if (!btcSeries) {
      this.count('missing_btc_history');
      return [];
    }
    if (ts - this.lastImpulse < c.cooldownMs) {
      this.count('cooldown');
      return [];
    }
    const impulse = btcSeries.returnAt(ts, c.horizonMs),
      volume = btcSeries.volumeAt(ts, c.horizonMs);
    if (
      impulse === null ||
      volume === null ||
      Math.abs(impulse) < c.impulseMinMove ||
      volume < c.minBtcQuoteVolume
    ) {
      this.count(
        impulse === null || volume === null
          ? 'missing_impulse_history'
          : Math.abs(impulse) < c.impulseMinMove
            ? 'small_btc_impulse'
            : 'low_btc_volume',
      );
      return [];
    }
    const qualifying = [...fitted.values()].filter(
      (f) => Math.abs(impulse) / f.btcVol >= c.impulseZMin,
    );
    if (!qualifying.length) {
      this.count(fitted.size ? 'weak_btc_impulse' : 'no_fitted_relationship');
      return [];
    }
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
      for (const reason of reasons) this.count(reason);
      this.count(
        reasons.length ? 'rejected_candidates' : 'accepted_candidates',
      );
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
  private forwardCandidates(rows: Snapshot[]): Candidate[] {
    const c = this.config,
      f = c.forward!,
      ts = rows[0]!.ts,
      btc = this.series.get('BTCUSDT'),
      btcRow = rows.find((r) => r.symbol === 'BTCUSDT');
    if (!btcRow || !btcRow.isComplete || !btc) {
      this.count('missing_btc_history');
      return [];
    }
    if (ts - this.lastImpulse < c.cooldownMs) {
      this.count('cooldown');
      return [];
    }
    const impulse = btc.returnAt(ts, c.horizonMs),
      volume = btc.volumeAt(ts, c.horizonMs);
    if (impulse === null || volume === null) {
      this.count('missing_impulse_history');
      return [];
    }
    if (Math.abs(impulse) < c.impulseMinMove) {
      this.count('small_btc_impulse');
      return [];
    }
    if (volume < c.minBtcQuoteVolume) {
      this.count('low_btc_volume');
      return [];
    }
    if (!this.forwardFits.size) {
      this.count('no_fitted_relationship');
      return [];
    }
    this.lastImpulse = ts;
    const event = `btc-${ts}-${this.configHash.slice(0, 12)}`,
      result: Candidate[] = [];
    for (const row of rows) {
      if (row.symbol === 'BTCUSDT') continue;
      const fit = this.forwardFits.get(row.symbol),
        actual = this.series.get(row.symbol)?.returnAt(ts, c.horizonMs);
      if (!fit || actual == null) {
        this.count(!fit ? 'asset_fit_unavailable' : 'missing_asset_history');
        continue;
      }
      const reasons: string[] = [],
        expected = predictForward(fit, impulse, actual),
        direction = impulse > 0 ? 1 : -1;
      const history = (this.quoteHistory.get(row.symbol) ?? []).filter(
        (r) => r.ts >= ts - f.universeWindowMs && r.ts < ts,
      );
      const quoteCoverage =
          history.filter((r) => r.eligible).length /
          (f.universeWindowMs / 1000),
        quoteVolume = history.reduce(
          (n, r) => n + (r.eligible ? r.volume : 0),
          0,
        );
      if (quoteCoverage < f.minQuoteCoverage)
        reasons.push('insufficient_quote_coverage');
      if (quoteVolume < f.minAssetQuoteVolume)
        reasons.push('insufficient_asset_liquidity');
      if (
        fit.incrementalSkill < f.minIncrementalSkill ||
        fit.constantSkill <= 0 ||
        fit.btcBeta <= 0
      )
        reasons.push('no_incremental_btc_predictability');
      if (Math.abs(impulse) / Math.max(fit.btcVol, 1e-12) < c.impulseZMin)
        reasons.push('weak_btc_impulse');
      const gapZ = (direction * expected) / Math.max(fit.residualVol, 1e-12),
        cost =
          (row.spreadBps ?? Infinity) +
          2 * (c.feeBpsPerSide + c.slippageBpsPerSide);
      if (gapZ < c.gapZMin) reasons.push('weak_forward_forecast');
      const price = referencePrice(row),
        btcPrice = referencePrice(btcRow);
      if (
        !row.isComplete ||
        price === null ||
        btcPrice === null ||
        row.bestAsk === null ||
        row.bestBid === null ||
        row.quoteTs == null ||
        row.quoteTs > ts ||
        ts - row.quoteTs > 1000
      )
        reasons.push('missing_quote_evidence');
      if (row.spreadBps === null || row.spreadBps > c.maxSpreadBps)
        reasons.push('wide_spread');
      const available = Math.max(
        row.availableAt ?? ts,
        btcRow.availableAt ?? ts,
      );
      if (available - ts > f.dataLatencyBudgetMs)
        reasons.push('data_latency_budget_exceeded');
      const decisionTs = available + c.decisionLatencyMs,
        predictedNetBps =
          direction * expected * 10000 * c.takeProfitGapFraction - cost;
      if (
        direction * expected * 10000 * c.takeProfitGapFraction <
        cost * c.costSafetyMultiple
      )
        reasons.push('edge_below_cost');
      if (
        predictedNetBps /
          (c.stopLossBps + 2 * (c.feeBpsPerSide + c.slippageBpsPerSide)) <
        f.minNetRewardRisk
      )
        reasons.push('net_reward_risk_too_low');
      for (const reason of reasons) this.count(reason);
      this.count(
        reasons.length ? 'rejected_candidates' : 'accepted_candidates',
      );
      result.push({
        id: `${event}-${row.symbol}-${direction > 0 ? 'LONG' : 'SHORT'}`,
        ts,
        decisionTs,
        symbol: row.symbol,
        side: direction > 0 ? 'LONG' : 'SHORT',
        btcImpulseId: event,
        btcImpulseReturn: impulse,
        decisionPrice: price ?? 0,
        btcDecisionPrice: btcPrice ?? 0,
        expectedReturn: expected,
        actualReturn: actual,
        reactionGap: expected,
        gapZ,
        confidence: Math.round(
          100 * Math.max(0, Math.min(1, fit.incrementalSkill)),
        ),
        estimatedCostBps: Number.isFinite(cost) ? cost : null,
        relationship: this.forwardRelationship(fit),
        configHash: this.configHash,
        modelVersion: c.version,
        accepted: !reasons.length,
        executable: !reasons.length && direction > 0,
        reasons,
        forecast: fit,
        scoreKind: 'HEURISTIC_NOT_WIN_PROBABILITY',
        entryEligibleTs: Math.max(
          decisionTs + f.entryDelayMs,
          ts + f.dataLatencyBudgetMs + c.decisionLatencyMs + f.entryDelayMs,
        ),
        expiresAt: ts + f.signalTtlMs,
        entryPriceLimit: (price ?? 0) * (1 + f.maxEntryDriftBps / 10000),
        targetPrice:
          (price ?? 0) * Math.exp(expected * c.takeProfitGapFraction),
        predictedNetBps: Number.isFinite(predictedNetBps)
          ? predictedNetBps
          : undefined,
        universeEvidence: { asOf: ts - 1000, quoteVolume, quoteCoverage },
      });
    }
    return result.sort(
      (a, b) =>
        (b.predictedNetBps ?? -Infinity) - (a.predictedNetBps ?? -Infinity) ||
        a.symbol.localeCompare(b.symbol),
    );
  }
}
