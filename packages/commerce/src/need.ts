import { z } from 'zod';
import type { CommerceLedger } from './ledger.js';
import type { ProviderRegistryIndex } from './registry.js';
import {
  dataTypeSchema,
  prioritySchema,
  researchNeedSchema,
  usdcSchema,
  type EvidenceRef,
  type ResearchDataType,
  type ResearchNeed,
  type SpendPolicy,
} from './types.js';

/**
 * A declared research gap: a metric the pipeline cannot produce locally.
 * Gaps are static, operator-owned knowledge about the pipeline, not model output.
 */
export const researchGapSchema = z
  .object({
    dataType: dataTypeSchema,
    reason: z.string().min(1).max(2000),
    expectedResearchBenefit: z.string().min(1).max(2000),
    desiredFreshnessMs: z.number().int().positive(),
    maxCostUsdc: usdcSchema,
    priority: prioritySchema,
  })
  .strict();
export type ResearchGap = z.infer<typeof researchGapSchema>;

/**
 * Reads what evidence already exists for an asset and declares which metrics
 * the pipeline itself cannot produce. Implementations are Crosswake-specific;
 * the detector below only needs this interface, which keeps commerce portable.
 */
export interface ResearchEvidenceSource {
  asset: string;
  market: 'spot' | 'usdm';
  inventory(now: number): Promise<{
    items: EvidenceRef[];
    gaps: ResearchGap[];
    provenance: string[];
  }>;
}

export const needDecisionSchema = z
  .object({
    status: z.enum(['NEEDS_IDENTIFIED', 'NO_PURCHASE_NEEDED', 'NO_PROVIDER']),
    needs: z.array(researchNeedSchema),
    missingDataReport: z.array(
      z
        .object({ dataType: dataTypeSchema, reason: z.string().max(400) })
        .strict(),
    ),
    notes: z.array(z.string().max(400)),
  })
  .strict();
export type NeedDecision = z.infer<typeof needDecisionSchema>;

export interface DetectNeedsInput {
  researchRunId: string;
  source: ResearchEvidenceSource;
  registry: ProviderRegistryIndex;
  policy: SpendPolicy;
  ledger?: CommerceLedger;
  now: number;
}

/** An item counts as covering a gap only if it is classified as observed data and still fresh. */
function coveringEvidence(
  items: EvidenceRef[],
  dataType: ResearchDataType,
  desiredFreshnessMs: number,
  now: number,
): EvidenceRef | undefined {
  return items.find(
    (item) =>
      item.dataType === dataType &&
      (item.classification === 'measured' ||
        item.classification === 'purchased') &&
      item.asOf + Math.min(item.freshnessMs, desiredFreshnessMs) >= now,
  );
}

/**
 * Research Need Detector.
 *
 * It never buys what the pipeline already has and is fresh, never assumes a
 * missing metric needs money (no reliable provider still yields a missing-data
 * report with no purchase), and never pays twice for equivalent data in one run.
 */
export async function detectResearchNeeds(
  input: DetectNeedsInput,
): Promise<NeedDecision> {
  const { items, gaps, provenance } = await input.source.inventory(input.now),
    needs: ResearchNeed[] = [],
    missingDataReport: { dataType: ResearchDataType; reason: string }[] = [],
    notes: string[] = [
      `evidence sources inspected: ${provenance.join(', ') || 'none'}`,
    ];
  for (const gap of gaps) {
    const covered = coveringEvidence(
      items,
      gap.dataType,
      gap.desiredFreshnessMs,
      input.now,
    );
    if (covered) {
      notes.push(
        `${gap.dataType} is already covered by fresh ${covered.classification} evidence (${covered.source})`,
      );
      continue;
    }
    const providers = input.registry
      .all()
      .filter(
        (offer) =>
          offer.supportedDataTypes.includes(gap.dataType) &&
          offer.supportedAssets.includes(input.source.asset),
      );
    if (!providers.length) {
      missingDataReport.push({
        dataType: gap.dataType,
        reason: `no registered provider supplies ${gap.dataType} for ${input.source.asset}`,
      });
      continue;
    }
    if (
      input.ledger &&
      (await input.ledger.hasDeliveredEquivalent(
        input.researchRunId,
        providers[0]!.providerId,
        providers[0]!.serviceId,
        gap.dataType,
      ))
    ) {
      notes.push(
        `${gap.dataType} was already purchased in this run; not buying again`,
      );
      continue;
    }
    needs.push(
      researchNeedSchema.parse({
        researchRunId: input.researchRunId,
        asset: input.source.asset,
        market: input.source.market,
        requiredDataType: gap.dataType,
        reason: gap.reason,
        existingEvidence: items.filter(
          (item) => item.dataType === gap.dataType,
        ),
        desiredFreshnessMs: gap.desiredFreshnessMs,
        expectedResearchBenefit: gap.expectedResearchBenefit,
        maximumAcceptableCostUsdc: gap.maxCostUsdc,
        priority: gap.priority,
      }),
    );
  }
  if (needs.length)
    return needDecisionSchema.parse({
      status: 'NEEDS_IDENTIFIED',
      needs,
      missingDataReport,
      notes,
    });
  return needDecisionSchema.parse({
    status: missingDataReport.length ? 'NO_PROVIDER' : 'NO_PURCHASE_NEEDED',
    needs: [],
    missingDataReport,
    notes,
  });
}
