import { FixedHorizonTracker, costStress } from './robustness.js';
import type { Snapshot } from '../../domain/src/index.js';
import {
  SignalEngine,
  type Candidate,
  type StrategyConfig,
} from '../../signals/src/index.js';
import { PaperBacktester, metrics, type PaperTrade } from './index.js';
import type { FrozenResearch, FrozenVariant } from './research-plan.js';
export type DatasetLoader = (range: {
  startTs: number;
  endTs: number;
}) => AsyncIterable<Snapshot[]>;
export interface WindowResult {
  trades: PaperTrade[];
  metrics: ReturnType<typeof metrics>;
  candidates: number;
  boundaryPurged: number;
  unfinished: { pending: number; openPositions: number };
  trainingRelationships: ReturnType<SignalEngine['freezeRelationships']>;
  horizonOutcomes: ReturnType<FixedHorizonTracker['summary']>;
  costStress: ReturnType<typeof costStress>;
  firstObservedTs: number | null;
  lastObservedTs: number | null;
}
/** Fit before start, freeze once, and never let labels outside [start,end) affect selection. */
export async function evaluateWindow(
  load: DatasetLoader,
  config: StrategyConfig,
  trainStart: number,
  start: number,
  end: number,
): Promise<WindowResult> {
  const engine = new SignalEngine(config),
    paper = new PaperBacktester(config),
    horizons = new FixedHorizonTracker();
  let frozen = false,
    candidates = 0,
    boundaryPurged = 0,
    firstObservedTs: number | null = null,
    lastObservedTs: number | null = null;
  let trainingRelationships: ReturnType<SignalEngine['freezeRelationships']> =
    {};
  for await (const rows of load({ startTs: trainStart, endTs: end })) {
    const ts = rows[0]?.ts;
    if (ts === undefined || ts < trainStart || ts >= end) continue;
    firstObservedTs ??= ts;
    lastObservedTs = ts;
    if (ts < start) {
      if (rows.every((r) => (r.availableAt ?? r.ts) < start))
        engine.update(rows);
      continue;
    }
    if (!frozen) {
      trainingRelationships = engine.freezeRelationships();
      frozen = true;
    }
    paper.update(rows);
    horizons.update(rows);
    const signals = engine.update(rows);
    candidates += signals.length;
    const eligible: Candidate[] = [];
    for (const signal of signals) {
      if (signal.decisionTs + config.maxEntryWaitMs + config.maxHoldMs >= end)
        boundaryPurged++;
      else eligible.push(signal);
    }
    paper.submit(eligible);
    horizons.submit(eligible);
  }
  horizons.close();
  return {
    horizonOutcomes: horizons.summary(),
    costStress: costStress(paper.trades),
    trades: paper.trades,
    metrics: metrics(paper.trades),
    candidates,
    boundaryPurged,
    unfinished: paper.unfinished,
    trainingRelationships,
    firstObservedTs,
    lastObservedTs,
  };
}
export interface ValidationEntry {
  variantId: string;
  result: WindowResult;
}
export function selectVariant(
  variants: FrozenVariant[],
  validations: ValidationEntry[],
  minTrades: number,
) {
  const scores = variants.map((variant) => {
    const results = validations
      .filter((v) => v.variantId === variant.id)
      .map((v) => v.result);
    const trades = results.flatMap((r) => r.trades),
      summary = metrics(trades);
    return {
      variant,
      metrics: summary,
      unfinished: results.reduce((n, r) => n + r.unfinished.openPositions, 0),
      qualified:
        trades.length >= minTrades &&
        results.every((r) => r.unfinished.openPositions === 0),
    };
  });
  const qualified = scores
    .filter((s) => s.qualified)
    .sort(
      (a, b) =>
        (b.metrics.netExpectancyBps ?? -Infinity) -
          (a.metrics.netExpectancyBps ?? -Infinity) ||
        a.variant.id.localeCompare(b.variant.id),
    );
  return {
    chosen: qualified[0]?.variant ?? variants[0]!,
    qualified: qualified.length > 0,
    scores: scores.map(({ variant, ...score }) => ({
      variantId: variant.id,
      ...score,
    })),
  };
}
export async function walkForward(load: DatasetLoader, frozen: FrozenResearch) {
  const folds: {
    id: string;
    validations: ValidationEntry[];
    selection: ReturnType<typeof selectVariant>;
    test: WindowResult;
  }[] = [];
  const validations: ValidationEntry[] = [];
  for (const fold of frozen.plan.folds) {
    const trainStart = Date.parse(fold.trainStart),
      validationStart = Date.parse(fold.trainEnd),
      testStart = Date.parse(fold.validationEnd),
      testEnd = Date.parse(fold.testEnd);
    const current: ValidationEntry[] = [];
    for (const variant of frozen.variants) {
      const result = await evaluateWindow(
        load,
        variant.config,
        trainStart,
        validationStart,
        testStart,
      );
      current.push({ variantId: variant.id, result });
    }
    const selection = selectVariant(
      frozen.variants,
      current,
      frozen.plan.minValidationTrades,
    );
    const test = await evaluateWindow(
      load,
      selection.chosen.config,
      trainStart,
      testStart,
      testEnd,
    );
    folds.push({ id: fold.id, validations: current, selection, test });
    validations.push(...current);
  }
  const selected = selectVariant(
      frozen.variants,
      validations,
      frozen.plan.minValidationTrades,
    ),
    trades = folds.flatMap((f) => f.test.trades);
  return {
    planHash: frozen.planHash,
    folds,
    selection: selected,
    unseenMetrics: metrics(trades),
    unseenTrades: trades,
    qualification: 'CHRONOLOGICAL_WALK_FORWARD_NOT_VALIDATED_ALPHA',
    unqualifiedFolds: folds
      .filter((f) => !f.selection.qualified)
      .map((f) => f.id),
  };
}
