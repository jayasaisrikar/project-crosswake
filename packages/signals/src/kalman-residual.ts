/**
 * v009: Kalman-hedged residual pairs (alt vs BTC) on USD-M perps. A separate
 * engine with its own schema so frozen v003/v004 configs and hashes never
 * change. Spec: docs/residual-kalman-v009.md.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { symbolSchema } from '../../domain/src/index.js';
import {
  MINUTE,
  type BarStore,
  type ResidualFit,
} from '../../quant/src/residual.js';
import {
  kalmanHedge,
  kalmanStep,
  type KalmanState,
} from '../../quant/src/kalman.js';
import {
  dispersionRatio,
  kalmanSpread,
  olsHedge,
  olsSpread,
  rollingZ,
  sampleSd,
} from '../../quant/src/spread.js';
import {
  benjaminiHochberg,
  engleGranger,
  halfLife,
} from '../../quant/src/stationarity.js';
import {
  roundTripCostBps,
  type ResidualSignal,
  type Side,
} from './residual.js';

const minutes = z.number().int().positive().multipleOf(MINUTE);
export const kalmanResidualSchema = z
  .object({
    version: z.string().min(1),
    symbols: z.array(symbolSchema).min(2).max(100),
    market: z.literal('usdm'),
    instrument: z.literal('hedged'),
    hedgeModel: z.enum(['kalman', 'ols']),
    sides: z.array(z.enum(['LONG', 'SHORT'])).min(1),
    executableSides: z.array(z.enum(['LONG', 'SHORT'])),
    evaluateEveryMs: minutes,
    refitEveryMs: minutes,
    estimationWindowMs: minutes,
    sampleIntervalMs: minutes,
    kalman: z
      .object({
        delta: z.number().positive().lt(1),
        initBars: z.number().int().min(3),
        scaleObsVar: z.boolean(),
      })
      .strict(),
    zWindowBars: z.number().int().min(10),
    entryZ: z.number().positive(),
    exitZ: z.number().min(0),
    stopZ: z.number().positive(),
    cointegrationMaxP: z.number().gt(0).max(1),
    fdrQ: z.number().gt(0).max(1),
    persistenceRefits: z.number().int().positive(),
    halfLifeMinBars: z.number().positive(),
    halfLifeMaxBars: z.number().positive(),
    minWindowCycles: z.number().positive(),
    maxHoldHalfLives: z.number().positive(),
    maxHoldMs: minutes,
    minBeta: z.number(),
    maxBeta: z.number(),
    costSafetyMultiple: z.number().nonnegative(),
    feeBpsPerSide: z.number().nonnegative(),
    slippageBpsPerSide: z.number().nonnegative(),
    spreadBps: z.number().nonnegative(),
    entryDelayMs: minutes,
    maxEntryDriftBps: z.number().positive(),
    minQuoteVolume24h: z.number().nonnegative(),
    maxMissingFraction: z.number().min(0).max(1),
    maxConcurrentPositions: z.number().int().positive(),
    maxPositionsPerEvent: z.number().int().positive(),
    cooldownMs: z.number().int().nonnegative().multipleOf(MINUTE),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', message }),
      samples = c.estimationWindowMs / c.sampleIntervalMs;
    if (
      !c.symbols.includes('BTCUSDT') ||
      new Set(c.symbols).size !== c.symbols.length
    )
      issue('Universe must contain BTC and unique symbols');
    if (c.executableSides.some((s) => !c.sides.includes(s)))
      issue('Executable sides must be generated sides');
    if (c.evaluateEveryMs !== c.sampleIntervalMs)
      issue('evaluateEveryMs must equal sampleIntervalMs');
    if (c.refitEveryMs % c.sampleIntervalMs)
      issue('refitEveryMs must be a multiple of sampleIntervalMs');
    if (c.estimationWindowMs % c.sampleIntervalMs)
      issue('estimationWindowMs must be a multiple of sampleIntervalMs');
    if (c.kalman.initBars >= samples)
      issue('kalman.initBars must be inside the estimation window');
    if (c.zWindowBars > samples)
      issue('zWindowBars cannot exceed the estimation window');
    if (!(c.exitZ < c.entryZ && c.entryZ < c.stopZ))
      issue('Require 0 <= exitZ < entryZ < stopZ');
    if (!(c.halfLifeMinBars < c.halfLifeMaxBars))
      issue('halfLifeMinBars must be below halfLifeMaxBars');
    if (!(c.minBeta < c.maxBeta)) issue('minBeta must be below maxBeta');
  });
export type KalmanResidualConfig = z.infer<typeof kalmanResidualSchema>;
export const kalmanConfigHash = (c: KalmanResidualConfig) =>
  createHash('sha256').update(JSON.stringify(c)).digest('hex');

/** Per-symbol state from one refit, carried forward between refits. */
interface PairFit {
  symbol: string;
  asOf: number;
  pairs: number;
  pValue: number;
  halfLife: number;
  dispersionRatio: number;
  passes: boolean;
  /** Hedge used for the spread at the latest sample (prior state for kalman). */
  beta: number;
  alpha: number;
  carry: KalmanState | null;
  /** Last zWindowBars spread values, newest last; rebuilt from the fresh path at every refit. */
  spreads: number[];
  lastSampleTs: number;
  innovationZ: number;
  correlation: number;
  btcVol: number;
  altVol: number;
}

/**
 * Evaluates Kalman (or static-OLS control) hedged spreads on 15-minute
 * samples. Fits refresh on an absolute clock from the estimation window only;
 * eligibility needs the last `persistenceRefits` refits to pass, recomputed
 * from bars when missing, so a run gives the same signals whenever it starts.
 */
export class KalmanResidualEngine {
  readonly config: KalmanResidualConfig;
  readonly configHash: string;
  /** Lower bound on a signal's hold; the simulator checks each signal's own hold against the window. */
  readonly minHoldMs = 0;
  private fits = new Map<string, PairFit | null>();
  private fitClock = -1;
  private passHistory = new Map<number, Set<string>>();
  private funnel: Record<string, number> = {};
  private dispersion: number[] = [];
  private eligibleEvaluations: Record<string, number> = {};
  constructor(config: KalmanResidualConfig) {
    this.config = kalmanResidualSchema.parse(config);
    this.configHash = kalmanConfigHash(this.config);
  }
  private count(key: string, n = 1) {
    this.funnel[key] = (this.funnel[key] ?? 0) + n;
  }
  get diagnostics() {
    return {
      funnel: { ...this.funnel },
      fitClock: this.fitClock,
      /** dispersionRatio of every symbol fit at every refit, in order (logged, never gated). */
      dispersionRatios: [...this.dispersion],
      /** Evaluations at which each symbol was eligible (cointegrated for persistenceRefits refits). */
      eligibleEvaluations: { ...this.eligibleEvaluations },
      fits: Object.fromEntries(
        [...this.fits].map(([s, f]) => [
          s,
          f && {
            pValue: f.pValue,
            halfLife: f.halfLife,
            beta: f.beta,
            dispersionRatio: f.dispersionRatio,
            passes: f.passes,
          },
        ]),
      ),
    };
  }
  get warmupBars() {
    const c = this.config;
    return (
      (c.estimationWindowMs +
        c.refitEveryMs * c.persistenceRefits +
        c.zWindowBars * c.sampleIntervalMs) /
      MINUTE
    );
  }
  /** Half-life ceiling: the configured cap, or fewer so the window holds minWindowCycles half-lives. */
  get maxHalfLifeBars() {
    const c = this.config;
    return Math.min(
      c.halfLifeMaxBars,
      Math.floor(c.estimationWindowMs / c.sampleIntervalMs / c.minWindowCycles),
    );
  }
  isEvaluationBar(store: BarStore, i: number) {
    return store.closeTimeAt(i) % this.config.evaluateEveryMs === 0;
  }
  private logClose(store: BarStore, symbol: string, ts: number) {
    const i = (ts - store.startTs) / MINUTE - 1;
    return i >= 0 && i < store.length ? Math.log(store.close(symbol, i)) : NaN;
  }
  /** Fits every alt on samples in (clock − window, clock]; BH-FDR across symbols decides `passes`. */
  private fitAt(store: BarStore, clock: number, record: boolean) {
    const c = this.config,
      n = c.estimationWindowMs / c.sampleIntervalMs,
      times = Array.from(
        { length: n },
        (_, k) => clock - (n - 1 - k) * c.sampleIntervalMs,
      ),
      lnBtc = times.map((t) => this.logClose(store, 'BTCUSDT', t)),
      fits = new Map<string, PairFit | null>();
    for (const symbol of c.symbols) {
      if (symbol === 'BTCUSDT') continue;
      if (record) this.count('fit_attempts');
      const lnAlt = times.map((t) => this.logClose(store, symbol, t)),
        both = lnAlt.map(
          (y, k) => Number.isFinite(y) && Number.isFinite(lnBtc[k]),
        ),
        pairs = both.filter(Boolean).length,
        ys = lnAlt.filter((_, k) => both[k]),
        xs = lnBtc.filter((_, k) => both[k]),
        eg = pairs >= 0.9 * n ? engleGranger(ys, xs) : null,
        ols = pairs >= 0.9 * n ? olsHedge(lnAlt, lnBtc) : null;
      if (!eg || !ols) {
        if (record) this.count('fit_failed');
        fits.set(symbol, null);
        continue;
      }
      const olsPath = olsSpread(lnAlt, lnBtc, ols);
      let spread = olsPath,
        carry: KalmanState | null = null,
        beta = ols.beta,
        alpha = ols.alpha,
        innovationZ = NaN;
      if (c.hedgeModel === 'kalman') {
        const run = kalmanHedge(lnAlt, lnBtc, { ...c.kalman });
        spread = kalmanSpread(lnAlt, lnBtc, run.steps);
        carry = run.state;
        const last = run.steps.at(-1)!;
        beta = last.betaPrior;
        alpha = last.alphaPrior;
        innovationZ = last.error / last.errorStd;
      }
      const rets = (v: number[]) => v.slice(1).map((x, k) => x - v[k]!),
        corr = (() => {
          const mx = xs.reduce((a, b) => a + b, 0) / pairs,
            my = ys.reduce((a, b) => a + b, 0) / pairs;
          let sxy = 0,
            sxx = 0,
            syy = 0;
          for (let k = 0; k < pairs; k++) {
            const dx = xs[k]! - mx,
              dy = ys[k]! - my;
            ((sxy += dx * dy), (sxx += dx * dx), (syy += dy * dy));
          }
          return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
        })(),
        fit: PairFit = {
          symbol,
          asOf: clock,
          pairs,
          pValue: eg.pValue,
          halfLife: halfLife(spread.filter(Number.isFinite)),
          dispersionRatio: dispersionRatio(spread, olsPath),
          passes: false,
          beta,
          alpha,
          carry,
          spreads: spread.slice(-c.zWindowBars),
          lastSampleTs: clock,
          innovationZ,
          correlation: corr,
          btcVol: sampleSd(rets(lnBtc)),
          altVol: sampleSd(rets(lnAlt)),
        };
      if (record && Number.isFinite(fit.dispersionRatio))
        this.dispersion.push(fit.dispersionRatio);
      fits.set(symbol, fit);
    }
    const fitted = [...fits.values()].filter((f): f is PairFit => f !== null),
      bh = benjaminiHochberg(
        fitted.map((f) => f.pValue),
        c.fdrQ,
      ),
      pass = new Set<string>();
    fitted.forEach((f, k) => {
      f.passes =
        bh.rejected[k]! &&
        f.pValue <= c.cointegrationMaxP &&
        f.halfLife >= c.halfLifeMinBars &&
        f.halfLife <= this.maxHalfLifeBars &&
        f.beta >= c.minBeta &&
        f.beta <= c.maxBeta;
      if (f.passes) pass.add(f.symbol);
    });
    return { fits, pass };
  }
  private refresh(store: BarStore, i: number) {
    const c = this.config,
      clock =
        Math.floor(store.closeTimeAt(i) / c.refitEveryMs) * c.refitEveryMs;
    if (clock === this.fitClock) return;
    this.fitClock = clock;
    const current = this.fitAt(store, clock, true);
    this.fits = current.fits;
    this.passHistory.set(clock, current.pass);
    // Earlier refits come from bars, not from process history, so replay and live agree.
    for (let k = 1; k < c.persistenceRefits; k++) {
      const t = clock - k * c.refitEveryMs;
      if (!this.passHistory.has(t))
        this.passHistory.set(t, this.fitAt(store, t, false).pass);
    }
    for (const t of this.passHistory.keys())
      if (t <= clock - c.persistenceRefits * c.refitEveryMs)
        this.passHistory.delete(t);
  }
  private eligible(symbol: string) {
    const c = this.config;
    for (let k = 0; k < c.persistenceRefits; k++)
      if (
        !this.passHistory.get(this.fitClock - k * c.refitEveryMs)?.has(symbol)
      )
        return false;
    return true;
  }
  /** Steps the carried hedge through every sample after the fit up to `ts`. */
  private advance(store: BarStore, fit: PairFit, ts: number) {
    const c = this.config;
    for (
      let t = fit.lastSampleTs + c.sampleIntervalMs;
      t <= ts;
      t += c.sampleIntervalMs
    ) {
      const y = this.logClose(store, fit.symbol, t),
        x = this.logClose(store, 'BTCUSDT', t);
      if (fit.carry) {
        const step = kalmanStep(fit.carry, y, x);
        fit.beta = step.betaPrior;
        fit.alpha = step.alphaPrior;
        fit.innovationZ = step.error / step.errorStd;
      }
      fit.spreads.push(y - fit.beta * x - fit.alpha);
      if (fit.spreads.length > c.zWindowBars) fit.spreads.shift();
      fit.lastSampleTs = t;
    }
  }
  /** Candidates at evaluation bar i, best expected net first. Only triggered spreads are returned. */
  evaluate(store: BarStore, i: number): ResidualSignal[] {
    const c = this.config;
    if (!this.isEvaluationBar(store, i)) return [];
    this.count('evaluations');
    this.refresh(store, i);
    const decisionTs = store.closeTimeAt(i),
      eventMs = 4 * 3600000,
      eventId = `kres-${Math.floor(decisionTs / eventMs) * eventMs}`,
      btcPrice = store.close('BTCUSDT', i),
      btcMove = store.logReturn('BTCUSDT', i, c.sampleIntervalMs / MINUTE),
      out: ResidualSignal[] = [];
    for (const [symbol, fit] of this.fits) {
      if (!fit) {
        this.count('fit_unavailable');
        continue;
      }
      this.advance(store, fit, decisionTs);
      if (!this.eligible(symbol)) {
        this.count('not_cointegrated');
        continue;
      }
      this.eligibleEvaluations[symbol] =
        (this.eligibleEvaluations[symbol] ?? 0) + 1;
      const zr = rollingZ(fit.spreads, c.zWindowBars);
      if (!zr) {
        this.count('fit_unavailable');
        continue;
      }
      const { z: zScore, mean, sd } = zr;
      if (Math.abs(zScore) < c.entryZ) {
        this.count('spread_inside_band');
        continue;
      }
      // Alt rich vs BTC (z > 0): short the spread. Alt cheap: long it.
      const side: Side = zScore > 0 ? 'SHORT' : 'LONG';
      if (!c.sides.includes(side)) {
        this.count('side_not_generated');
        continue;
      }
      this.count('residual_triggers');
      const reasons: string[] = [],
        day = store.activity(symbol, i, 1440);
      if (day.volume < c.minQuoteVolume24h)
        reasons.push('insufficient_liquidity');
      if (
        day.missing / 1440 > c.maxMissingFraction ||
        store.activity('BTCUSDT', i, 1440).missing / 1440 > c.maxMissingFraction
      )
        reasons.push('incomplete_bars');
      const g = signalGeometry(c, {
        spread: fit.spreads.at(-1)!,
        mean,
        sd,
        z: zScore,
        beta: fit.beta,
        halfLife: fit.halfLife,
      });
      if (g.stopBps <= 0) reasons.push('beyond_stop_z');
      if (g.targetBps < c.costSafetyMultiple * g.costBps)
        reasons.push('edge_below_cost');
      for (const reason of reasons) this.count(reason);
      this.count(reasons.length ? 'rejected' : 'accepted');
      const altMove = store.logReturn(symbol, i, c.sampleIntervalMs / MINUTE);
      out.push({
        id: `${eventId}-${decisionTs}-${symbol}-${side}`,
        eventId,
        symbol,
        side,
        instrument: 'hedged',
        decisionTs,
        entryAtTs: decisionTs + c.entryDelayMs,
        referencePrice: store.close(symbol, i),
        btcReferencePrice: btcPrice,
        beta: fit.beta,
        btcMoveBps: (btcMove ?? NaN) * 1e4,
        btcZ: 0,
        altMoveBps: (altMove ?? NaN) * 1e4,
        residualBps: (fit.spreads.at(-1)! - mean) * 1e4,
        residualZ: zScore,
        lagBps: g.targetBps,
        expectedBps: g.targetBps,
        costBps: g.costBps,
        expectedNetBps: g.targetBps - g.costBps,
        targetBps: g.targetBps,
        stopBps: g.stopBps,
        rewardRisk: (g.targetBps - g.costBps) / (g.stopBps + g.costBps),
        targetPrice: null,
        stopPrice: null,
        entryPriceLimit: null,
        holdMs: g.holdMs,
        fit: {
          symbol,
          asOf: fit.asOf,
          samples: fit.pairs,
          alpha: fit.alpha,
          beta: fit.beta,
          correlation: fit.correlation,
          residualVol: sd,
          btcVol: fit.btcVol,
          altVol: fit.altVol,
          reversion: 0,
          reversionT: 0,
          reversionSamples: 0,
        } satisfies ResidualFit,
        kalman: {
          hedgeModel: c.hedgeModel,
          pValue: fit.pValue,
          halfLife: fit.halfLife,
          dispersionRatio: fit.dispersionRatio,
          innovationZ: fit.innovationZ,
        },
        accepted: !reasons.length,
        executable: !reasons.length && c.executableSides.includes(side),
        reasons,
        score: Math.round(
          100 *
            Math.max(
              0,
              Math.min(1, (Math.abs(zScore) - c.entryZ) / (c.stopZ - c.entryZ)),
            ),
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

/**
 * Target, stop, hold and cost in hedged log-return units (spec §5.4). The mean
 * and sd are frozen at entry: target is the move that brings z to exitZ, stop
 * the move that takes |z| to stopZ.
 */
export function signalGeometry(
  c: Pick<
    KalmanResidualConfig,
    | 'exitZ'
    | 'stopZ'
    | 'maxHoldHalfLives'
    | 'maxHoldMs'
    | 'sampleIntervalMs'
    | 'feeBpsPerSide'
    | 'slippageBpsPerSide'
    | 'spreadBps'
    | 'instrument'
  >,
  s: {
    spread: number;
    mean: number;
    sd: number;
    z: number;
    beta: number;
    halfLife: number;
  },
) {
  const target = Math.abs(s.spread - s.mean) - c.exitZ * s.sd,
    stop = (c.stopZ - Math.abs(s.z)) * s.sd,
    hold = Math.min(
      c.maxHoldHalfLives * s.halfLife * c.sampleIntervalMs,
      c.maxHoldMs,
    );
  return {
    targetBps: target * 1e4,
    stopBps: stop * 1e4,
    holdMs: Math.floor(hold / MINUTE) * MINUTE,
    costBps: roundTripCostBps(c, s.beta),
  };
}
