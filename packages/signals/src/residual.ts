import { z } from 'zod';
import { createHash } from 'node:crypto';
import { symbolSchema } from '../../domain/src/index.js';
import {
  MINUTE,
  fitResidual,
  type BarStore,
  type ResidualFit,
} from '../../quant/src/residual.js';

const minutes = z.number().int().positive().multipleOf(MINUTE);
export const residualSchema = z
  .object({
    version: z.string().min(1),
    symbols: z.array(symbolSchema).min(2).max(100),
    /** outright: hold the alt alone. hedged: long/short the alt against beta x BTC (needs a short leg, e.g. perps). */
    instrument: z.enum(['outright', 'hedged']),
    sides: z.array(z.enum(['LONG', 'SHORT'])).min(1),
    executableSides: z.array(z.enum(['LONG', 'SHORT'])),
    evaluateEveryMs: minutes,
    refitEveryMs: minutes,
    estimationWindowMs: minutes,
    sampleIntervalMs: minutes,
    lookbackMs: minutes,
    holdMs: minutes,
    minFitSamples: z.number().int().min(20),
    minReversionSamples: z.number().int().min(10),
    entryZ: z.number().positive(),
    /** with: LONG only after BTC rose (alt lagged a rally). any: any residual extreme. */
    btcDirection: z.enum(['with', 'any']),
    btcMoveZMin: z.number().nonnegative(),
    minCorrelation: z.number().min(-1).max(1),
    minBeta: z.number(),
    minReversion: z.number(),
    minReversionT: z.number(),
    targetLagFraction: z.number().positive().max(2),
    stopVolMultiple: z.number().positive(),
    minRewardRisk: z.number().nonnegative(),
    costSafetyMultiple: z.number().nonnegative(),
    feeBpsPerSide: z.number().nonnegative(),
    slippageBpsPerSide: z.number().nonnegative(),
    /** Assumed quoted spread; kline data carries no bid/ask. */
    spreadBps: z.number().nonnegative(),
    entryDelayMs: minutes,
    maxEntryDriftBps: z.number().positive(),
    minQuoteVolume24h: z.number().nonnegative(),
    maxMissingFraction: z.number().min(0).max(1),
    maxConcurrentPositions: z.number().int().positive(),
    cooldownMs: z.number().int().nonnegative().multipleOf(MINUTE),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (
      !c.symbols.includes('BTCUSDT') ||
      new Set(c.symbols).size !== c.symbols.length
    )
      issue('Universe must contain BTC and unique symbols');
    if (c.executableSides.some((s) => !c.sides.includes(s)))
      issue('Executable sides must be generated sides');
    if (c.instrument === 'outright' && c.executableSides.includes('SHORT'))
      issue('Outright spot positions cannot be executable shorts');
    for (const [name, value] of [
      ['lookbackMs', c.lookbackMs],
      ['holdMs', c.holdMs],
      ['refitEveryMs', c.refitEveryMs],
    ] as const)
      if (value % c.sampleIntervalMs)
        issue(`${name} must be a multiple of sampleIntervalMs`);
    if (c.evaluateEveryMs > c.lookbackMs)
      issue('Evaluation interval cannot exceed the lookback');
    if (c.estimationWindowMs < 8 * (c.lookbackMs + c.holdMs))
      issue('Estimation window is too short for reversion evidence');
    if (c.minFitSamples > c.estimationWindowMs / c.sampleIntervalMs)
      issue('Estimation window cannot supply the required fit samples');
  });
export type ResidualConfig = z.infer<typeof residualSchema>;
export type Side = 'LONG' | 'SHORT';
export interface ResidualSignal {
  id: string;
  /** Signals from the same lookback bucket share an event ID for clustered statistics. */
  eventId: string;
  symbol: string;
  side: Side;
  instrument: ResidualConfig['instrument'];
  decisionTs: number;
  entryAtTs: number;
  referencePrice: number;
  btcReferencePrice: number;
  beta: number;
  btcMoveBps: number;
  btcZ: number;
  altMoveBps: number;
  /** Alt move minus beta x BTC move over the lookback. */
  residualBps: number;
  residualZ: number;
  /** Residual the trade expects to close, in the side's favour. */
  lagBps: number;
  expectedBps: number;
  costBps: number;
  expectedNetBps: number;
  targetBps: number;
  stopBps: number;
  rewardRisk: number;
  /** Outright only: the alt prices matching target and stop from the reference. */
  targetPrice: number | null;
  stopPrice: number | null;
  entryPriceLimit: number | null;
  holdMs: number;
  fit: ResidualFit;
  accepted: boolean;
  executable: boolean;
  reasons: string[];
  score: number;
  scoreKind: 'HEURISTIC_NOT_WIN_PROBABILITY';
  configHash: string;
  modelVersion: string;
}
export const roundTripCostBps = (
  c: Pick<
    ResidualConfig,
    'feeBpsPerSide' | 'slippageBpsPerSide' | 'spreadBps' | 'instrument'
  >,
  beta: number,
) =>
  2 *
  (c.feeBpsPerSide + c.slippageBpsPerSide + c.spreadBps / 2) *
  (c.instrument === 'hedged' ? 1 + Math.abs(beta) : 1);
export const configHash = (c: ResidualConfig) =>
  createHash('sha256').update(JSON.stringify(c)).digest('hex');

/**
 * Evaluates BTC-relative residuals on closed minute bars. Fits refresh on an
 * absolute clock and use only bars closed by the evaluation bar.
 */
export class ResidualEngine {
  readonly config: ResidualConfig;
  readonly configHash: string;
  private fits = new Map<string, ResidualFit | null>();
  private fitClock = -1;
  private funnel: Record<string, number> = {};
  constructor(config: ResidualConfig) {
    this.config = residualSchema.parse(config);
    this.configHash = configHash(this.config);
  }
  private count(key: string, n = 1) {
    this.funnel[key] = (this.funnel[key] ?? 0) + n;
  }
  get diagnostics() {
    return {
      funnel: { ...this.funnel },
      fitClock: this.fitClock,
      fits: Object.fromEntries(this.fits),
    };
  }
  /** Warm-up history, in bars, before the first possible evaluation. */
  get warmupBars() {
    const c = this.config;
    return (c.estimationWindowMs + c.refitEveryMs + c.lookbackMs) / MINUTE;
  }
  isEvaluationBar(store: BarStore, i: number) {
    return store.closeTimeAt(i) % this.config.evaluateEveryMs === 0;
  }
  private refresh(store: BarStore, i: number) {
    const c = this.config,
      clock =
        Math.floor(store.closeTimeAt(i) / c.refitEveryMs) * c.refitEveryMs;
    if (clock === this.fitClock) return;
    this.fitClock = clock;
    this.fits.clear();
    const at = store.indexClosingAt(clock);
    for (const symbol of c.symbols) {
      if (symbol === 'BTCUSDT') continue;
      this.count('fit_attempts');
      const fit = at >= 0 ? fitResidual(store, symbol, at, c) : null;
      if (!fit) this.count('fit_unavailable');
      this.fits.set(symbol, fit);
    }
  }
  /** Candidates at evaluation bar i, best expected net first. Only triggered residuals are returned. */
  evaluate(store: BarStore, i: number): ResidualSignal[] {
    const c = this.config;
    if (!this.isEvaluationBar(store, i)) return [];
    this.count('evaluations');
    this.refresh(store, i);
    const look = c.lookbackMs / MINUTE,
      decisionTs = store.closeTimeAt(i),
      btcMove = store.logReturn('BTCUSDT', i, look),
      btcPrice = store.close('BTCUSDT', i);
    if (btcMove === null) {
      this.count('missing_btc_bars');
      return [];
    }
    const scale = Math.sqrt(c.lookbackMs / c.sampleIntervalMs),
      holdScale = Math.sqrt(c.holdMs / c.sampleIntervalMs),
      eventId = `res-${Math.floor(decisionTs / c.lookbackMs) * c.lookbackMs}`,
      out: ResidualSignal[] = [];
    for (const [symbol, fit] of this.fits) {
      if (!fit) continue;
      const altMove = store.logReturn(symbol, i, look),
        price = store.close(symbol, i);
      if (altMove === null) {
        this.count('missing_asset_bars');
        continue;
      }
      const residual = altMove - fit.beta * btcMove,
        residualZ = residual / Math.max(fit.residualVol * scale, 1e-12),
        btcZ = btcMove / Math.max(fit.btcVol * scale, 1e-12);
      if (Math.abs(residualZ) < c.entryZ) {
        this.count('residual_inside_band');
        continue;
      }
      const side: Side = residualZ < 0 ? 'LONG' : 'SHORT',
        direction = side === 'LONG' ? 1 : -1;
      if (!c.sides.includes(side)) {
        this.count('side_not_generated');
        continue;
      }
      this.count('residual_triggers');
      const reasons: string[] = [];
      if (
        c.btcDirection === 'with' &&
        (direction * btcMove <= 0 || Math.abs(btcZ) < c.btcMoveZMin)
      )
        reasons.push('btc_move_not_confirming');
      if (fit.correlation < c.minCorrelation)
        reasons.push('weak_btc_relationship');
      if (fit.beta < c.minBeta) reasons.push('beta_below_minimum');
      if (fit.reversion < c.minReversion || fit.reversionT < c.minReversionT)
        reasons.push('no_recent_catch_up_evidence');
      const day = store.activity(symbol, i, 1440);
      if (day.volume < c.minQuoteVolume24h)
        reasons.push('insufficient_liquidity');
      if (
        day.missing / 1440 > c.maxMissingFraction ||
        store.activity('BTCUSDT', i, 1440).missing / 1440 > c.maxMissingFraction
      )
        reasons.push('incomplete_bars');
      const lag = -direction * residual,
        expected = Math.max(0, fit.reversion) * lag,
        cost = roundTripCostBps(c, fit.beta),
        target = c.targetLagFraction * lag,
        stop =
          c.stopVolMultiple *
          holdScale *
          (c.instrument === 'hedged' ? fit.residualVol : fit.altVol),
        rewardRisk = (target * 1e4 - cost) / (stop * 1e4 + cost);
      if (expected * 1e4 < cost * c.costSafetyMultiple)
        reasons.push('edge_below_cost');
      if (rewardRisk < c.minRewardRisk) reasons.push('reward_risk_too_low');
      for (const reason of reasons) this.count(reason);
      this.count(reasons.length ? 'rejected' : 'accepted');
      const outright = c.instrument === 'outright';
      out.push({
        id: `${eventId}-${decisionTs}-${symbol}-${side}`,
        eventId,
        symbol,
        side,
        instrument: c.instrument,
        decisionTs,
        entryAtTs: decisionTs + c.entryDelayMs,
        referencePrice: price,
        btcReferencePrice: btcPrice,
        beta: fit.beta,
        btcMoveBps: btcMove * 1e4,
        btcZ,
        altMoveBps: altMove * 1e4,
        residualBps: residual * 1e4,
        residualZ,
        lagBps: lag * 1e4,
        expectedBps: expected * 1e4,
        costBps: cost,
        expectedNetBps: expected * 1e4 - cost,
        targetBps: target * 1e4,
        stopBps: stop * 1e4,
        rewardRisk,
        targetPrice: outright ? price * Math.exp(direction * target) : null,
        stopPrice: outright ? price * Math.exp(-direction * stop) : null,
        entryPriceLimit: outright
          ? price * Math.exp((direction * c.maxEntryDriftBps) / 1e4)
          : null,
        holdMs: c.holdMs,
        fit,
        accepted: !reasons.length,
        executable: !reasons.length && c.executableSides.includes(side),
        reasons,
        score: Math.round(
          100 *
            Math.max(0, Math.min(1, fit.reversion)) *
            Math.min(1, (lag * 1e4) / Math.max(cost * 4, 1)),
        ),
        scoreKind: 'HEURISTIC_NOT_WIN_PROBABILITY',
        configHash: this.configHash,
        modelVersion: c.version,
      });
    }
    return out.sort(
      (a, b) =>
        b.expectedNetBps - a.expectedNetBps || a.symbol.localeCompare(b.symbol),
    );
  }
}
