import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createHttpX402Adapter } from './adapters/http.js';
import { createMockSeller, type MockVariant } from './adapters/mock.js';
import type { ProviderAdapter } from './adapters/index.js';
import {
  commerceEnv,
  loadPolicy,
  loadRegistry,
  type CommerceEnv,
} from './config.js';
import { discoverProviders } from './discovery.js';
import { evaluateOffers, type PurchaseRecommendation } from './evaluation.js';
import { integrateEvidence, type ResearchEvidenceSet } from './evidence.js';
import { CommerceLedger, type BudgetSnapshot } from './ledger.js';
import {
  detectResearchNeeds,
  type NeedDecision,
  type ResearchEvidenceSource,
} from './need.js';
import { runCostReport, type RunCostReport } from './observability.js';
import { formatUsdc } from './money.js';
import { authorizeWithLedger } from './policy.js';
import { ProviderRegistryIndex } from './registry.js';
import {
  purchaseIntentSchema,
  type AuthorizationDecision,
  type CommerceMode,
  type ProviderOffer,
  type PurchaseIntent,
  type PurchaseRecord,
  type PurchasedDataRecord,
  type ResearchNeed,
  type SpendPolicy,
} from './types.js';
import { validatePurchasedData } from './validation.js';
import {
  createMockWallet,
  createViemWallet,
  mainnetPrivateKey,
  testnetPrivateKey,
  type WalletAdapter,
} from './wallet.js';
import { X402PurchaseClient, type PurchaseOutcome } from './x402.js';

export interface MockSellerConfig {
  variant?: MockVariant;
  x402Version?: 1 | 2;
  dataAgeMs?: number;
}

export interface CommerceServicesOptions {
  /** Where the append-only commerce ledger and purchased records live. */
  dataDir: string;
  source: ResearchEvidenceSource;
  policyPath?: string;
  registryPath?: string;
  mode?: CommerceMode;
  mainnetEnabled?: boolean;
  clock?: () => number;
  wallet?: WalletAdapter;
  /** Per `${providerId}/${serviceId}` mock seller behaviour (mock mode only). */
  mockSellers?: Record<string, MockSellerConfig>;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommerceServices {
  env: CommerceEnv;
  policy: SpendPolicy;
  registry: ProviderRegistryIndex;
  ledger: CommerceLedger;
  wallet: WalletAdapter;
  client: X402PurchaseClient;
  source: ResearchEvidenceSource;
  now(): number;
  adapterFor(offer: ProviderOffer): ProviderAdapter;
  budget(): Promise<BudgetSnapshot>;
  purchases(): Promise<PurchaseRecord[]>;
  approve(purchaseId: string, actor: string): Promise<void>;
  decline(purchaseId: string, actor: string): Promise<void>;
  authorityFor(purchaseId: string): Promise<'approved' | 'declined' | null>;
  identifyNeeds(researchRunId: string): Promise<NeedDecision>;
  recommend(need: ResearchNeed): Promise<PurchaseRecommendation>;
  quote(offer: ProviderOffer, need: ResearchNeed): Promise<PurchaseIntent>;
  requestAuthorization(purchaseId: string): Promise<AuthorizationDecision>;
  execute(purchaseId: string): Promise<PurchaseOutcome>;
  purchased(purchaseId: string): Promise<PurchasedDataRecord | null>;
  integrate(
    researchRunId: string,
    asset: string,
    market: 'spot' | 'usdm',
  ): Promise<ResearchEvidenceSet>;
  costReport(
    researchRunId: string,
    counters?: Record<string, number>,
    metrics?: {
      providerResponseMs?: Record<string, number>;
      dataFreshnessMs?: Record<string, number>;
    },
  ): Promise<RunCostReport>;
  setDisabled(disabled: boolean, reason: string | null): Promise<void>;
}

async function resolveWallet(
  env: CommerceEnv,
  options: CommerceServicesOptions,
): Promise<WalletAdapter> {
  if (options.wallet) return options.wallet;
  const processEnv = options.env ?? process.env;
  if (env.mode === 'mock') return createMockWallet('crosswake-mock');
  const rpcUrl =
    options.rpcUrl ??
    (env.mode === 'testnet'
      ? 'https://sepolia.base.org'
      : 'https://mainnet.base.org');
  if (env.mode === 'testnet') {
    const key = testnetPrivateKey(processEnv);
    if (!key)
      throw new Error(
        'testnet mode needs COMMERCE_TESTNET_WALLET_PRIVATE_KEY (a dedicated test wallet, never a mainnet key)',
      );
    return createViemWallet({
      privateKey: key,
      network: 'eip155:84532',
      rpcUrl,
    });
  }
  const key = mainnetPrivateKey(processEnv);
  if (!key)
    throw new Error(
      'mainnet mode needs COMMERCE_MAINNET_WALLET_PRIVATE_KEY and an explicit operator decision; it is never enabled automatically',
    );
  return createViemWallet({ privateKey: key, network: 'eip155:8453', rpcUrl });
}

/**
 * Dependency-injected commerce runtime. Every deterministic component lives
 * behind this object; the Mastra agent, the CLI and the HTTP API are thin
 * clients of it, and only `execute` can ever sign a payment.
 */
export async function createCommerceServices(
  options: CommerceServicesOptions,
): Promise<CommerceServices> {
  const base = commerceEnv(options.env ?? process.env),
    env: CommerceEnv = {
      mode: options.mode ?? base.mode,
      mainnetEnabled: options.mainnetEnabled ?? base.mainnetEnabled,
      dataDir: resolve(options.dataDir),
      policyPath: resolve(options.policyPath ?? base.policyPath),
      registryPath: resolve(options.registryPath ?? base.registryPath),
    },
    now = options.clock ?? Date.now;
  if (env.mode === 'mainnet' && !env.mainnetEnabled)
    throw new Error(
      'mainnet commerce mode requires COMMERCE_MAINNET_ENABLED=true',
    );
  const policy = await loadPolicy(env.policyPath),
    registry = ProviderRegistryIndex.from(await loadRegistry(env.registryPath)),
    ledger = new CommerceLedger(resolve(env.dataDir, 'commerce'), now);
  await ledger.init();
  const wallet = await resolveWallet(env, options),
    source = options.source;
  const adapterFor = (offer: ProviderOffer): ProviderAdapter => {
    if (env.mode === 'mock') {
      const config =
        options.mockSellers?.[`${offer.providerId}/${offer.serviceId}`];
      return createMockSeller(offer, {
        variant: config?.variant ?? 'ok',
        x402Version: config?.x402Version ?? 2,
        dataAgeMs: config?.dataAgeMs,
        clock: now,
      });
    }
    const registeredHost = new URL(offer.endpoint).hostname;
    return createHttpX402Adapter({
      allowedHosts: registry
        .all()
        .map((entry) => new URL(entry.endpoint).hostname)
        .filter((host) => host === registeredHost),
      timeoutMs: 20_000,
      maxBytes: 1_000_000,
    });
  };
  const authorityFor = async (purchaseId: string) => {
    const approval = await ledger.approval(purchaseId);
    return approval ? (approval.decision as 'approved' | 'declined') : null;
  };
  const client = new X402PurchaseClient({
    ledger,
    policy,
    mode: env.mode,
    mainnetEnabled: env.mainnetEnabled,
    wallet,
    adapterFor,
    approvalFor: authorityFor,
    clock: now,
    validate: async ({ intent, body, contentType, responseTs, now: at }) => {
      const seen = await ledger
        .purchases()
        .then((rows) =>
          Promise.all(
            rows
              .filter((row) => row.purchaseId !== intent.purchaseId)
              .map((row) =>
                ledger.purchased(row.purchaseId).then((r) => r?.contentDigest),
              ),
          ),
        )
        .then((digests) => digests.filter((d): d is string => Boolean(d)));
      const outcome = validatePurchasedData({
        intent,
        body,
        contentType,
        responseTs,
        now: at,
        seenDigests: seen,
      });
      await ledger.writePurchased({
        purchaseId: intent.purchaseId,
        researchRunId: intent.researchRunId,
        providerId: intent.offer.providerId,
        serviceId: intent.offer.serviceId,
        dataType: intent.need.requiredDataType,
        asset: intent.need.asset,
        market: intent.need.market,
        endpoint: intent.offer.endpoint,
        quoteAmountUsdc: formatUsdc(BigInt(intent.quote.requirement.amount)),
        paymentReference: `x402v${intent.quote.requirement.x402Version}:${intent.quote.quoteId}`,
        responseTs,
        contentDigest: outcome.digest,
        normalized: outcome.normalized,
        validationState: outcome.state,
        validationReasons: outcome.reasons,
        attestation: outcome.attestation,
      });
      return {
        state: outcome.state,
        reasons: outcome.reasons,
        digest: outcome.digest,
        normalized: outcome.normalized,
      };
    },
  });

  const approvalEvent = (
    purchaseId: string,
    decision: 'approved' | 'declined',
    actor: string,
  ) => ({
    at: now(),
    kind: 'approval' as const,
    purchaseId,
    researchRunId: '',
    mode: env.mode,
    paymentState: 'AWAITING_APPROVAL' as const,
    deliveryState: 'PENDING' as const,
    validationState: 'PENDING' as const,
    amountUsdc: '0',
    detail: { decision, actor, at: now() },
  });

  return {
    env,
    policy,
    registry,
    ledger,
    wallet,
    client,
    source,
    now,
    adapterFor,
    budget: () => ledger.budgetSnapshot(now()),
    purchases: () => ledger.purchases(),
    approve: async (purchaseId, actor) => {
      const name = actor.trim();
      if (!name) throw new Error('an approval must name the human who gave it');
      await ledger.append(approvalEvent(purchaseId, 'approved', name));
    },
    decline: async (purchaseId, actor) => {
      await ledger.append(
        approvalEvent(purchaseId, 'declined', actor.trim() || 'unknown'),
      );
    },
    authorityFor,
    identifyNeeds: (researchRunId) =>
      detectResearchNeeds({
        researchRunId,
        source,
        registry,
        policy,
        ledger,
        now: now(),
      }),
    recommend: async (need) =>
      evaluateOffers({
        need,
        candidates: discoverProviders(registry, need).candidates,
        policy,
        mode: env.mode,
        now: now(),
      }),
    quote: async (offer, need) => {
      const quote = await client.quote(offer),
        intent = purchaseIntentSchema.parse({
          purchaseId: `pur_${randomBytes(8).toString('hex')}`,
          idempotencyKey: `${need.researchRunId}:${offer.providerId}:${offer.serviceId}:${need.requiredDataType}`,
          researchRunId: need.researchRunId,
          mode: env.mode,
          need,
          offer,
          quote,
          requestedBy: 'crosswake-research-commerce',
          requestedAt: now(),
        });
      await ledger.writeIntent(intent);
      return intent;
    },
    requestAuthorization: async (purchaseId) => {
      const raw = await ledger.intent(purchaseId);
      if (!raw) throw new Error(`unknown purchase ${purchaseId}`);
      const intent = purchaseIntentSchema.parse(raw),
        decision = await authorizeWithLedger(ledger, {
          intent,
          policy,
          runtime: {
            mode: env.mode,
            mainnetEnabled: env.mainnetEnabled,
            emergencyDisabled: (await ledger.control()).disabled,
            now: now(),
            walletBalanceUsdc: await wallet.balanceUsdc(),
            walletNetwork: wallet.network,
            walletAddress: wallet.address,
          },
        });
      await ledger.append({
        at: now(),
        kind: 'payment',
        purchaseId,
        researchRunId: intent.researchRunId,
        mode: env.mode,
        paymentState: decision.authorized ? 'AWAITING_APPROVAL' : 'FAILED',
        deliveryState: 'PENDING',
        validationState: 'PENDING',
        amountUsdc: formatUsdc(BigInt(intent.quote.requirement.amount)),
        detail: {
          action: 'authorize',
          decision,
          idempotencyKey: intent.idempotencyKey,
          providerId: intent.offer.providerId,
          serviceId: intent.offer.serviceId,
          dataType: intent.need.requiredDataType,
          failureReason: decision.authorized
            ? null
            : decision.reasons.join('; '),
        },
      });
      return decision;
    },
    execute: async (purchaseId) => {
      const raw = await ledger.intent(purchaseId);
      if (!raw) throw new Error(`unknown purchase ${purchaseId}`);
      return client.execute(purchaseIntentSchema.parse(raw));
    },
    purchased: (purchaseId) => ledger.purchased(purchaseId),
    integrate: async (researchRunId, asset, market) => {
      const inventory = await source.inventory(now()),
        related = (await ledger.purchases()).filter(
          (p) => p.researchRunId === researchRunId,
        ),
        records: PurchasedDataRecord[] = [];
      for (const purchase of related) {
        const record = await ledger.purchased(purchase.purchaseId);
        if (record) records.push(record);
      }
      const set = integrateEvidence({
        researchRunId,
        asset,
        market,
        now: now(),
        local: inventory.items,
        purchased: records,
      });
      await ledger.writeEvidence(researchRunId, set);
      return set;
    },
    costReport: async (researchRunId, counters, metrics) =>
      runCostReport({
        researchRunId,
        now: now(),
        purchases: (await ledger.purchases()).filter(
          (p) => p.researchRunId === researchRunId,
        ),
        counters: (counters ?? {}) as Partial<RunCostReport['counts']>,
        providerResponseMs: metrics?.providerResponseMs,
        dataFreshnessMs: metrics?.dataFreshnessMs,
      }),
    setDisabled: (disabled, reason) => ledger.setControl(disabled, reason),
  };
}
