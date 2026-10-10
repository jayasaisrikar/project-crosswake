import { describe, it, expect } from 'vitest';
import { authorizePurchase } from '../packages/commerce/src/policy.js';
import { evaluateOffers, stageA } from '../packages/commerce/src/evaluation.js';
import { discoverProviders } from '../packages/commerce/src/discovery.js';
import {
  purchaseIntentSchema,
  type ProviderOffer,
  type ResearchNeed,
} from '../packages/commerce/src/types.js';
import { usdcSchema } from '../packages/commerce/src/types.js';
import {
  ALL_GAPS,
  commerceFixture,
  evidence,
  fixtureSource,
  MOCK_LIQUIDITY,
} from './fixtures/commerce.js';
import type { CommerceServices } from '../packages/commerce/src/services.js';
import { T0 } from './fixtures/commerce.js';

async function openNeed(
  services: CommerceServices,
  dataType: string,
  researchRunId = 'run_test',
): Promise<ResearchNeed> {
  const decision = await services.identifyNeeds(researchRunId),
    need = decision.needs.find((n) => n.requiredDataType === dataType);
  if (!need)
    throw new Error(
      `expected a need for ${dataType}: ${JSON.stringify(decision)}`,
    );
  return need;
}

function provider(overrides: Partial<ProviderOffer>): ProviderOffer {
  return {
    providerId: 'mock-liquidity-analytics',
    serviceId: 'orderbook-liquidity-v1',
    name: 'Mock Liquidity Analytics',
    description:
      'Order-book depth and market-impact liquidity for a spot asset.',
    endpoint: 'https://mock-liquidity.invalid/v1/liquidity',
    supportedAssets: ['SOLUSDT'],
    supportedDataTypes: ['order_book_depth'],
    supportedNetworks: ['eip155:84532'],
    acceptedPaymentAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    acceptedPaymentAssetSymbol: 'USDC',
    quotedPrice: '0.05',
    quoteExpirationMs: 120000,
    dataFreshness: '5m',
    responseSchema: 'liquidity-v1',
    providerIdentity: 'mock://mock-liquidity-analytics',
    verificationStatus: 'mock',
    reliability: 0.9,
    historicalValidationPass: 0.95,
    payTo: '0x1111111111111111111111111111111111111111',
    ...overrides,
  };
}

const BASE_WALLET_STATE = {
  mode: 'mock' as const,
  mainnetEnabled: false,
  emergencyDisabled: false,
  now: T0,
  walletBalanceUsdc: 5_000_000n,
  walletNetwork: 'eip155:84532',
  walletAddress: '0x4eb66231b2eed2d3412b3913eb6478c2a581e916',
  dayCommittedUsdc: 0n,
  runCommittedUsdc: 0n,
  idempotencyKeySeen: false,
  equivalentAlreadyPurchased: false,
};

describe('research need detection', () => {
  it('1. existing data that is fresh enough produces no purchase', async () => {
    const { services } = await commerceFixture({
      source: fixtureSource({
        items: ALL_GAPS.map((gap) => evidence(gap.dataType)),
      }),
    });
    const decision = await services.identifyNeeds('run_covered');
    expect(decision.status).toBe('NO_PURCHASE_NEEDED');
    expect(decision.needs).toEqual([]);
  });

  it('2. missing important evidence asks for a paid provider, with the local gap explained', async () => {
    const { services } = await commerceFixture();
    const decision = await services.identifyNeeds('run_missing');
    expect(decision.status).toBe('NEEDS_IDENTIFIED');
    const orderBook = decision.needs.find(
      (n) => n.requiredDataType === 'order_book_depth',
    );
    expect(orderBook?.reason).toMatch(/depth/i);
    expect(orderBook?.maximumAcceptableCostUsdc).toBe('0.25');
    expect(orderBook?.existingEvidence).toEqual([]);
  });

  it('3. a missing metric with no reliable provider yields a report and no purchase', async () => {
    const { services } = await commerceFixture({
      source: fixtureSource({
        items: ALL_GAPS.filter((g) => g.dataType !== 'token_flow_metrics').map(
          (gap) => evidence(gap.dataType),
        ),
        gaps: [
          ...ALL_GAPS.filter((g) => g.dataType !== 'token_flow_metrics'),
          { ...ALL_GAPS[3]!, dataType: 'derivatives_funding' },
        ],
      }),
    });
    const decision = await services.identifyNeeds('run_no_provider');
    expect(decision.status).toBe('NO_PROVIDER');
    expect(decision.needs).toEqual([]);
    expect(decision.missingDataReport[0]?.dataType).toBe('derivatives_funding');
    expect(decision.missingDataReport[0]?.reason).toMatch(
      /no registered provider/,
    );
  });

  it('never buys data the pipeline already holds and is still fresh', async () => {
    const { services } = await commerceFixture({
      source: fixtureSource({
        items: [evidence('order_book_depth', { classification: 'purchased' })],
        gaps: [ALL_GAPS[0]!],
      }),
    });
    const decision = await services.identifyNeeds('run_fresh');
    expect(decision.status).toBe('NO_PURCHASE_NEEDED');
  });

  it('treats stale local evidence as a gap', async () => {
    const { services } = await commerceFixture({
      source: fixtureSource({
        items: [
          evidence('order_book_depth', {
            asOf: T0 - 30 * 86_400_000,
            freshnessMs: 3_600_000,
          }),
        ],
        gaps: [ALL_GAPS[0]!],
      }),
    });
    const decision = await services.identifyNeeds('run_stale_local');
    expect(decision.status).toBe('NEEDS_IDENTIFIED');
  });

  it('does not buy equivalent data twice inside one research run', async () => {
    const { services } = await commerceFixture();
    const need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.approve(intent.purchaseId, 'test-operator');
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('settled');
    const second = await services.identifyNeeds('run_test');
    expect(
      second.notes.some((n) => n.includes('already purchased in this run')),
    ).toBe(true);
  });
});

describe('service discovery and provider evaluation', () => {
  it('discovers only registered providers that cover the data type and asset', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      discovery = discoverProviders(services.registry, need);
    expect(discovery.candidates.map((c) => c.providerId)).toContain(
      'mock-liquidity-analytics',
    );
    expect(
      discovery.rejected.some(
        (r) => r.offer.providerId === 'mock-market-intel',
      ),
    ).toBe(true);
  });

  it('4. rejects a provider whose price exceeds the per-payment cap', async () => {
    const { services, policy } = await commerceFixture({
      policy: { maxPerPaymentUsdc: '0.25' },
      providers: [provider({ quotedPrice: '2' })],
      source: fixtureSource({
        gaps: [{ ...ALL_GAPS[0]!, maxCostUsdc: '5' }],
      }),
    });
    const need = await openNeed(services, 'order_book_depth'),
      result = stageA({
        need,
        candidates: services.registry.all(),
        policy: services.policy,
        mode: 'mock',
        now: T0,
      });
    expect(policy.maxPerPaymentUsdc).toBe('0.25');
    expect(result.eligible).toEqual([]);
    expect(result.failures[0]?.reason).toMatch(/per-payment cap/);
    const recommendation = await services.recommend(need);
    expect(recommendation.recommendPurchase).toBe(false);
  });

  it('5. rejects an unauthorized payment recipient', async () => {
    const { services } = await commerceFixture({
      providers: [
        provider({ payTo: '0x9999999999999999999999999999999999999999' }),
      ],
    });
    const need = await openNeed(services, 'order_book_depth'),
      result = stageA({
        need,
        candidates: services.registry.all(),
        policy: services.policy,
        mode: 'mock',
        now: T0,
      });
    expect(result.eligible).toEqual([]);
    expect(
      result.failures.some((f) =>
        /recipient is not allowlisted/.test(f.reason),
      ),
    ).toBe(true);
  });

  it('rejects an unverified provider outright', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      recommendation = await services.recommend(need);
    expect(
      recommendation.stageAFailures.some(
        (f) =>
          f.providerId === 'unverified-example-seller' &&
          /not verified/.test(f.reason),
      ),
    ).toBe(true);
    expect(
      recommendation.rejectedAlternatives.length +
        recommendation.stageAFailures.length,
    ).toBeGreaterThan(0);
  });

  it('6. rejects a provider that requires an unsupported payment token', async () => {
    const { services } = await commerceFixture({
      providers: [
        provider({
          acceptedPaymentAsset: '0x0000000000000000000000000000000000000abc',
        }),
      ],
    });
    const need = await openNeed(services, 'order_book_depth'),
      result = stageA({
        need,
        candidates: services.registry.all(),
        policy: services.policy,
        mode: 'mock',
        now: T0,
      });
    expect(result.eligible).toEqual([]);
    expect(result.failures[0]?.reason).toMatch(/payment asset/);
  });

  it('7. rejects a provider on an unapproved blockchain network', async () => {
    const { services } = await commerceFixture({
      providers: [provider({ supportedNetworks: ['eip155:8453'] })],
    });
    const need = await openNeed(services, 'order_book_depth'),
      result = stageA({
        need,
        candidates: services.registry.all(),
        policy: services.policy,
        mode: 'mock',
        now: T0,
      });
    expect(result.eligible).toEqual([]);
    expect(result.failures[0]?.reason).toMatch(/not approved for mock mode/);
  });

  it('remains deterministic and explains a rejected alternative', async () => {
    const { services } = await commerceFixture({
      providers: [
        provider({}),
        provider({
          providerId: 'mock-market-intel',
          serviceId: 'holder-flow-v1',
          quotedPrice: '0.08',
          supportedDataTypes: ['order_book_depth'],
          payTo: '0x2222222222222222222222222222222222222222',
          reliability: 0.5,
          historicalValidationPass: 0.5,
        }),
      ],
    });
    const need = await openNeed(services, 'order_book_depth'),
      first = await services.recommend(need),
      second = await services.recommend(need);
    expect(first.selected).toEqual({
      providerId: 'mock-liquidity-analytics',
      serviceId: 'orderbook-liquidity-v1',
    });
    expect(first).toEqual(second);
    expect(first.rejectedAlternatives[0]?.reason).toMatch(/lower score/);
    expect(first.quotedAmountUsdc).toBe('0.05');
  });

  it('scores cheapness as one factor, not the only one', async () => {
    const { services } = await commerceFixture({
      providers: [
        provider({ quotedPrice: '0.20' }),
        provider({
          providerId: 'mock-market-intel',
          serviceId: 'holder-flow-v1',
          quotedPrice: '0.01',
          supportedDataTypes: ['order_book_depth'],
          payTo: '0x2222222222222222222222222222222222222222',
          reliability: 0.2,
          historicalValidationPass: 0.2,
        }),
      ],
    });
    const need = await openNeed(services, 'order_book_depth'),
      recommendation = await services.recommend(need);
    expect(recommendation.selected?.providerId).toBe(
      'mock-liquidity-analytics',
    );
  });
});

describe('deterministic purchase policy', () => {
  it('authorizes a compliant intent and always requires a human approval', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need),
      decision = await services.requestAuthorization(intent.purchaseId);
    expect(decision.authorized).toBe(true);
    expect(decision.requiredHumanApproval).toBe(true);
    expect(decision.amountUsdc).toBe('0.05');
    expect(decision.checks.every((c) => c.passed)).toBe(true);
  });

  it('rejects a purchase on a network the wallet is not configured for', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need),
      decision = authorizePurchase({
        intent,
        policy: services.policy,
        runtime: { ...BASE_WALLET_STATE, walletNetwork: 'eip155:8453' },
      });
    expect(decision.authorized).toBe(false);
    expect(
      decision.reasons.some((r) => r.startsWith('wallet_network_matches')),
    ).toBe(true);
  });

  it('18. cannot spend on mainnet while it is disabled', async () => {
    const previous = process.env.COMMERCE_MAINNET_ENABLED;
    delete process.env.COMMERCE_MAINNET_ENABLED;
    try {
      await expect(
        commerceFixture({ mode: 'mainnet', mainnetEnabled: false }),
      ).rejects.toThrow(/COMMERCE_MAINNET_ENABLED/);
      await expect(
        commerceFixture({
          mode: 'mainnet',
          mainnetEnabled: true,
          omitWallet: true,
        }),
      ).rejects.toThrow(/MAINNET_WALLET_PRIVATE_KEY/);

      const { services } = await commerceFixture(),
        need = await openNeed(services, 'order_book_depth'),
        offer = services.registry.get(
          'mock-liquidity-analytics',
          'orderbook-liquidity-v1',
        )!,
        intent = await services.quote(offer, need),
        mainnetIntent = purchaseIntentSchema.parse({
          ...intent,
          mode: 'mainnet',
          quote: {
            ...intent.quote,
            requirement: {
              ...intent.quote.requirement,
              network: 'eip155:8453',
              asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            },
          },
        }),
        decision = authorizePurchase({
          intent: mainnetIntent,
          policy: services.policy,
          runtime: {
            ...BASE_WALLET_STATE,
            mode: 'mainnet',
            mainnetEnabled: true,
            walletNetwork: 'eip155:8453',
          },
        });
      expect(decision.authorized).toBe(false);
      expect(
        decision.reasons.some((r) =>
          r.startsWith('mainnet_explicitly_enabled'),
        ),
      ).toBe(true);
      expect(usdcSchema.safeParse(decision.amountUsdc).success).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.COMMERCE_MAINNET_ENABLED;
      else process.env.COMMERCE_MAINNET_ENABLED = previous;
    }
  });

  it('refuses to spend while the emergency stop is engaged', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.setDisabled(true, 'operator stop');
    const decision = authorizePurchase({
      intent,
      policy: services.policy,
      runtime: { ...BASE_WALLET_STATE, emergencyDisabled: true },
    });
    expect(decision.authorized).toBe(false);
    expect(
      decision.reasons.some((r) => r.startsWith('emergency_stop_clear')),
    ).toBe(true);
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('refused');
  });

  it('enforces the per-run cap across needs', async () => {
    const { services } = await commerceFixture({
      policy: { maxPerResearchRunUsdc: '0.05' },
    });
    const first = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, first);
    await services.approve(intent.purchaseId, 'test-operator');
    await services.execute(intent.purchaseId);
    const second = await openNeed(services, 'market_impact_liquidity'),
      secondIntent = await services.quote(offer, second),
      decision = await services.requestAuthorization(secondIntent.purchaseId);
    expect(decision.authorized).toBe(false);
    expect(decision.reasons.some((r) => r.startsWith('per_run_cap'))).toBe(
      true,
    );
  });

  it('13. keeps spending caps enforced under concurrent requests', async () => {
    const { services } = await commerceFixture({
      policy: { maxPerResearchRunUsdc: '0.05', maxPerPaymentUsdc: '0.25' },
    });
    const depth = await openNeed(services, 'order_book_depth'),
      impact = await openNeed(services, 'market_impact_liquidity'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      a = await services.quote(offer, depth),
      b = await services.quote(offer, impact);
    await services.approve(a.purchaseId, 'test-operator');
    await services.approve(b.purchaseId, 'test-operator');
    const outcomes = await Promise.all([
      services.execute(a.purchaseId),
      services.execute(b.purchaseId),
    ]);
    const settled = outcomes.filter((o) => o.status === 'settled').length,
      records = await services.purchases(),
      committed = records
        .filter((r) => r.paymentState === 'SETTLED')
        .reduce((sum, r) => sum + Number(r.amountUsdc), 0);
    expect(settled).toBeLessThanOrEqual(1);
    expect(committed).toBeLessThanOrEqual(0.05);
    const budget = await services.budget();
    expect(budget.dayCommittedUsdc <= 50_000n).toBe(true);
  });

  it('19. fails safely when the wallet is unavailable', async () => {
    const brokenWallet = {
      address: '0x0000000000000000000000000000000000000000',
      network: 'eip155:84532',
      async balanceUsdc(): Promise<bigint> {
        throw new Error('wallet backend unavailable');
      },
      async signAuthorization(): Promise<never> {
        throw new Error('wallet backend unavailable');
      },
    };
    const { services } = await commerceFixture({ wallet: brokenWallet }),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.approve(intent.purchaseId, 'test-operator');
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('failed');
    const record = await services.ledger.purchase(intent.purchaseId);
    expect(record?.paymentState).toBe('FAILED');
    expect(record?.settlement).toBeNull();
  });

  it('refuses a quote whose freshness window has passed', async () => {
    let now = T0;
    const { services } = await commerceFixture({ clock: () => now }),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.approve(intent.purchaseId, 'test-operator');
    now = T0 + 10 * 60_000;
    const decision = await services.requestAuthorization(intent.purchaseId);
    expect(decision.authorized).toBe(false);
    expect(decision.reasons.some((r) => r.startsWith('quote_unexpired'))).toBe(
      true,
    );
  });
});
