import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceGate } from './evidence.js';
import { metrics } from './index.js';
import { hash } from './research-plan.js';
import {
  residualReport,
  runEngine,
  type ResidualTrade,
  type SignalEngine,
} from './residual.js';
import type { BarStore } from '../../quant/src/residual.js';
import type { FundingEvent } from '../../market-data/src/klines.js';
import {
  ResidualEngine,
  configHash,
  residualSchema,
  type ResidualConfig,
} from '../../signals/src/residual.js';
import {
  KalmanResidualEngine,
  kalmanConfigHash,
  kalmanResidualSchema,
  type KalmanResidualConfig,
} from '../../signals/src/kalman-residual.js';

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
  'zWindowBars',
]);
export const residualPlanSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    /** Absent means the v003/v004 ResidualEngine (kept optional so existing plan hashes are unchanged). */
    engine: z.enum(['residual', 'kalman']).optional(),
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
  config: ResidualConfig | KalmanResidualConfig;
  configHash: string;
}
/** Builds the plan's engine for one variant config. */
export const planEngine = (
  plan: Pick<ResidualPlan, 'engine'>,
  config: ResidualVariant['config'],
): SignalEngine =>
  plan.engine === 'kalman'
    ? new KalmanResidualEngine(config as KalmanResidualConfig)
    : new ResidualEngine(config as ResidualConfig);
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
    const merged = { ...(base as object), ...overrides };
    if (plan.engine === 'kalman') {
      const config = kalmanResidualSchema.parse(merged);
      return {
        id:
          Object.entries(overrides)
            .map(([k, v]) => `${k}=${v}`)
            .join(',') || 'base',
        overrides,
        config,
        configHash: kalmanConfigHash(config),
      };
    }
    const config = residualSchema.parse(merged);
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
      ...variants.map((v) => planEngine(plan, v.config).warmupBars),
    ),
    evalStart = Date.parse(plan.dataStart) + warmup * 60000,
    runs = variants.map((variant) => ({
      variant,
      ...runEngine(
        store,
        planEngine(plan, variant.config),
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
    /** The concatenated unseen test trades, for the v009 Step B checks (re-pricing, trade rate). */
    outOfSampleTrades: oos,
    testDays: (folds.length * plan.testMs) / 86400000,
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
    /** Per-variant engine diagnostics (v009: dispersion ratios per fit, eligibility per symbol). */
    variantDiagnostics: runs.map((r) => ({
      id: r.variant.id,
      funnel: r.diagnostics,
      dispersionRatios:
        (r.engineDiagnostics.dispersionRatios as number[] | undefined) ?? [],
      eligibleEvaluations:
        (r.engineDiagnostics.eligibleEvaluations as
          Record<string, number> | undefined) ?? {},
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
  if (
    plan.engine === 'kalman' &&
    kalmanResidualSchema.parse(base).hedgeModel === 'ols'
  )
    throw new Error(
      'The v009 OLS control runs walk-forward only; it never spends a holdout',
    );
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
  const run = runEngine(
      store,
      planEngine(plan, chosen.config),
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

/**
 * v009 Step B (pre-registered, docs/residual-kalman-v009.md §10): all five must
 * hold on the Kalman walk-forward's unseen trades before the holdout may be spent.
 */
export function kalmanStepB(
  kalman: { trades: ResidualTrade[]; testDays: number },
  control: { trades: ResidualTrade[] },
) {
  const k = metrics(kalman.trades),
    mean = (xs: number[]) =>
      xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN,
    gross = mean(kalman.trades.map((t) => t.grossReturnBps)),
    cost = mean(kalman.trades.map((t) => t.feeBps + t.slippageBps)),
    // 2x fee + slippage + spread (slippageBps carries the spread); funding unchanged.
    doubled = mean(
      kalman.trades.map((t) => t.netReturnBps - t.feeBps - t.slippageBps),
    ),
    controlNet = metrics(control.trades).netExpectancyBps ?? -Infinity,
    rate = kalman.trades.length / kalman.testDays,
    checks = {
      B1_positive_expectancy_and_ci:
        (k.netExpectancyBps ?? -Infinity) > 0 &&
        (k.eventClusterBootstrap?.netExpectancyBps95[0] ?? -Infinity) > 0,
      B2_gross_at_least_1_5x_cost: gross >= 1.5 * cost,
      B3_positive_at_2x_costs: doubled > 0,
      B4_at_least_5_trades_per_day: rate >= 5,
      B5_kalman_beats_ols_control:
        (k.netExpectancyBps ?? -Infinity) > controlNet,
    };
  return {
    go: Object.values(checks).every(Boolean),
    checks,
    values: {
      trades: k.closedTrades,
      events: k.btcEventCount,
      netExpectancyBps: k.netExpectancyBps,
      ci95: k.eventClusterBootstrap?.netExpectancyBps95 ?? null,
      grossPerTradeBps: gross,
      costPerTradeBps: cost,
      netAt2xCostsBps: doubled,
      tradesPerDay: rate,
      profitFactor: k.profitFactor,
      controlNetExpectancyBps: controlNet,
    },
  };
}
