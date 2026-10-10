import { z } from 'zod';
import { isValidUsdcText, USDC_DECIMALS } from './money.js';

/** Decimal string, parsed to integer minor units before any arithmetic. */
export const usdcSchema = z.string().refine(isValidUsdcText, {
  message: `USDC amount string with <= ${USDC_DECIMALS} decimals`,
});

export const commerceModeSchema = z.enum(['mock', 'testnet', 'mainnet']);
export type CommerceMode = z.infer<typeof commerceModeSchema>;

export const dataTypeSchema = z.enum([
  'market_price_history',
  'market_volume_history',
  'btc_correlation_metrics',
  'order_book_depth',
  'market_impact_liquidity',
  'holder_concentration',
  'token_flow_metrics',
  'onchain_liquidity',
  'sentiment_indicators',
  'derivatives_funding',
]);
export type ResearchDataType = z.infer<typeof dataTypeSchema>;

export const marketSchema = z.enum(['spot', 'usdm']);
export const symbolSchema = z.string().regex(/^[A-Z0-9]{2,20}$/);

/** How a piece of evidence came to exist. Never conflated in reporting. */
export const evidenceClassSchema = z.enum([
  'measured',
  'purchased',
  'interpretation',
  'backtest',
  'assumption',
]);
export type EvidenceClass = z.infer<typeof evidenceClassSchema>;

export const evidenceRefSchema = z
  .object({
    id: z.string().min(1).max(200),
    dataType: dataTypeSchema,
    classification: evidenceClassSchema,
    /** Where it came from: a local dataset path, a provider id, a model id. */
    source: z.string().min(1).max(400),
    asOf: z.number().int().nonnegative(),
    freshnessMs: z.number().int().nonnegative(),
    digest: z.string().min(8).max(128),
    summary: z.string().max(2000),
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const prioritySchema = z.enum(['low', 'medium', 'high']);

export const researchNeedSchema = z
  .object({
    researchRunId: z.string().min(1).max(120),
    asset: symbolSchema,
    market: marketSchema,
    requiredDataType: dataTypeSchema,
    reason: z.string().min(1).max(2000),
    existingEvidence: z.array(evidenceRefSchema).max(50),
    desiredFreshnessMs: z.number().int().positive(),
    expectedResearchBenefit: z.string().min(1).max(2000),
    maximumAcceptableCostUsdc: usdcSchema,
    priority: prioritySchema,
  })
  .strict();
export type ResearchNeed = z.infer<typeof researchNeedSchema>;

export const verificationStatusSchema = z.enum([
  'verified',
  'mock',
  'unverified',
]);

export const providerOfferSchema = z
  .object({
    providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    serviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(1000),
    endpoint: z.string().url(),
    supportedAssets: z.array(symbolSchema).min(1),
    supportedDataTypes: z.array(dataTypeSchema).min(1),
    supportedNetworks: z.array(z.string().regex(/^eip155:\d+$/)).min(1),
    acceptedPaymentAsset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    acceptedPaymentAssetSymbol: z.literal('USDC'),
    /** Registry metadata only. A live purchase always uses the 402 challenge price. */
    quotedPrice: usdcSchema,
    quoteExpirationMs: z.number().int().positive().max(3_600_000),
    dataFreshness: z.string().min(1).max(40),
    responseSchema: z.string().min(1).max(80),
    providerIdentity: z.string().min(1).max(200),
    verificationStatus: verificationStatusSchema,
    /** Documented reliability in [0,1]; not proof of accuracy. */
    reliability: z.number().min(0).max(1),
    historicalValidationPass: z.number().min(0).max(1),
    payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  })
  .strict();
export type ProviderOffer = z.infer<typeof providerOfferSchema>;

export const providerRegistrySchema = z
  .object({
    version: z.string().min(1).max(80),
    comment: z.string().max(2000).optional(),
    providers: z.array(providerOfferSchema).min(1),
  })
  .strict();
export type ProviderRegistry = z.infer<typeof providerRegistrySchema>;

export const spendPolicySchema = z
  .object({
    version: z.string().min(1).max(80),
    maxPerPaymentUsdc: usdcSchema,
    maxPerResearchRunUsdc: usdcSchema,
    maxDailyUsdc: usdcSchema,
    /** Emergency stop switch; `commerce:disable` writes a runtime flag that also blocks. */
    emergencyDisabled: z.boolean(),
    approvedSchemes: z.array(z.literal('exact')).min(1),
    allowProviders: z.array(z.string()).min(1),
    allowRecipients: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1),
    networks: z.record(
      commerceModeSchema,
      z.array(z.string().regex(/^eip155:\d+$/)),
    ),
    assets: z.record(z.string(), z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type SpendPolicy = z.infer<typeof spendPolicySchema>;

/** A normalised x402 payment requirement (v1 and v2 both flatten to this). */
export const paymentRequirementSchema = z
  .object({
    x402Version: z.union([z.literal(1), z.literal(2)]),
    scheme: z.literal('exact'),
    network: z.string().min(1).max(80),
    /** Atomic USDC minor units, exactly as the x402 wire format defines it. */
    amount: z.string().regex(/^(?:0|[1-9]\d*)$/, {
      message: 'atomic USDC minor units (integer string)',
    }),
    asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    maxTimeoutSeconds: z.number().int().positive().max(86_400),
    resource: z.string().min(1).max(500),
    description: z.string().max(500),
    mimeType: z.string().max(120),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type PaymentRequirement = z.infer<typeof paymentRequirementSchema>;

export const quoteSchema = z
  .object({
    quoteId: z.string().min(1).max(120),
    providerId: z.string(),
    serviceId: z.string(),
    requirement: paymentRequirementSchema,
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type Quote = z.infer<typeof quoteSchema>;

export const paymentStateSchema = z.enum([
  'CREATED',
  'QUOTED',
  'AWAITING_APPROVAL',
  'AUTHORIZED',
  'PAYMENT_PENDING',
  'SETTLED',
  'SETTLEMENT_UNKNOWN',
  'FAILED',
  'DECLINED',
  'EXPIRED',
]);
export type PaymentState = z.infer<typeof paymentStateSchema>;

export const deliveryStateSchema = z.enum([
  'PENDING',
  'DELIVERED',
  'DELIVERY_FAILED',
]);
export const validationStateSchema = z.enum([
  'PENDING',
  'VALIDATED',
  'VALIDATION_FAILED',
]);

export const purchaseIntentSchema = z
  .object({
    purchaseId: z.string().regex(/^pur_[a-f0-9]{16}$/),
    /** Unique; a second purchase with the same key is refused, never charged twice. */
    idempotencyKey: z.string().min(8).max(200),
    researchRunId: z.string().min(1).max(120),
    mode: commerceModeSchema,
    need: researchNeedSchema,
    offer: providerOfferSchema,
    quote: quoteSchema,
    requestedBy: z.string().min(1).max(120),
    requestedAt: z.number().int().positive(),
  })
  .strict();
export type PurchaseIntent = z.infer<typeof purchaseIntentSchema>;

export const checkResultSchema = z
  .object({
    check: z.string().min(1).max(80),
    passed: z.boolean(),
    detail: z.string().max(400),
  })
  .strict();
export type CheckResult = z.infer<typeof checkResultSchema>;

export const authorizationDecisionSchema = z
  .object({
    authorized: z.boolean(),
    /** True when a human must approve before the executor may sign. */
    requiredHumanApproval: z.boolean(),
    reasons: z.array(z.string().max(400)),
    checks: z.array(checkResultSchema),
    amountUsdc: usdcSchema,
  })
  .strict();
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;

export const settlementEvidenceSchema = z
  .object({
    success: z.literal(true),
    transaction: z.string().min(1).max(200),
    network: z.string().min(1).max(80),
    payer: z.string().min(1).max(120),
    /** Where the evidence came from. Mock evidence is never on-chain evidence. */
    source: z.enum(['mock', 'facilitator', 'resource-server']),
  })
  .strict();
export type SettlementEvidence = z.infer<typeof settlementEvidenceSchema>;

export const purchaseRecordSchema = z
  .object({
    purchaseId: z.string(),
    researchRunId: z.string(),
    idempotencyKey: z.string(),
    mode: commerceModeSchema,
    providerId: z.string(),
    serviceId: z.string(),
    dataType: dataTypeSchema,
    amountUsdc: usdcSchema,
    paymentState: paymentStateSchema,
    deliveryState: deliveryStateSchema,
    validationState: validationStateSchema,
    settlement: settlementEvidenceSchema.nullable(),
    settlementUnknownReason: z.string().max(400).nullable(),
    failureReason: z.string().max(400).nullable(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict();
export type PurchaseRecord = z.infer<typeof purchaseRecordSchema>;

export const purchasedDataRecordSchema = z
  .object({
    purchaseId: z.string(),
    researchRunId: z.string(),
    providerId: z.string(),
    serviceId: z.string(),
    dataType: dataTypeSchema,
    asset: symbolSchema,
    market: marketSchema,
    endpoint: z.string(),
    quoteAmountUsdc: usdcSchema,
    paymentReference: z.string().min(1).max(200),
    responseTs: z.number().int().positive(),
    contentDigest: z.string().length(64),
    normalized: z.unknown(),
    validationState: validationStateSchema,
    validationReasons: z.array(z.string().max(400)),
    attestation: z.string().max(400),
  })
  .strict();
export type PurchasedDataRecord = z.infer<typeof purchasedDataRecordSchema>;
