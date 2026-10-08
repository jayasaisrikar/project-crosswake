import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceGate } from './evidence.js';
import { metrics } from './index.js';
import { hash } from './research-plan.js';
import { residualReport, runResidual, type ResidualTrade } from './residual.js';
import type { BarStore } from '../../quant/src/residual.js';
import type { FundingEvent } from '../../market-data/src/klines.js';
import {
  ResidualEngine,
  configHash,
  residualSchema,
  type ResidualConfig,
} from '../../signals/src/residual.js';

const clock = z
  .string()
  .datetime({ offset: true })
  .refine((s) => Date.parse(s) % 60000 === 0, 'Clock must align to a minute');
const tunable = z.enum([
  'lookbackMs',
  'holdMs',
  'entryZ',
  'btcMoveZMin',
  'btcDirection',
  'targetLagFraction',
  'stopVolMultiple',
  'minReversionT',
  'minRewardRisk',
]);
export const residualPlanSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    baseConfig: z.string(),
    grid: z.partialRecord(tunable, z.array(z.unknown()).min(1)),
    dataStart: clock,
    /** Optional first unseen test clock, e.g. to keep tests after a discovery period. */
    firstTestStart: clock.optional(),
    walkForwardEnd: clock,
    selectionMs: z.number().int().positive().multipleOf(86400000),
    testMs: z.number().int().positive().multipleOf(86400000),
    minSelectionTrades: z.number().int().positive(),
    holdout: z.object({ start: clock, end: clock }),
    acceptance: z.object({
      policy: z.literal('net-expectancy'),
      minClosedTrades: z.number().int().min(1),
      minWinRate: z.number().min(0).max(1),
      minProfitFactor: z.number().positive(),
      minEvents: z.number().int().positive(),
      minAssets: z.number().int().positive(),
      maxDrawdownBps: z.number().positive(),
      maxAssetPnlShare: z.number().positive().max(1),
    }),
  })
  .strict()
  .superRefine((p, ctx) => {
    const [a, b, c, d] = [
      p.dataStart,
      p.walkForwardEnd,
      p.holdout.start,
      p.holdout.end,
    ].map(Date.parse);
    if (!(a! < b! && b! <= c! && c! < d!))
      ctx.addIssue({
        code: 'custom',
        message: 'Clocks must be ordered: data, walk-forward end, holdout',
      });
  });
export type ResidualPlan = z.infer<typeof residualPlanSchema>;
export interface ResidualVariant {
  id: string;
  overrides: Record<string, unknown>;
  config: ResidualConfig;
  configHash: string;
}
export function residualVariants(
  plan: ResidualPlan,
  base: unknown,
): ResidualVariant[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const [name, values] of Object.entries(plan.grid))
    combos = combos.flatMap((combo) =>
      values!.map((value) => ({ ...combo, [name]: value })),
    );
  if (combos.length > 64) throw new Error('Grid exceeds 64 variants');
  return combos.map((overrides) => {
    const config = residualSchema.parse({
      ...(base as object),
      ...overrides,
    });
    return {
      id:
        Object.entries(overrides)
          .map(([k, v]) => `${k}=${v}`)
          .join(',') || 'base',
      overrides,
      config,
      configHash: configHash(config),
    };
  });
}
export const planHash = (plan: ResidualPlan, base: unknown) =>
  hash({ plan, base });

/** Executable trades decided in [start, end) that also finished by end. */
const inWindow = (trades: ResidualTrade[], start: number, end: number) =>
  trades.filter(
    (t) =>
      t.executable &&
      t.decisionTs >= start &&
      t.decisionTs < end &&
      t.exitTs <= end,
  );
function choose(
  runs: { variant: ResidualVariant; trades: ResidualTrade[] }[],
  start: number,
  end: number,
  minTrades: number,
) {
  const scored = runs
    .map(({ variant, trades }) => ({
      variant,
      metrics: metrics(inWindow(trades, start, end)),
    }))
    .filter((r) => r.metrics.closedTrades >= minTrades)
    .sort(
      (a, b) =>
        b.metrics.netExpectancyBps! - a.metrics.netExpectancyBps! ||
        (b.metrics.profitFactor ?? 0) - (a.metrics.profitFactor ?? 0) ||
        a.variant.id.localeCompare(b.variant.id),
    );
  return scored[0] ?? null;
}

/**
 * Each variant runs once, causally, over the whole walk-forward span. Folds
 * then pick the best variant on a trailing selection window and score it on
 * the following unseen test window. The store must hold no holdout bars.
 */
export function residualWalkForward(
  store: BarStore,
  plan: ResidualPlan,
  base: unknown,
  funding?: Map<string, FundingEvent[]>,
) {
  const end = Date.parse(plan.walkForwardEnd);
  if (store.closeTimeAt(store.length - 1) > end)
    throw new Error('Walk-forward store contains bars after walkForwardEnd');
  const variants = residualVariants(plan, base),
    warmup = Math.max(
      ...variants.map((v) => new ResidualEngine(v.config).warmupBars),
    ),
    evalStart = Date.parse(plan.dataStart) + warmup * 60000,
    runs = variants.map((variant) => ({
      variant,
      ...runResidual(
        store,
        variant.config,
        { startTs: evalStart, endTs: end },
        funding,
      ),
    }));
  const folds = [],
    oos: ResidualTrade[] = [];
  const firstTest = plan.firstTestStart
    ? Date.parse(plan.firstTestStart)
    : evalStart + plan.selectionMs;
  if (firstTest - plan.selectionMs < evalStart)
    throw new Error(
      'First test leaves no complete selection window after warm-up',
    );
  for (
    let testStart = firstTest;
    testStart + plan.testMs <= end;
    testStart += plan.testMs
  ) {
    const chosen = choose(
        runs,
        testStart - plan.selectionMs,
        testStart,
        plan.minSelectionTrades,
      ),
      run = chosen && runs.find((r) => r.variant.id === chosen.variant.id)!,
      test = run
        ? inWindow(run.trades, testStart, testStart + plan.testMs)
        : [];
    oos.push(...test);
    folds.push({
      selection: [testStart - plan.selectionMs, testStart],
      test: [testStart, testStart + plan.testMs],
      chosen: chosen?.variant.id ?? null,
      selectionMetrics: chosen?.metrics ?? null,
      testMetrics: metrics(test),
    });
  }
  const final = choose(
      runs,
      end - plan.selectionMs,
      end,
      plan.minSelectionTrades,
    ),
    gate = evidenceGate(oos, plan.acceptance);
  return {
    planId: plan.id,
    planHash: planHash(plan, base),
    evaluationStart: evalStart,
    walkForwardEnd: end,
    folds,
    outOfSample: residualReport(oos),
    gate,
    finalSelection: final
      ? {
          variantId: final.variant.id,
          configHash: final.variant.configHash,
          config: final.variant.config,
          selectionMetrics: final.metrics,
        }
      : null,
    variantsInSample: runs.map((r) => ({
      id: r.variant.id,
      configHash: r.variant.configHash,
      ...metrics(r.trades.filter((t) => t.executable)),
      unfinished: r.unfinished,
      rejections: r.rejections,
      funnel: r.diagnostics,
    })),
    limitations: [
      'Variants run continuously; capacity and cooldown state carry across fold boundaries',
      'Trades are purged from a window unless decided and closed inside it',
      'variantsInSample is full-period and in-sample for selection; only outOfSample is unseen',
    ],
  };
}
export type ResidualWalkForwardReport = ReturnType<typeof residualWalkForward>;

/** Consumes the holdout once. The reservation stays even if evaluation fails. */
export async function residualHoldout(
  root: string,
  store: BarStore,
  plan: ResidualPlan,
  base: unknown,
  walkForward: Pick<
    ResidualWalkForwardReport,
    'planHash' | 'gate' | 'finalSelection'
  >,
  funding?: Map<string, FundingEvent[]>,
) {
  const expected = planHash(plan, base);
  if (walkForward.planHash !== expected)
    throw new Error('Walk-forward report belongs to another plan');
  if (!walkForward.gate.passed || !walkForward.finalSelection)
    throw new Error(
      'Walk-forward evidence did not pass; the holdout stays sealed',
    );
  const chosen = residualVariants(plan, base).find(
    (v) =>
      v.id === walkForward.finalSelection!.variantId &&
      v.configHash === walkForward.finalSelection!.configHash,
  );
  if (!chosen) throw new Error('Selected variant is not in the plan');
  const start = Date.parse(plan.holdout.start),
    end = Date.parse(plan.holdout.end),
    dir = join(
      root,
      'research-locks',
      `residual-${hash({ id: plan.id, start, end })}.holdout`,
    );
  await mkdir(join(root, 'research-locks'), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'This holdout was already reserved; repeated evaluation is blocked',
      );
    throw error;
  }
  await writeFile(
    join(dir, 'reservation.json'),
    JSON.stringify(
      {
        planHash: expected,
        variantId: chosen.id,
        configHash: chosen.configHash,
        start,
        end,
        reservedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const run = runResidual(
      store,
      chosen.config,
      { startTs: start, endTs: end },
      funding,
    ),
    trades = run.trades.filter((t) => t.executable);
  return {
    planHash: expected,
    variantId: chosen.id,
    report: residualReport(run.trades, run.unfinished),
    gate: evidenceGate(trades, plan.acceptance, run.unfinished.openPositions),
    reservation: dir,
  };
}
