import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHttpX402Adapter } from '../packages/commerce/src/adapters/http.js';
import { createMockSeller } from '../packages/commerce/src/adapters/mock.js';
import {
  CommerceLedger,
  verifyLedger,
} from '../packages/commerce/src/ledger.js';
import { runCostReport } from '../packages/commerce/src/observability.js';
import { runResearchCommerce } from '../packages/commerce/src/orchestrator.js';
import { authorizePurchase } from '../packages/commerce/src/policy.js';
import { readSettlement } from '../packages/commerce/src/x402.js';
import { validatePurchasedData } from '../packages/commerce/src/validation.js';
import { purchaseIntentSchema } from '../packages/commerce/src/types.js';
import { createMockWallet } from '../packages/commerce/src/wallet.js';
import {
  ALL_GAPS,
  commerceFixture,
  fixtureSource,
  MOCK_LIQUIDITY,
  T0,
} from './fixtures/commerce.js';
import type { CommerceServices } from '../packages/commerce/src/services.js';
import type { ResearchNeed } from '../packages/commerce/src/types.js';

async function openNeed(
  services: CommerceServices,
  dataType: string,
): Promise<ResearchNeed> {
  const decision = await services.identifyNeeds('run_pay');
  const need = decision.needs.find((n) => n.requiredDataType === dataType);
  if (!need) throw new Error(`no need for ${dataType}`);
  return need;
}

async function settledPurchase(services: CommerceServices, dataType: string) {
  const need = await openNeed(services, dataType),
    offer = services.registry.get(
      'mock-liquidity-analytics',
      'orderbook-liquidity-v1',
    )!,
    intent = await services.quote(offer, need);
  await services.approve(intent.purchaseId, 'test-operator');
  const outcome = await services.execute(intent.purchaseId);
  return { intent, outcome };
}

describe('x402 payment lifecycle (mock mode)', () => {
  it('9. completes a valid mock payment end to end and records settlement evidence', async () => {
    const { services } = await commerceFixture(),
      { intent, outcome } = await settledPurchase(services, 'order_book_depth');
    expect(outcome.status).toBe('settled');
    expect(outcome.settlement?.source).toBe('mock');
    const record = await services.ledger.purchase(intent.purchaseId);
    expect(record?.paymentState).toBe('SETTLED');
    expect(record?.deliveryState).toBe('DELIVERED');
    expect(record?.validationState).toBe('VALIDATED');
    expect(record?.amountUsdc).toBe('0.05');
    const purchased = await services.purchased(intent.purchaseId);
    expect(purchased?.validationState).toBe('VALIDATED');
    expect(purchased?.contentDigest).toHaveLength(64);
  });

  it('also completes against a v1 wire-format seller', async () => {
    const { services } = await commerceFixture({
      mockSellers: { [MOCK_LIQUIDITY]: { x402Version: 1 } },
    });
    const { outcome } = await settledPurchase(services, 'order_book_depth');
    expect(outcome.status).toBe('settled');
    expect(outcome.settlement?.source).toBe('mock');
  });

  it('records the challenge quote before any money moves', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    expect(intent.quote.requirement.x402Version).toBe(2);
    expect(intent.quote.requirement.amount).toBe('50000');
    expect(intent.quote.requirement.payTo).toBe(offer.payTo);
    expect(intent.quote.expiresAt).toBeGreaterThan(intent.quote.issuedAt);
    expect(await services.purchases()).toEqual([]);
  });

  it('10. keeps testnet a wired interface with no live transaction performed', async () => {
    // A live settlement is NOT verified: there is no funded testnet wallet or
    // seller in this environment. What is verified is the interface and the
    // refusal path.
    await expect(
      commerceFixture({ mode: 'testnet', omitWallet: true }),
    ).rejects.toThrow(/COMMERCE_TESTNET_WALLET_PRIVATE_KEY/);

    const facilitatorEvidence = readSettlement({
      status: 200,
      headers: {
        'payment-response': Buffer.from(
          JSON.stringify({
            success: true,
            transaction: '0x' + 'ab'.repeat(32),
            network: 'eip155:84532',
            payer: '0x4eb66231b2eed2d3412b3913eb6478c2a581e916',
          }),
        ).toString('base64'),
      },
      body: '{}',
      contentType: 'application/json',
    });
    expect(facilitatorEvidence?.source).toBe('resource-server');
    expect(facilitatorEvidence?.transaction).toHaveLength(66);

    const mock = await commerceFixture(),
      mockNeed = await openNeed(mock.services, 'order_book_depth'),
      mockOffer = mock.services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      mockIntent = await mock.services.quote(mockOffer, mockNeed),
      { services } = await commerceFixture({ mode: 'testnet' }),
      intent = purchaseIntentSchema.parse({ ...mockIntent, mode: 'testnet' }),
      decision = authorizePurchase({
        intent,
        policy: services.policy,
        runtime: {
          mode: 'testnet',
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
        },
      });
    expect(decision.authorized).toBe(true);
    expect(
      (await services.ledger.events()).filter(
        (e) => e.paymentState === 'SETTLED',
      ),
    ).toEqual([]);
  });

  it('14. refuses a duplicate purchase instead of charging twice', async () => {
    const { services } = await commerceFixture(),
      { intent, outcome } = await settledPurchase(services, 'order_book_depth');
    expect(outcome.status).toBe('settled');
    const duplicate = purchaseIntentSchema.parse({
        ...intent,
        purchaseId: `pur_${'0'.repeat(16)}`,
      }),
      decision = await services
        .requestAuthorization(duplicate.purchaseId)
        .catch(() => null);
    expect(decision).toBeNull();
    await services.ledger.writeIntent(duplicate);
    const second = await services.requestAuthorization(duplicate.purchaseId);
    expect(second.authorized).toBe(false);
    expect(
      second.reasons.some((r) => r.startsWith('idempotency_key_unused')),
    ).toBe(true);
    const settled = (await services.purchases()).filter(
      (p) => p.paymentState === 'SETTLED',
    );
    expect(settled).toHaveLength(1);
  });

  it('15. enters a reconciliation state when the payment outcome is unknown', async () => {
    const { services } = await commerceFixture({
        mockSellers: { [MOCK_LIQUIDITY]: { variant: 'timeout-after-payment' } },
      }),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.approve(intent.purchaseId, 'test-operator');
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('settlement_unknown');
    const record = await services.ledger.purchase(intent.purchaseId);
    expect(record?.paymentState).toBe('SETTLEMENT_UNKNOWN');
    expect(record?.settlementUnknownReason).toMatch(/transport failure/);
    // The hold is kept, so the budget cannot be spent twice while unresolved.
    const budget = await services.budget();
    expect(budget.dayHeldUsdc).toBe(50_000n);
    expect(await services.client.reconcile(intent.purchaseId)).toBe(
      'not_settled',
    );
  });

  it('17. makes no payment when the operator declines', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.decline(intent.purchaseId, 'test-operator');
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('failed');
    const record = await services.ledger.purchase(intent.purchaseId);
    expect(record?.paymentState).toBe('DECLINED');
    expect(record?.settlement).toBeNull();
    expect((await services.budget()).daySpentUsdc).toBe(0n);
  });

  it('does not pay without an approval, and reports awaiting approval', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('awaiting_approval');
    expect(
      (await services.ledger.purchase(intent.purchaseId))?.paymentState,
    ).toBe('AWAITING_APPROVAL');
  });

  it('26. treats a redirect instead of a payload as a failed purchase', async () => {
    const { services } = await commerceFixture({
        mockSellers: { [MOCK_LIQUIDITY]: { variant: 'redirect' } },
      }),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need);
    await services.approve(intent.purchaseId, 'test-operator');
    const outcome = await services.execute(intent.purchaseId);
    expect(outcome.status).toBe('failed');
    expect(
      (await services.ledger.purchase(intent.purchaseId))?.paymentState,
    ).toBe('FAILED');
    expect((await services.budget()).dayCommittedUsdc).toBe(0n);
  });

  it('27. refuses to contact a provider host that is not allowlisted', async () => {
    const adapter = createHttpX402Adapter({
        allowedHosts: ['mock-liquidity.invalid'],
      }),
      offer = {
        ...(await commerceFixture()).services.registry.get(
          'mock-liquidity-analytics',
          'orderbook-liquidity-v1',
        )!,
      };
    await expect(
      adapter.request({
        offer: { ...offer, endpoint: 'https://evil.example.com/v1/liquidity' },
      }),
    ).rejects.toThrow(/not allowlisted/);
    await expect(
      adapter.request({
        offer: {
          ...offer,
          endpoint: 'http://mock-liquidity.invalid/v1/liquidity',
        },
      }),
    ).rejects.toThrow(/https/);
  });

  it('keeps a hash-chained, tamper-evident audit ledger', async () => {
    const { services } = await commerceFixture();
    await settledPurchase(services, 'order_book_depth');
    const events = await services.ledger.events();
    expect(verifyLedger(events)).toMatchObject({ ok: true });
    const tampered = events.map((event, index) =>
      index === 1 ? { ...event, amountUsdc: '9.99' } : event,
    );
    const verification = verifyLedger(tampered);
    expect(verification.ok).toBe(false);
    if (!verification.ok)
      expect(verification.problem).toMatch(/contents do not match its hash/);
  });

  it('reads back a durable ledger from disk', async () => {
    const { services, dir } = await commerceFixture();
    await settledPurchase(services, 'order_book_depth');
    const reopened = new CommerceLedger(join(dir, 'commerce'));
    expect(verifyLedger(await reopened.events())).toMatchObject({ ok: true });
    expect(await reopened.purchases()).toHaveLength(1);
  });
});

describe('purchased data validation and trust', () => {
  it('11. fails safely on invalid provider JSON', async () => {
    const { services } = await commerceFixture({
      mockSellers: { [MOCK_LIQUIDITY]: { variant: 'invalid-schema' } },
    });
    const { outcome } = await settledPurchase(services, 'order_book_depth');
    expect(outcome.status).toBe('validation_failed');
    expect(outcome.reasons.join(' ')).toMatch(/does not match liquidity-v1/);
    const record = await services.ledger.purchase(
      (await services.purchases())[0]!.purchaseId,
    );
    expect(record?.paymentState).toBe('SETTLED');
    expect(record?.validationState).toBe('VALIDATION_FAILED');
  });

  it('12. rejects stale purchased data', async () => {
    const { services } = await commerceFixture({
      mockSellers: { [MOCK_LIQUIDITY]: { variant: 'stale' } },
    });
    const { outcome } = await settledPurchase(services, 'order_book_depth');
    expect(outcome.status).toBe('validation_failed');
    expect(outcome.reasons.join(' ')).toMatch(/stale by/);
  });

  it('rejects an oversized provider payload', async () => {
    const { services } = await commerceFixture({
      mockSellers: { [MOCK_LIQUIDITY]: { variant: 'oversized' } },
    });
    const { outcome } = await settledPurchase(services, 'order_book_depth');
    expect(outcome.status).toBe('validation_failed');
    expect(outcome.reasons.join(' ')).toMatch(/bounded size/);
  });

  it('23. rejects a payload timestamped in the future, so no look-ahead enters a run', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need),
      outcome = validatePurchasedData({
        intent,
        body: JSON.stringify({
          schema: 'liquidity-v1',
          asset: 'SOLUSDT',
          market: 'spot',
          asOf: T0 + 86_400_000,
          source: 'mock',
          spreadBps: 2,
          bidDepthUsdt: 1000,
          askDepthUsdt: 1000,
          impact: [{ notionalUsdt: 1000, buyBps: 1, sellBps: 1 }],
        }),
        contentType: 'application/json',
        responseTs: T0,
        now: T0,
      });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(/point-in-time/);
    const settled = await settledPurchase(services, 'order_book_depth');
    const purchased = await services.purchased(settled.intent.purchaseId);
    expect(purchased!.responseTs).toBeLessThanOrEqual(services.now());
  });

  it('rejects a payload for the wrong asset', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need),
      outcome = validatePurchasedData({
        intent,
        body: JSON.stringify({
          schema: 'liquidity-v1',
          asset: 'DOGEUSDT',
          market: 'spot',
          asOf: T0 - 1000,
          source: 'mock',
          spreadBps: 2,
          bidDepthUsdt: 1000,
          askDepthUsdt: 1000,
          impact: [{ notionalUsdt: 1000, buyBps: 1, sellBps: 1 }],
        }),
        contentType: 'application/json',
        responseTs: T0,
        now: T0,
      });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(/asset identity mismatch/);
  });

  it('rejects a duplicate payload already bought in the same run', async () => {
    const { services } = await commerceFixture(),
      need = await openNeed(services, 'order_book_depth'),
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await services.quote(offer, need),
      body = JSON.stringify({
        schema: 'liquidity-v1',
        asset: 'SOLUSDT',
        market: 'spot',
        asOf: T0 - 1000,
        source: 'mock',
        spreadBps: 2,
        bidDepthUsdt: 1000,
        askDepthUsdt: 1000,
        impact: [{ notionalUsdt: 1000, buyBps: 1, sellBps: 1 }],
      }),
      digest = validatePurchasedData({
        intent,
        body,
        contentType: 'application/json',
        responseTs: T0,
        now: T0,
      }).digest,
      outcome = validatePurchasedData({
        intent,
        body,
        contentType: 'application/json',
        responseTs: T0,
        now: T0,
        seenDigests: [digest],
      });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(/already purchased/);
  });

  it('16. cannot be made to spend by instructions inside a provider payload', async () => {
    const { services } = await commerceFixture({
      mockSellers: { [MOCK_LIQUIDITY]: { variant: 'prompt-injection' } },
    });
    const { intent, outcome } = await settledPurchase(
      services,
      'order_book_depth',
    );
    expect(outcome.status).toBe('validation_failed');
    expect(outcome.reasons.join(' ')).toMatch(/instruction-like text/);
    const purchased = await services.purchased(intent.purchaseId);
    expect(purchased?.validationState).toBe('VALIDATION_FAILED');
    // The injected recipient never becomes a payment target and the injection
    // never creates a new purchase.
    const purchases = await services.purchases(),
      events = await services.ledger.events();
    expect(purchases).toHaveLength(1);
    expect(
      events.some((event) =>
        JSON.stringify(event.detail).includes(
          '0x9999999999999999999999999999999999999999',
        ),
      ),
    ).toBe(false);
    const evidence = await services.integrate('run_pay', 'SOLUSDT', 'spot');
    expect(evidence.exclusions).toHaveLength(1);
    expect(evidence.signalConfidenceDelta).toBe(0);
  });
});

describe('pipeline integration, provenance and accounting', () => {
  it('20. keeps the research run working when optional paid research fails', async () => {
    const { services } = await commerceFixture({
      mockSellers: { [MOCK_LIQUIDITY]: { variant: 'timeout' } },
      source: fixtureSource({ gaps: [ALL_GAPS[0]!] }),
    });
    const run = await runResearchCommerce(services, {
      asset: 'SOLUSDT',
      researchRunId: 'run_resilient',
      autoApprove: true,
      approver: 'test-operator',
    });
    expect(run.status).toBe('PURCHASE_FAILED');
    expect(run.notes.some((n) => /failed|refused/.test(n))).toBe(true);
    const report = await services.ledger.run('run_resilient');
    expect(report).not.toBeNull();
    expect(report?.status).toBe('PURCHASE_FAILED');
    expect((await services.budget()).daySpentUsdc).toBe(0n);
  });

  it('reports NO_PURCHASE_NEEDED as a successful outcome', async () => {
    const { services } = await commerceFixture({
      source: fixtureSource({
        items: ALL_GAPS.map((gap) => ({
          id: `e-${gap.dataType}`,
          dataType: gap.dataType,
          classification: 'measured' as const,
          source: 'fixture',
          asOf: T0 - 1000,
          freshnessMs: 3_600_000,
          digest: 'b'.repeat(32),
          summary: 'fixture',
        })),
      }),
    });
    const run = await runResearchCommerce(services, {
      asset: 'SOLUSDT',
      researchRunId: 'run_none',
    });
    expect(run.status).toBe('NO_PURCHASE_NEEDED');
    expect(run.purchaseId).toBeNull();
    expect((await services.budget()).daySpentUsdc).toBe(0n);
  });

  it('gives the agent nine narrow tools and no way to pay', async () => {
    const { services } = await commerceFixture(),
      { createCommerceTools, COMMERCE_AGENT_TOOLS, commerceAgentInstructions } =
        await import('../packages/commerce/src/agent.js'),
      tools = Object.keys(
        createCommerceTools({
          model: 'openai/gpt-4.1-mini',
          services,
          researchRunId: 'run_agent',
          asset: 'SOLUSDT',
        }),
      ).sort();
    expect(tools).toEqual([...COMMERCE_AGENT_TOOLS].sort());
    for (const forbidden of [
      'pay',
      'execute',
      'sign',
      'wallet',
      'transfer',
      'setPolicy',
      'approve',
      'trade',
    ])
      expect(tools.some((name) => name.toLowerCase().includes(forbidden))).toBe(
        false,
      );
    expect(commerceAgentInstructions).toMatch(/cannot move money/);
    expect(commerceAgentInstructions).toMatch(/untrusted data/);
  });

  it('21. does not touch the existing signal, risk or backtest code', async () => {
    const dir = 'packages/commerce/src',
      files = (await readdir(dir, { withFileTypes: true })).filter((e) =>
        e.isFile(),
      );
    const sources: string[] = [];
    for (const entry of files)
      sources.push(await readFile(join(dir, entry.name), 'utf8'));
    for (const nested of ['adapters'])
      for (const entry of await readdir(join(dir, nested)))
        sources.push(await readFile(join(dir, nested, entry), 'utf8'));
    const imports = sources.join('\n');
    for (const forbidden of [
      '../signals',
      '../backtest',
      '../signal-log',
      '../research-runtime',
    ])
      expect(imports).not.toContain(forbidden);
    expect(imports).toContain('zod');
  });

  it('22. preserves provenance for measured and purchased evidence', async () => {
    const { services } = await commerceFixture(),
      { intent } = await settledPurchase(services, 'order_book_depth'),
      evidence = await services.integrate('run_pay', 'SOLUSDT', 'spot');
    const paid = evidence.items.find(
      (item) => item.classification === 'purchased',
    );
    expect(paid?.purchaseId).toBe(intent.purchaseId);
    expect(paid?.source).toMatch(/^paid:mock-liquidity-analytics\//);
    expect(paid?.validationState).toBe('VALIDATED');
    expect(paid?.digest).toHaveLength(64);
    expect(evidence.counts.measured).toBeGreaterThan(0);
    expect(evidence.counts.purchased).toBe(1);
    expect(evidence.signalConfidenceDelta).toBe(0);
    expect(evidence.attestation).toMatch(/never conflated/);
    const stored = await services.ledger.evidence('run_pay');
    expect(stored).not.toBeNull();
  });

  it('24. records paid, fee and token costs exactly', async () => {
    const { services } = await commerceFixture();
    await settledPurchase(services, 'order_book_depth');
    const report = await services.costReport('run_pay', {
      researchTasksCompleted: 1,
    });
    expect(report.usdcPaid).toBe('0.05');
    expect(report.networkFeesUsdc).toBe('0');
    expect(report.totalMarginalCostUsdc).toBe('0.05');
    const withLlm = runCostReport({
      researchRunId: 'run_pay',
      now: T0,
      purchases: await services.purchases(),
      counters: { purchasesSettled: 1 },
      llmTokens: 1500,
      llmCostUsdc: '0.0012',
      networkFeesUsdc: 250n,
    });
    expect(withLlm.llmTokens).toBe(1500);
    expect(withLlm.llmCostUsdc).toBe('0.0012');
    expect(withLlm.networkFeesUsdc).toBe('0.00025');
    expect(withLlm.totalMarginalCostUsdc).toBe('0.05145');
    expect(withLlm.caveat).toMatch(
      /not claimed to improve trading performance/,
    );
  });

  it('counts every observability counter for a research run', async () => {
    const { services } = await commerceFixture();
    await settledPurchase(services, 'order_book_depth');
    const report = await services.costReport('run_pay', {
      needsIdentified: 1,
      offersConsidered: 2,
      quotesReceived: 1,
      purchasesRequested: 1,
      purchasesApproved: 1,
      purchasesSettled: 1,
      validationFailures: 0,
      researchTasksCompleted: 1,
    });
    expect(report.counts.purchasesSettled).toBe(1);
    expect(report.counts.duplicatePurchaseAttempts).toBe(0);
    expect(report.dataFreshnessMs).toEqual({});
  });
});
