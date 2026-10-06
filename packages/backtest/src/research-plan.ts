import { z } from 'zod';
import { createHash } from 'node:crypto';
import { symbolSchema } from '../../domain/src/index.js';
import {
  strategySchema,
  type StrategyConfig,
} from '../../signals/src/index.js';
const clock = z
  .string()
  .datetime({ offset: true })
  .refine((s) => Date.parse(s) % 1000 === 0, 'Time must align to a UTC second');
const foldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  trainStart: clock,
  trainEnd: clock,
  validationEnd: clock,
  testEnd: clock,
});
export const planSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    source: z.enum(['live', 'historical']),
    symbols: z.array(symbolSchema).min(2).max(100),
    baseConfig: z.string(),
    variants: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
          overrides: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1)
      .max(8),
    minValidationTrades: z.number().int().positive(),
    folds: z.array(foldSchema).min(1),
    holdout: z.object({ trainStart: clock, start: clock, end: clock }),
    acceptance: z.object({
      minClosedTrades: z.number().int().min(1),
      minWinRate: z.number().min(0).max(1),
      minProfitFactor: z.number().positive(),
      minEvents: z.number().int().positive(),
      minAssets: z.number().int().positive(),
    }),
  })
  .superRefine((p, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (
      !p.symbols.includes('BTCUSDT') ||
      new Set(p.symbols).size !== p.symbols.length
    )
      issue('Universe must contain BTC and unique symbols');
    if (
      new Set(p.variants.map((v) => v.id)).size !== p.variants.length ||
      new Set(p.folds.map((f) => f.id)).size !== p.folds.length
    )
      issue('Duplicate variant or fold ID');
    let previousTestEnd = 0;
    for (const fold of p.folds) {
      const [a, b, c, d] = [
        fold.trainStart,
        fold.trainEnd,
        fold.validationEnd,
        fold.testEnd,
      ].map(Date.parse);
      if (!(a! < b! && b! < c! && c! < d!))
        issue('Fold clocks must increase: train, validation, test');
      if (c! < previousTestEnd) issue('Unseen test blocks overlap');
      previousTestEnd = d!;
    }
    const h = p.holdout;
    if (!(
      Date.parse(h.trainStart) < Date.parse(h.start) &&
      Date.parse(h.start) < Date.parse(h.end) &&
      previousTestEnd <= Date.parse(h.start)
    ))
      issue('Holdout overlaps tests or has invalid clocks');
  });
export type ResearchPlan = z.infer<typeof planSchema>;
export interface FrozenVariant {
  id: string;
  config: StrategyConfig;
  configHash: string;
}
export interface FrozenResearch {
  schemaVersion: 1;
  createdAt: string;
  plan: ResearchPlan;
  variants: FrozenVariant[];
  planHash: string;
}
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function freezeResearch(
  plan: ResearchPlan,
  base: StrategyConfig,
  createdAt = new Date().toISOString(),
): FrozenResearch {
  const parsed = planSchema.parse(plan);
  const variants = parsed.variants.map((v) => {
    const config = strategySchema.parse({
      ...base,
      ...v.overrides,
      version: `${base.version}-${v.id}`,
    });
    const folds = [
      ...parsed.folds.map((f) => ({ start: f.trainStart, end: f.trainEnd })),
      { start: parsed.holdout.trainStart, end: parsed.holdout.start },
    ];
    for (const fold of folds)
      if (
        Date.parse(fold.end) - Date.parse(fold.start) <
        config.windowMs + config.horizonMs + Math.max(...config.lagGridMs)
      )
        throw new Error(
          'Training blocks must cover the full feature window plus horizon and lag',
        );
    return { id: v.id, config, configHash: hash(config) };
  });
  return {
    schemaVersion: 1,
    createdAt,
    plan: parsed,
    variants,
    planHash: hash({ plan: parsed, variants }),
  };
}
export function verifyFrozen(input: unknown): FrozenResearch {
  const schema = z.object({
    schemaVersion: z.literal(1),
    createdAt: z.string().datetime(),
    plan: planSchema,
    variants: z.array(
      z.object({
        id: z.string(),
        config: strategySchema,
        configHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const raw = schema.parse(input);
  if (
    raw.variants.length !== raw.plan.variants.length ||
    raw.variants.some(
      (v, i) =>
        v.id !== raw.plan.variants[i]?.id || hash(v.config) !== v.configHash,
    ) ||
    hash({ plan: raw.plan, variants: raw.variants }) !== raw.planHash
  )
    throw new Error('Frozen research provenance mismatch');
  return raw;
}
