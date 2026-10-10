import { z } from 'zod';
import {
  compareUsdc,
  parseUsdc,
  formatUsdc,
  type UsdcAmount,
} from './money.js';
import {
  usdcSchema,
  type ProviderOffer,
  type ResearchNeed,
  type SpendPolicy,
} from './types.js';

export const rejectedAlternativeSchema = z
  .object({
    providerId: z.string(),
    serviceId: z.string(),
    reason: z.string().max(400),
  })
  .strict();

export const purchaseRecommendationSchema = z
  .object({
    recommendPurchase: z.boolean(),
    selected: z
      .object({ providerId: z.string(), serviceId: z.string() })
      .strict()
      .nullable(),
    requiredData: z.string(),
    quotedAmountUsdc: usdcSchema,
    expectedContribution: z.string().max(600),
    supportingEvidence: z.array(z.string().max(400)),
    reasonForSelection: z.string().max(600),
    rejectedAlternatives: z.array(rejectedAlternativeSchema),
    humanApprovalRequired: z.boolean(),
    stageAFailures: z.array(rejectedAlternativeSchema),
  })
  .strict();
export type PurchaseRecommendation = z.infer<
  typeof purchaseRecommendationSchema
>;

export interface EvaluationInput {
  need: ResearchNeed;
  candidates: ProviderOffer[];
  policy: SpendPolicy;
  mode: 'mock' | 'testnet' | 'mainnet';
  now: number;
}

interface Scored {
  offer: ProviderOffer;
  amount: UsdcAmount;
  score: number;
  factors: string[];
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Stage A: deterministic elimination. No LLM, no preference, no exceptions. */
export function stageA(input: EvaluationInput): {
  eligible: ProviderOffer[];
  failures: { providerId: string; serviceId: string; reason: string }[];
} {
  const approvedNetworks = input.policy.networks[input.mode] ?? [],
    failures: { providerId: string; serviceId: string; reason: string }[] = [],
    eligible: ProviderOffer[] = [];
  for (const offer of input.candidates) {
    const fail = (reason: string) =>
      failures.push({
        providerId: offer.providerId,
        serviceId: offer.serviceId,
        reason,
      });
    if (offer.verificationStatus === 'unverified') {
      fail('provider is not verified');
      continue;
    }
    if (!input.policy.allowProviders.includes(offer.providerId)) {
      fail('provider is not allowlisted');
      continue;
    }
    if (!input.policy.allowRecipients.includes(offer.payTo)) {
      fail('payment recipient is not allowlisted');
      continue;
    }
    const network = offer.supportedNetworks[0] ?? '';
    if (!approvedNetworks.includes(network)) {
      fail(`network ${network} is not approved for ${input.mode} mode`);
      continue;
    }
    if (input.policy.assets[network] !== offer.acceptedPaymentAsset) {
      fail('payment asset does not match the approved asset for that network');
      continue;
    }
    if (!input.policy.approvedSchemes.includes('exact')) {
      fail('payment scheme is not approved');
      continue;
    }
    const price = parseUsdc(offer.quotedPrice);
    if (
      compareUsdc(price, parseUsdc(input.need.maximumAcceptableCostUsdc)) > 0
    ) {
      fail(
        `price ${offer.quotedPrice} USDC exceeds the need's maximum ${input.need.maximumAcceptableCostUsdc} USDC`,
      );
      continue;
    }
    if (compareUsdc(price, parseUsdc(input.policy.maxPerPaymentUsdc)) > 0) {
      fail(
        `price exceeds the per-payment cap ${input.policy.maxPerPaymentUsdc} USDC`,
      );
      continue;
    }
    eligible.push(offer);
  }
  return { eligible, failures };
}

/** Stage B: documented, deterministic scoring. Price is one factor, never the only one. */
export function scoreOffer(offer: ProviderOffer, need: ResearchNeed): Scored {
  const price = parseUsdc(offer.quotedPrice),
    maxCost = parseUsdc(need.maximumAcceptableCostUsdc),
    costFactor = maxCost === 0n ? 1 : Number(maxCost - price) / Number(maxCost),
    freshnessFactor = offer.dataFreshness === 'live' ? 1 : 0.7,
    coverageFactor = offer.supportedAssets.includes(need.asset) ? 1 : 0,
    relevance = offer.supportedDataTypes[0] === need.requiredDataType ? 1 : 0.6,
    factors = [
      `relevance ${relevance.toFixed(2)}`,
      `reliability ${offer.reliability.toFixed(2)}`,
      `historical validation ${offer.historicalValidationPass.toFixed(2)}`,
      `coverage ${coverageFactor.toFixed(2)}`,
      `freshness ${freshnessFactor.toFixed(2)}`,
      `cost ${formatUsdc(price)} of ${need.maximumAcceptableCostUsdc} USDC`,
    ];
  const score =
    0.25 * relevance +
    0.2 * clamp01(offer.reliability) +
    0.15 * clamp01(offer.historicalValidationPass) +
    0.1 * coverageFactor +
    0.1 * freshnessFactor +
    0.2 * clamp01(costFactor);
  return { offer, amount: price, score: Number(score.toFixed(6)), factors };
}

export function evaluateOffers(input: EvaluationInput): PurchaseRecommendation {
  if (!input.candidates.length)
    return purchaseRecommendationSchema.parse({
      recommendPurchase: false,
      selected: null,
      requiredData: input.need.requiredDataType,
      quotedAmountUsdc: '0',
      expectedContribution: 'none',
      supportingEvidence: [],
      reasonForSelection:
        'No registered provider offers this data type for this asset.',
      rejectedAlternatives: [],
      humanApprovalRequired: true,
      stageAFailures: [],
    });
  const { eligible, failures } = stageA(input);
  if (!eligible.length)
    return purchaseRecommendationSchema.parse({
      recommendPurchase: false,
      selected: null,
      requiredData: input.need.requiredDataType,
      quotedAmountUsdc: '0',
      expectedContribution: 'none',
      supportingEvidence: [],
      reasonForSelection:
        'Every candidate failed the deterministic pre-checks; no purchase is recommended.',
      rejectedAlternatives: [],
      humanApprovalRequired: true,
      stageAFailures: failures,
    });
  const scored = eligible
      .map((offer) => scoreOffer(offer, input.need))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.offer.providerId.localeCompare(b.offer.providerId),
      ),
    best = scored[0]!,
    rejected = scored.slice(1).map((s) => ({
      providerId: s.offer.providerId,
      serviceId: s.offer.serviceId,
      reason: `lower score ${s.score.toFixed(3)}: ${s.factors.join(', ')}`,
    }));
  const affordable =
    compareUsdc(best.amount, parseUsdc(input.need.maximumAcceptableCostUsdc)) <=
    0;
  return purchaseRecommendationSchema.parse({
    recommendPurchase: affordable,
    selected: {
      providerId: best.offer.providerId,
      serviceId: best.offer.serviceId,
    },
    requiredData: input.need.requiredDataType,
    quotedAmountUsdc: formatUsdc(best.amount),
    expectedContribution: `Independent ${input.need.requiredDataType} for ${input.need.asset} would replace the unsourced assumption identified by the need detector; it is attached as external evidence and does not by itself change signal confidence.`,
    supportingEvidence: best.factors,
    reasonForSelection: `Highest deterministic score (${best.score.toFixed(3)}) among ${eligible.length} eligible offer(s) for ${input.need.requiredDataType} on ${input.need.asset}.`,
    rejectedAlternatives: rejected,
    humanApprovalRequired: true,
    stageAFailures: failures,
  });
}
