import { z } from 'zod';
import {
  evidenceClassSchema,
  marketSchema,
  purchasedDataRecordSchema,
  symbolSchema,
  type EvidenceRef,
  type PurchasedDataRecord,
} from './types.js';

export const researchEvidenceSetSchema = z
  .object({
    researchRunId: z.string(),
    asset: symbolSchema,
    market: marketSchema,
    generatedAt: z.number().int().positive(),
    items: z.array(
      z
        .object({
          id: z.string(),
          dataType: z.string(),
          classification: evidenceClassSchema,
          source: z.string(),
          asOf: z.number().int().nonnegative(),
          digest: z.string(),
          summary: z.string(),
          purchaseId: z.string().nullable(),
          validationState: z
            .enum(['PENDING', 'VALIDATED', 'VALIDATION_FAILED'])
            .nullable(),
        })
        .strict(),
    ),
    counts: z.record(evidenceClassSchema, z.number().int().nonnegative()),
    exclusions: z.array(
      z.object({ purchaseId: z.string(), reason: z.string() }).strict(),
    ),
    /** jay logs: paid data never raises signal confidence on its own. */
    signalConfidenceDelta: z.literal(0),
    confidenceRationale: z.string().max(600),
    attestation: z.string().max(600),
  })
  .strict();
export type ResearchEvidenceSet = z.infer<typeof researchEvidenceSetSchema>;

export interface IntegrateEvidenceInput {
  researchRunId: string;
  asset: string;
  market: 'spot' | 'usdm';
  now: number;
  local: EvidenceRef[];
  purchased: PurchasedDataRecord[];
}

// jay logs: integrate local and purchased evidence into a single set, with counts and exclusions.
export function integrateEvidence(
  input: IntegrateEvidenceInput,
): ResearchEvidenceSet {
  const items: ResearchEvidenceSet['items'] = input.local.map((item) => ({
      id: item.id,
      dataType: item.dataType,
      classification: item.classification,
      source: item.source,
      asOf: item.asOf,
      digest: item.digest,
      summary: item.summary,
      purchaseId: null,
      validationState: null,
    })),
    exclusions: { purchaseId: string; reason: string }[] = [];
  for (const record of input.purchased) {
    const parsed = purchasedDataRecordSchema.parse(record);
    if (parsed.validationState !== 'VALIDATED') {
      exclusions.push({
        purchaseId: parsed.purchaseId,
        reason: `purchased data failed validation: ${parsed.validationReasons.join('; ') || 'no reason recorded'}`,
      });
      continue;
    }
    items.push({
      id: parsed.purchaseId,
      dataType: parsed.dataType,
      classification: 'purchased',
      source: `paid:${parsed.providerId}/${parsed.serviceId}`,
      asOf: parsed.responseTs,
      digest: parsed.contentDigest,
      summary: `Paid ${parsed.quoteAmountUsdc} USDC for ${parsed.dataType} (payment ${parsed.paymentReference})`,
      purchaseId: parsed.purchaseId,
      validationState: parsed.validationState,
    });
  }
  const counts = {
    measured: 0,
    purchased: 0,
    interpretation: 0,
    backtest: 0,
    assumption: 0,
  };
  for (const item of items) counts[item.classification] += 1;
  return researchEvidenceSetSchema.parse({
    researchRunId: input.researchRunId,
    asset: input.asset,
    market: input.market,
    generatedAt: input.now,
    items,
    counts,
    exclusions,
    signalConfidenceDelta: 0,
    confidenceRationale:
      'Purchased evidence is corroborating context. It cannot raise signal confidence without an explicit, testable rule; no such rule is implemented, so the delta is zero.',
    attestation:
      'Measured local indicators, externally purchased facts, model interpretations and backtest results are recorded separately and are never conflated in reporting.',
  });
}
