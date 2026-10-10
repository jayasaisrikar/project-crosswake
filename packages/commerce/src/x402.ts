import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { formatUsdc } from './money.js';
import type { ProviderAdapter, ProviderResponse } from './adapters/index.js';
import type { CommerceLedger } from './ledger.js';
import { authorizeWithLedger } from './policy.js';
import type { WalletAdapter } from './wallet.js';
import {
  paymentRequirementSchema,
  purchaseIntentSchema,
  settlementEvidenceSchema,
  type CommerceMode,
  type PaymentRequirement,
  type ProviderOffer,
  type PurchaseIntent,
  type Quote,
  type SettlementEvidence,
  type SpendPolicy,
} from './types.js';

const nodeHeaders = (response: ProviderResponse) => response.headers;

const decode = (value: string | undefined): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
  } catch {
    return null;
  }
};

const challengeShapes = z.object({
  accepts: z
    .array(
      z
        .object({
          scheme: z.string(),
          network: z.string(),
          asset: z.string(),
          amount: z.string().optional(),
          maxAmountRequired: z.string().optional(),
          payTo: z.string(),
          maxTimeoutSeconds: z.number().optional(),
          resource: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
          extra: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough(),
    )
    .min(1),
  resource: z
    .union([z.string(), z.object({ url: z.string() }).passthrough()])
    .optional(),
});

/**
 * Normalises an x402 challenge. Both protocol generations are real wire
 * formats: v2 carries base64 JSON in the `PAYMENT-REQUIRED` header, v1 carries
 * plain JSON in the 402 body. A seller is free to use either.
 */
export function parseChallenge(
  response: ProviderResponse,
  offer: ProviderOffer,
): PaymentRequirement {
  const headerValue = nodeHeaders(response)['payment-required'],
    fromHeader = decode(headerValue),
    payload =
      fromHeader ??
      (response.body ? (JSON.parse(response.body) as unknown) : null);
  if (!payload || typeof payload !== 'object')
    throw new Error('402 response carried no payment requirements');
  const shape = challengeShapes.safeParse(payload);
  if (!shape.success)
    throw new Error('402 payment requirements do not match the x402 schema');
  const versionRaw = (payload as { x402Version?: unknown }).x402Version,
    x402Version = versionRaw === 1 ? 1 : 2,
    accept = shape.data.accepts[0]!,
    amount = accept.amount ?? accept.maxAmountRequired;
  if (!amount) throw new Error('402 requirement is missing an amount');
  const resource =
    typeof shape.data.resource === 'string'
      ? shape.data.resource
      : (shape.data.resource?.url ?? accept.resource ?? offer.endpoint);
  return paymentRequirementSchema.parse({
    x402Version,
    scheme: accept.scheme === 'exact' ? 'exact' : accept.scheme,
    network: accept.network,
    amount,
    asset: accept.asset,
    payTo: accept.payTo,
    maxTimeoutSeconds:
      accept.maxTimeoutSeconds ?? Math.ceil(offer.quoteExpirationMs / 1000),
    resource,
    description: accept.description ?? offer.description,
    mimeType: accept.mimeType ?? 'application/json',
    extra: accept.extra,
  });
}

export function buildPaymentHeader(
  requirement: PaymentRequirement,
  signed: { signature: string; authorization: Record<string, unknown> },
): { headerName: string; headerValue: string } {
  const payload = {
    x402Version: requirement.x402Version,
    scheme: 'exact',
    network: requirement.network,
    accepted: {
      scheme: 'exact',
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      amount: requirement.amount,
      maxTimeoutSeconds: requirement.maxTimeoutSeconds,
      extra: requirement.extra,
    },
    payload: {
      signature: signed.signature,
      authorization: signed.authorization,
    },
  };
  return {
    headerName:
      requirement.x402Version === 2 ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT',
    headerValue: Buffer.from(JSON.stringify(payload)).toString('base64'),
  };
}

export function readSettlement(
  response: ProviderResponse,
): SettlementEvidence | null {
  const headers = nodeHeaders(response),
    raw = headers['payment-response'] ?? headers['x-payment-response'],
    decoded = decode(raw),
    parsed = settlementEvidenceSchema.safeParse(decoded);
  if (parsed.success) return parsed.data;
  if (
    decoded &&
    typeof decoded === 'object' &&
    (decoded as { success?: unknown }).success === true
  )
    return settlementEvidenceSchema.parse({
      ...(decoded as Record<string, unknown>),
      source: 'resource-server',
    });
  return null;
}

export interface PurchaseOutcome {
  status:
    | 'refused'
    | 'awaiting_approval'
    | 'settled'
    | 'validation_failed'
    | 'failed'
    | 'settlement_unknown';
  purchaseId: string;
  reasons: string[];
  settlement: SettlementEvidence | null;
}

export interface X402ClientOptions {
  ledger: CommerceLedger;
  policy: SpendPolicy;
  mode: CommerceMode;
  mainnetEnabled: boolean;
  wallet: WalletAdapter;
  adapterFor: (offer: ProviderOffer) => ProviderAdapter;
  /** Returns the recorded human decision for a purchase, if any. */
  approvalFor: (purchaseId: string) => Promise<'approved' | 'declined' | null>;
  /** Deterministic purchased-data validation, injected to keep this module portable. */
  validate: (input: {
    intent: PurchaseIntent;
    body: string;
    contentType: string;
    responseTs: number;
    now: number;
  }) => Promise<{
    state: 'VALIDATED' | 'VALIDATION_FAILED';
    reasons: string[];
    digest: string;
    normalized: unknown;
  } | null>;
  clock?: () => number;
  onEvent?: (event: { kind: string; detail: Record<string, unknown> }) => void;
}

/**
 * The x402 purchase state machine.
 *
 * Payment execution lives here and only here. It is not exposed to the agent as
 * a tool: a model can request a purchase, and a human can approve one, but the
 * signing step happens in this deterministic path after re-authorisation.
 */
export class X402PurchaseClient {
  constructor(private readonly options: X402ClientOptions) {}

  private now() {
    return (this.options.clock ?? Date.now)();
  }

  private emit(kind: string, detail: Record<string, unknown>) {
    this.options.onEvent?.({ kind, detail });
  }

  /** Step 1-2: request the protected resource and normalise the 402 challenge. */
  async quote(offer: ProviderOffer): Promise<Quote> {
    const response = await this.options.adapterFor(offer).request({ offer });
    if (response.status !== 402)
      throw new Error(
        `Expected an x402 challenge (HTTP 402) from ${offer.providerId}, got ${response.status}`,
      );
    const requirement = parseChallenge(response, offer),
      now = this.now();
    return {
      quoteId: `quo_${createHash('sha256')
        .update(
          `${offer.providerId}/${offer.serviceId}/${requirement.amount}/${now}`,
        )
        .digest('hex')
        .slice(0, 16)}`,
      providerId: offer.providerId,
      serviceId: offer.serviceId,
      requirement,
      issuedAt: now,
      expiresAt: now + offer.quoteExpirationMs,
    };
  }

  /** Steps 3-12: authorise, approve, sign, retry, settle, deliver, validate. */
  async execute(intentInput: PurchaseIntent): Promise<PurchaseOutcome> {
    const intent = purchaseIntentSchema.parse(intentInput),
      { ledger } = this.options,
      now = this.now(),
      // Carried on every event so a purchase record is complete even when the
      // executor is the first thing to write about it.
      identity = {
        providerId: intent.offer.providerId,
        serviceId: intent.offer.serviceId,
        dataType: intent.need.requiredDataType,
        idempotencyKey: intent.idempotencyKey,
      },
      persisted = await ledger.intent(intent.purchaseId);
    if (
      !persisted ||
      (persisted as { idempotencyKey?: string }).idempotencyKey !==
        intent.idempotencyKey
    ) {
      await this.record(intent, 'FAILED', {
        failureReason:
          'purchase intent is not the persisted intent for this id',
      });
      return {
        status: 'failed',
        purchaseId: intent.purchaseId,
        reasons: ['intent mismatch'],
        settlement: null,
      };
    }
    let decision;
    try {
      decision = await authorizeWithLedger(ledger, {
        intent,
        policy: this.options.policy,
        runtime: {
          mode: this.options.mode,
          mainnetEnabled: this.options.mainnetEnabled,
          emergencyDisabled: (await ledger.control()).disabled,
          now,
          walletBalanceUsdc: await this.options.wallet.balanceUsdc(),
          walletNetwork: this.options.wallet.network,
          walletAddress: this.options.wallet.address,
        },
      });
    } catch (error) {
      // A wallet or ledger that cannot be read is a refusal, never a payment.
      await this.record(intent, 'FAILED', {
        failureReason: `authorisation unavailable: ${String(error)}`,
      });
      return {
        status: 'failed',
        purchaseId: intent.purchaseId,
        reasons: [String(error)],
        settlement: null,
      };
    }
    if (!decision.authorized) {
      await this.record(intent, 'FAILED', {
        failureReason: decision.reasons.join('; '),
        authorization: decision,
      });
      return {
        status: 'refused',
        purchaseId: intent.purchaseId,
        reasons: decision.reasons,
        settlement: null,
      };
    }
    const approval = await this.options.approvalFor(intent.purchaseId);
    if (approval === 'declined') {
      await this.record(intent, 'DECLINED', {
        failureReason: 'human declined the purchase',
      });
      return {
        status: 'failed',
        purchaseId: intent.purchaseId,
        reasons: ['declined'],
        settlement: null,
      };
    }
    if (approval !== 'approved') {
      await this.record(intent, 'AWAITING_APPROVAL', {
        failureReason: null,
        note: 'awaiting a recorded human approval before signing',
      });
      return {
        status: 'awaiting_approval',
        purchaseId: intent.purchaseId,
        reasons: ['human approval required'],
        settlement: null,
      };
    }

    // Reserve budget, then re-authorise before signing. The executor never
    // inherits the earlier decision: a concurrent purchase changes the answer.
    await ledger.append({
      at: now,
      kind: 'reservation',
      purchaseId: intent.purchaseId,
      researchRunId: intent.researchRunId,
      mode: intent.mode,
      paymentState: 'AUTHORIZED',
      deliveryState: 'PENDING',
      validationState: 'PENDING',
      amountUsdc: formatUsdc(BigInt(intent.quote.requirement.amount)),
      detail: { action: 'reserve', authorization: decision, ...identity },
    });
    const recheck = await authorizeWithLedger(ledger, {
      intent,
      policy: this.options.policy,
      runtime: {
        mode: this.options.mode,
        mainnetEnabled: this.options.mainnetEnabled,
        emergencyDisabled: (await ledger.control()).disabled,
        now: this.now(),
        walletBalanceUsdc: await this.options.wallet.balanceUsdc(),
        walletNetwork: this.options.wallet.network,
        walletAddress: this.options.wallet.address,
      },
    });
    if (!recheck.authorized) {
      await ledger.append({
        at: this.now(),
        kind: 'reservation',
        purchaseId: intent.purchaseId,
        researchRunId: intent.researchRunId,
        mode: intent.mode,
        paymentState: 'FAILED',
        deliveryState: 'PENDING',
        validationState: 'PENDING',
        amountUsdc: formatUsdc(BigInt(intent.quote.requirement.amount)),
        detail: {
          action: 'release',
          reason: 're-authorisation failed under contention',
          ...identity,
        },
      });
      await this.record(intent, 'FAILED', {
        failureReason: recheck.reasons.join('; '),
        authorization: recheck,
      });
      return {
        status: 'refused',
        purchaseId: intent.purchaseId,
        reasons: recheck.reasons,
        settlement: null,
      };
    }

    const requirement = intent.quote.requirement,
      expiresAt = Math.min(
        intent.quote.expiresAt,
        this.now() + requirement.maxTimeoutSeconds * 1000,
      );
    let signed;
    try {
      signed = await this.options.wallet.signAuthorization({
        requirement,
        validAfter: Math.max(0, Math.floor((this.now() - 600_000) / 1000)),
        validBefore: Math.floor(expiresAt / 1000),
        nonce: `0x${createHash('sha256').update(intent.purchaseId).digest('hex')}`,
      });
    } catch (error) {
      await this.release(intent, `signing failed: ${String(error)}`);
      return {
        status: 'failed',
        purchaseId: intent.purchaseId,
        reasons: [String(error)],
        settlement: null,
      };
    }
    const proof = buildPaymentHeader(requirement, signed);
    await ledger.append({
      at: this.now(),
      kind: 'payment',
      purchaseId: intent.purchaseId,
      researchRunId: intent.researchRunId,
      mode: intent.mode,
      paymentState: 'PAYMENT_PENDING',
      deliveryState: 'PENDING',
      validationState: 'PENDING',
      amountUsdc: formatUsdc(BigInt(requirement.amount)),
      detail: {
        action: 'submit',
        ...identity,
        payer: signed.authorization.from,
        payTo: requirement.payTo,
        network: requirement.network,
        nonce: signed.authorization.nonce,
      },
    });
    let response: ProviderResponse;
    try {
      response = await this.options.adapterFor(intent.offer).request({
        offer: intent.offer,
        payment: proof,
      });
    } catch (error) {
      // The paid request may have reached a facilitator: never retry blindly.
      await this.record(intent, 'SETTLEMENT_UNKNOWN', {
        settlementUnknownReason: `transport failure after payment submission: ${String(error)}`,
      });
      return {
        status: 'settlement_unknown',
        purchaseId: intent.purchaseId,
        reasons: [String(error)],
        settlement: null,
      };
    }
    const settlement = readSettlement(response);
    if (response.status !== 200 || !settlement) {
      await this.release(
        intent,
        `seller did not accept the payment (HTTP ${response.status})`,
      );
      return {
        status: 'failed',
        purchaseId: intent.purchaseId,
        reasons: [`HTTP ${response.status}`, 'no settlement evidence returned'],
        settlement: null,
      };
    }
    await ledger.append({
      at: this.now(),
      kind: 'reservation',
      purchaseId: intent.purchaseId,
      researchRunId: intent.researchRunId,
      mode: intent.mode,
      paymentState: 'SETTLED',
      deliveryState: 'DELIVERED',
      validationState: 'PENDING',
      amountUsdc: formatUsdc(BigInt(requirement.amount)),
      detail: { action: 'consume', settlement, ...identity },
    });
    const validation = await this.options.validate({
      intent,
      body: response.body,
      contentType: response.contentType,
      responseTs: this.now(),
      now: this.now(),
    });
    const settled: SettlementEvidence = settlement;
    await ledger.writePurchase({
      purchaseId: intent.purchaseId,
      researchRunId: intent.researchRunId,
      idempotencyKey: intent.idempotencyKey,
      mode: intent.mode,
      providerId: intent.offer.providerId,
      serviceId: intent.offer.serviceId,
      dataType: intent.need.requiredDataType,
      amountUsdc: formatUsdc(BigInt(requirement.amount)),
      paymentState: 'SETTLED',
      deliveryState: 'DELIVERED',
      validationState: validation?.state ?? 'VALIDATION_FAILED',
      settlement: settled,
      settlementUnknownReason: null,
      failureReason: null,
      createdAt: intent.requestedAt,
      updatedAt: this.now(),
    });
    await this.record(intent, 'SETTLED', {
      settlement,
      deliveryState: 'DELIVERED',
      validationState: validation?.state ?? 'VALIDATION_FAILED',
      validationReasons: validation?.reasons ?? [
        'no validator produced a result',
      ],
    });
    this.emit('settled', { purchaseId: intent.purchaseId, settlement });
    return {
      status:
        validation?.state === 'VALIDATED' ? 'settled' : 'validation_failed',
      purchaseId: intent.purchaseId,
      reasons: validation?.reasons ?? [],
      settlement,
    };
  }

  private async release(intent: PurchaseIntent, reason: string) {
    await this.options.ledger.append({
      at: this.now(),
      kind: 'reservation',
      purchaseId: intent.purchaseId,
      researchRunId: intent.researchRunId,
      mode: intent.mode,
      paymentState: 'FAILED',
      deliveryState: 'PENDING',
      validationState: 'PENDING',
      amountUsdc: formatUsdc(BigInt(intent.quote.requirement.amount)),
      detail: { action: 'release', reason },
    });
    await this.record(intent, 'FAILED', { failureReason: reason });
  }

  private async record(
    intent: PurchaseIntent,
    paymentState:
      | 'FAILED'
      | 'DECLINED'
      | 'FAILED'
      | 'AWAITING_APPROVAL'
      | 'SETTLED'
      | 'SETTLEMENT_UNKNOWN'
      | 'EXPIRED'
      | 'QUOTED'
      | 'CREATED'
      | 'AUTHORIZED'
      | 'PAYMENT_PENDING',
    detail: Record<string, unknown> & {
      failureReason?: string | null;
      settlementUnknownReason?: string;
    },
  ) {
    await this.options.ledger.append({
      at: this.now(),
      kind: 'payment',
      purchaseId: intent.purchaseId,
      researchRunId: intent.researchRunId,
      mode: intent.mode,
      paymentState,
      deliveryState:
        typeof detail.deliveryState === 'string'
          ? (detail.deliveryState as
              'PENDING' | 'DELIVERED' | 'DELIVERY_FAILED')
          : 'PENDING',
      validationState:
        typeof detail.validationState === 'string'
          ? (detail.validationState as
              'PENDING' | 'VALIDATED' | 'VALIDATION_FAILED')
          : 'PENDING',
      amountUsdc: formatUsdc(BigInt(intent.quote.requirement.amount)),
      detail: {
        providerId: intent.offer.providerId,
        serviceId: intent.offer.serviceId,
        dataType: intent.need.requiredDataType,
        idempotencyKey: intent.idempotencyKey,
        ...detail,
        failureReason: detail.failureReason ?? null,
      },
    });
  }

  /**
   * Reconciliation for an uncertain settlement. It never re-sends a payment:
   * it asks the seller's own access-control result, which is the only cheap,
   * non-duplicating signal available without a facilitator receipt.
   */
  async reconcile(
    purchaseId: string,
  ): Promise<'settled' | 'not_settled' | 'still_unknown'> {
    const record = await this.options.ledger.purchase(purchaseId),
      intentRaw = await this.options.ledger.intent(purchaseId);
    if (!record || !intentRaw) return 'still_unknown';
    const intent = purchaseIntentSchema.parse(intentRaw);
    if (record.paymentState !== 'SETTLEMENT_UNKNOWN')
      return record.paymentState === 'SETTLED' ? 'settled' : 'not_settled';
    try {
      const response = await this.options
        .adapterFor(intent.offer)
        .request({ offer: intent.offer });
      if (response.status === 200) {
        await this.options.ledger.append({
          at: this.now(),
          kind: 'payment',
          purchaseId,
          researchRunId: intent.researchRunId,
          mode: intent.mode,
          paymentState: 'SETTLED',
          deliveryState: 'DELIVERED',
          validationState: 'PENDING',
          amountUsdc: record.amountUsdc,
          detail: {
            reconciled: true,
            note: 'seller granted access on a reconciliation request',
          },
        });
        return 'settled';
      }
      if (response.status === 402) return 'not_settled';
      return 'still_unknown';
    } catch {
      return 'still_unknown';
    }
  }

  /** Fresh 32-byte nonce helper for callers that generate their own. */
  static nonce() {
    return `0x${randomBytes(32).toString('hex')}`;
  }
}
