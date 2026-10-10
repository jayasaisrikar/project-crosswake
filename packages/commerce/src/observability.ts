import { z } from 'zod';
import { formatUsdc, parseUsdc, type UsdcAmount } from './money.js';
import { purchaseRecordSchema, type PurchaseRecord } from './types.js';

export const runCostReportSchema = z
  .object({
    researchRunId: z.string(),
    generatedAt: z.number().int().positive(),
    counts: z
      .object({
        needsIdentified: z.number().int().nonnegative(),
        missingDataDecisions: z.number().int().nonnegative(),
        offersConsidered: z.number().int().nonnegative(),
        quotesReceived: z.number().int().nonnegative(),
        purchasesRequested: z.number().int().nonnegative(),
        purchasesApproved: z.number().int().nonnegative(),
        purchasesDeclined: z.number().int().nonnegative(),
        purchasesSettled: z.number().int().nonnegative(),
        paymentFailures: z.number().int().nonnegative(),
        validationFailures: z.number().int().nonnegative(),
        duplicatePurchaseAttempts: z.number().int().nonnegative(),
        researchTasksCompleted: z.number().int().nonnegative(),
      })
      .strict(),
    usdcPaid: z.string(),
    networkFeesUsdc: z.string(),
    llmCostUsdc: z.string().nullable(),
    llmTokens: z.number().int().nonnegative().nullable(),
    totalMarginalCostUsdc: z.string().nullable(),
    providerResponseMs: z.record(z.string(), z.number().nonnegative()),
    dataFreshnessMs: z.record(z.string(), z.number()),
    purchases: z.array(purchaseRecordSchema),
    caveat: z.string(),
  })
  .strict();
export type RunCostReport = z.infer<typeof runCostReportSchema>;

export interface RunCostInput {
  researchRunId: string;
  now: number;
  purchases: PurchaseRecord[];
  counters: Partial<RunCostReport['counts']>;
  providerResponseMs?: Record<string, number>;
  dataFreshnessMs?: Record<string, number>;
  llmTokens?: number | null;
  llmCostUsdc?: string | null;
  /** Observed facilitator/network fee, when the seller or facilitator reports one. */
  networkFeesUsdc?: UsdcAmount;
}

const zero: RunCostReport['counts'] = {
  needsIdentified: 0,
  missingDataDecisions: 0,
  offersConsidered: 0,
  quotesReceived: 0,
  purchasesRequested: 0,
  purchasesApproved: 0,
  purchasesDeclined: 0,
  purchasesSettled: 0,
  paymentFailures: 0,
  validationFailures: 0,
  duplicatePurchaseAttempts: 0,
  researchTasksCompleted: 0,
};

/**
 * Marginal cost accounting for one research run. Token cost is only reported
 * when the caller supplies it; nothing here is inferred or estimated, and no
 * claim is made that paid data improved trading performance.
 */
export function runCostReport(input: RunCostInput): RunCostReport {
  const paid = input.purchases
      .filter((p) => p.paymentState === 'SETTLED')
      .reduce((sum, p) => sum + parseUsdc(p.amountUsdc), 0n),
    fees = input.networkFeesUsdc ?? 0n,
    llmCost = input.llmCostUsdc ?? null;
  return runCostReportSchema.parse({
    researchRunId: input.researchRunId,
    generatedAt: input.now,
    counts: { ...zero, ...input.counters },
    usdcPaid: formatUsdc(paid),
    networkFeesUsdc: formatUsdc(fees as UsdcAmount),
    llmCostUsdc: llmCost,
    llmTokens: input.llmTokens ?? null,
    totalMarginalCostUsdc: formatUsdc(
      paid + fees + (llmCost === null ? 0n : parseUsdc(llmCost)),
    ),
    providerResponseMs: input.providerResponseMs ?? {},
    dataFreshnessMs: input.dataFreshnessMs ?? {},
    purchases: input.purchases,
    caveat:
      'Cost and provenance accounting only. Paid data is not claimed to improve trading performance without an out-of-sample experiment.',
  });
}
