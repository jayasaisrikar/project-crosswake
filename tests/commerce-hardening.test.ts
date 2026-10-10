import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverTypedDataAddress } from 'viem';
import { createHttpX402Adapter } from '../packages/commerce/src/adapters/http.js';
import {
  crosswakeEvidenceSource,
  hyperliquidDepth,
} from '../packages/commerce/src/crosswake-source.js';
import {
  CommerceLedger,
  verifyLedger,
} from '../packages/commerce/src/ledger.js';
import {
  addUsdc,
  compareUsdc,
  formatUsdc,
  isValidUsdcText,
  parseUsdc,
} from '../packages/commerce/src/money.js';
import { parseChallenge } from '../packages/commerce/src/x402.js';
import { validatePurchasedData } from '../packages/commerce/src/validation.js';
import {
  createViemWallet,
  eip3009TypedData,
} from '../packages/commerce/src/wallet.js';
import { commerceFixture, MOCK_LIQUIDITY, T0 } from './fixtures/commerce.js';

describe('exact money arithmetic', () => {
  it('parses only plain non-negative decimals with at most six places', () => {
    expect(parseUsdc('0')).toBe(0n);
    expect(parseUsdc('1')).toBe(1_000_000n);
    expect(parseUsdc('0.05')).toBe(50_000n);
    expect(parseUsdc('1.000001')).toBe(1_000_001n);
    expect(parseUsdc('0.000001')).toBe(1n);
    for (const bad of [
      '',
      '1.1234567',
      '-1',
      '1e3',
      '0x10',
      '1,000',
      ' 1',
      '01',
      '.5',
      '1.',
      'NaN',
      'Infinity',
    ]) {
      expect(isValidUsdcText(bad), bad).toBe(false);
      expect(() => parseUsdc(bad), bad).toThrow();
    }
  });

  it('round-trips through formatUsdc without floating point', () => {
    for (const text of [
      '0',
      '0.05',
      '1',
      '0.000001',
      '3',
      '0.25',
      '123456.789012',
    ])
      expect(formatUsdc(parseUsdc(text))).toBe(text);
    expect(formatUsdc(50_000n)).toBe('0.05');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(() => formatUsdc(-1n)).toThrow(/non-negative/);
  });

  it('adds and compares without ever producing a float', () => {
    const total = addUsdc(parseUsdc('0.1'), parseUsdc('0.2'));
    expect(total).toBe(300_000n);
    expect(formatUsdc(total)).toBe('0.3');
    expect(compareUsdc(parseUsdc('0.1'), parseUsdc('0.05'))).toBe(1);
    expect(compareUsdc(parseUsdc('0.05'), parseUsdc('0.05'))).toBe(0);
    expect(compareUsdc(parseUsdc('0.04'), parseUsdc('0.05'))).toBe(-1);
    // The classic float trap, which integer minor units avoid entirely.
    expect(formatUsdc(parseUsdc('0.1') + parseUsdc('0.2'))).toBe('0.3');
  });
});

describe('EIP-3009 signing (the real wallet code path)', () => {
  // Published test key from the standard Anvil/Foundry test vector. Never funded.
  const testKey =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const,
    expectedAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    usdcSepolia = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

  it('derives the documented address for the test key', async () => {
    const wallet = await createViemWallet({
      privateKey: testKey,
      network: 'eip155:84532',
      rpcUrl: 'https://sepolia.base.org',
    });
    expect(wallet.address).toBe(expectedAddress);
    expect(wallet.network).toBe('eip155:84532');
  });

  it('signs EIP-712 typed data that recovers to the payer', async () => {
    const wallet = await createViemWallet({
        privateKey: testKey,
        network: 'eip155:84532',
        rpcUrl: 'https://sepolia.base.org',
      }),
      signed = await wallet.signAuthorization({
        requirement: {
          network: 'eip155:84532',
          asset: usdcSepolia,
          payTo: '0x1111111111111111111111111111111111111111',
          amount: '50000',
        },
        validAfter: 1_700_000_000,
        validBefore: 1_700_001_200,
        nonce: `0x${'ab'.repeat(32)}`,
      });
    expect(signed.authorization.value).toBe('50000');
    expect(signed.authorization.from).toBe(expectedAddress);
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    const typedData = eip3009TypedData({
      chainId: 84532,
      token: usdcSepolia,
      authorization: signed.authorization,
    });
    expect(typedData.domain).toEqual({
      name: 'USDC',
      version: '2',
      chainId: 84532,
      verifyingContract: usdcSepolia,
    });
    expect(
      typedData.types.TransferWithAuthorization.map((f) => f.name),
    ).toEqual(['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature: signed.signature as `0x${string}`,
      message: {
        from: signed.authorization.from as `0x${string}`,
        to: signed.authorization.to as `0x${string}`,
        value: BigInt(signed.authorization.value),
        validAfter: BigInt(signed.authorization.validAfter),
        validBefore: BigInt(signed.authorization.validBefore),
        nonce: signed.authorization.nonce as `0x${string}`,
      },
    });
    expect(recovered).toBe(expectedAddress);
  });

  it('refuses to sign a malformed authorisation request', async () => {
    const wallet = await createViemWallet({
      privateKey: testKey,
      network: 'eip155:84532',
      rpcUrl: 'https://sepolia.base.org',
    });
    await expect(
      wallet.signAuthorization({
        requirement: {
          network: 'eip155:84532',
          asset: usdcSepolia,
          payTo: 'not-an-address',
          amount: '50000',
        },
        validAfter: 1,
        validBefore: 2,
        nonce: '0xshort',
      }),
    ).rejects.toThrow();
  });
});

describe('live HTTP x402 transport', () => {
  const offer = {
    providerId: 'mock-liquidity-analytics',
    serviceId: 'orderbook-liquidity-v1',
    name: 'Mock Liquidity Analytics',
    description: 'depth',
    endpoint: 'https://seller.example/v1/liquidity',
    supportedAssets: ['SOLUSDT'],
    supportedDataTypes: ['order_book_depth' as const],
    supportedNetworks: ['eip155:84532'],
    acceptedPaymentAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    acceptedPaymentAssetSymbol: 'USDC' as const,
    quotedPrice: '0.05',
    quoteExpirationMs: 120000,
    dataFreshness: '5m',
    responseSchema: 'liquidity-v1',
    providerIdentity: 'mock://seller',
    verificationStatus: 'mock' as const,
    reliability: 0.9,
    historicalValidationPass: 0.9,
    payTo: '0x1111111111111111111111111111111111111111',
  };

  const challengeBody = JSON.stringify({
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: offer.endpoint,
      description: 'depth',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        asset: offer.acceptedPaymentAsset,
        amount: '50000',
        payTo: offer.payTo,
        maxTimeoutSeconds: 120,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  });

  it('sends a bounded, non-redirecting GET and normalises a v2 header challenge', async () => {
    const seen: { url: string; init: RequestInit }[] = [],
      fetcher: typeof fetch = async (input, init) => {
        seen.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ error: 'payment required' }), {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'payment-required': Buffer.from(challengeBody).toString('base64'),
          },
        });
      },
      adapter = createHttpX402Adapter({
        allowedHosts: ['seller.example'],
        fetcher,
        timeoutMs: 5_000,
      }),
      response = await adapter.request({ offer }),
      requirement = parseChallenge(response, offer);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.init.method).toBe('GET');
    expect(seen[0]?.init.redirect).toBe('error');
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(requirement.amount).toBe('50000');
    expect(requirement.network).toBe('eip155:84532');
    expect(requirement.resource).toBe(offer.endpoint);
  });

  it('reads the settlement receipt and forwards the payment header on the retry', async () => {
    const settlement = {
        success: true,
        transaction: `0x${'cd'.repeat(32)}`,
        network: 'eip155:84532',
        payer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      seen: RequestInit[] = [],
      fetcher: typeof fetch = async (_input, init) => {
        seen.push(init ?? {});
        return new Response('{"schema":"liquidity-v1"}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'payment-response': Buffer.from(
              JSON.stringify(settlement),
            ).toString('base64'),
          },
        });
      },
      adapter = createHttpX402Adapter({
        allowedHosts: ['seller.example'],
        fetcher,
      });
    await adapter.request({
      offer,
      payment: { headerName: 'PAYMENT-SIGNATURE', headerValue: 'cGF5bG9hZA==' },
    });
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers['PAYMENT-SIGNATURE']).toBe('cGF5bG9hZA==');
  });

  it('refuses an unsupported content type and an oversized body', async () => {
    const adapterFor = (fetcher: typeof fetch) =>
      createHttpX402Adapter({
        allowedHosts: ['seller.example'],
        fetcher,
        maxBytes: 512,
      });
    await expect(
      adapterFor(
        async () =>
          new Response('hello', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ).request({ offer }),
    ).rejects.toThrow(/unsupported content type/);
    await expect(
      adapterFor(
        async () =>
          new Response('x'.repeat(4096), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ).request({ offer }),
    ).rejects.toThrow(/bounded size/);
  });
});

describe('Crosswake evidence source against real files on disk', () => {
  async function dailyDir(root: string, symbol: string, rows: string[]) {
    await mkdir(join(root, 'daily', symbol), { recursive: true });
    await writeFile(
      join(root, 'daily', symbol, '2026-01.csv'),
      rows.join('\n'),
    );
  }

  const row = (ts: number, close: number, volume = 1000) =>
    `${ts},1,1,1,${close},${volume},0,0,0,0,0,0`;

  it('computes a real BTC correlation from daily closes', async () => {
    const root = await commerceFixture().then((f) => f.dir),
      base = Date.UTC(2025, 0, 1),
      day = 86_400_000,
      // Non-constant returns with a fixed 2x scale: log-returns are identical,
      // so the correlation is exactly 1 and the variance is non-zero.
      btcCloses = [100, 105, 112, 108, 120],
      solCloses = btcCloses.map((c) => c * 2),
      source = crosswakeEvidenceSource({
        dataDir: root,
        asset: 'SOLUSDT',
        market: 'spot',
      });
    await dailyDir(
      root,
      'BTCUSDT',
      btcCloses.map((c, i) => row(base + i * day, c)),
    );
    await dailyDir(
      root,
      'SOLUSDT',
      solCloses.map((c, i) => row(base + i * day, c, 5000)),
    );
    const { items, gaps, provenance } = await source.inventory(T0),
      correlation = items.find((i) => i.dataType === 'btc_correlation_metrics'),
      price = items.find((i) => i.dataType === 'market_price_history');
    expect(provenance.join(' ')).toMatch(/data\/daily\/SOLUSDT/);
    expect(price?.asOf).toBe(base + 4 * day);
    expect(price?.classification).toBe('measured');
    expect(correlation?.summary).toMatch(/correlation 1\.0000/);
    expect(correlation?.summary).toMatch(/n=4 aligned daily returns/);
    expect(gaps.map((g) => g.dataType)).toContain('order_book_depth');
    expect(items.some((i) => i.dataType === 'order_book_depth')).toBe(false);
  });

  it('normalises older microsecond archive timestamps instead of reading them as the future', async () => {
    const root = await commerceFixture().then((f) => f.dir),
      micros = Date.UTC(2025, 0, 1) * 1000,
      source = crosswakeEvidenceSource({
        dataDir: root,
        asset: 'SOLUSDT',
        market: 'spot',
      });
    await dailyDir(root, 'SOLUSDT', [
      row(micros, 10),
      row(micros + 86_400_000_000, 11),
    ]);
    const { items } = await source.inventory(T0),
      price = items.find((i) => i.dataType === 'market_price_history');
    expect(price?.asOf).toBe(Date.UTC(2025, 0, 2));
    expect(price!.asOf).toBeLessThan(T0);
  });

  it('drops the liquidity gaps once the pipeline can measure depth itself', async () => {
    const root = await commerceFixture().then((f) => f.dir),
      base = Date.UTC(2025, 0, 1),
      day = 86_400_000,
      rows = [100, 105, 112, 108, 120].map((c, i) => row(base + i * day, c)),
      // A book whose visible depth cannot absorb 250k, so the impact curve has a
      // real null in it rather than a fabricated number.
      fetcher: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            coin: 'SOL',
            time: base + 4 * day,
            levels: [
              [{ px: '109.95', sz: '1000', n: 3 }],
              [{ px: '109.96', sz: '1200', n: 4 }],
            ],
          }),
          { status: 200 },
        ),
      source = crosswakeEvidenceSource({
        dataDir: root,
        asset: 'SOLUSDT',
        market: 'spot',
        depth: hyperliquidDepth('SOL', {
          fetcher,
          notionals: [10_000, 250_000],
        }),
      });
    await dailyDir(root, 'BTCUSDT', rows);
    await dailyDir(root, 'SOLUSDT', rows);
    const inventory = await source.inventory(base + 4 * day),
      depth = inventory.items.find((i) => i.dataType === 'order_book_depth'),
      impact = inventory.items.find(
        (i) => i.dataType === 'market_impact_liquidity',
      );
    expect(depth?.classification).toBe('measured');
    expect(depth?.source).toMatch(/Hyperliquid perps/);
    // The cross-venue caveat must travel with the number.
    expect(depth?.summary).toMatch(/perpetuals book/);
    expect(impact?.summary).toMatch(/round trip/);
    expect(inventory.provenance.join(' ')).toMatch(/Hyperliquid perps level-2/);
    // Both liquidity gaps are gone, so nothing is bought for them.
    expect(inventory.gaps.map((g) => g.dataType)).toEqual([
      'holder_concentration',
      'token_flow_metrics',
    ]);
  });

  it('leaves the liquidity gaps open when the live measurement fails', async () => {
    const root = await commerceFixture().then((f) => f.dir),
      base = Date.UTC(2025, 0, 1),
      day = 86_400_000,
      failing: typeof fetch = async () =>
        new Response('{"error":"unavailable"}', { status: 400 }),
      source = crosswakeEvidenceSource({
        dataDir: root,
        asset: 'SOLUSDT',
        market: 'spot',
        depth: hyperliquidDepth('SOL', { fetcher: failing }),
      });
    await dailyDir(root, 'SOLUSDT', [row(base, 100), row(base + day, 105)]);
    const inventory = await source.inventory(base + day);
    expect(inventory.items.some((i) => i.dataType === 'order_book_depth')).toBe(
      false,
    );
    expect(inventory.gaps.map((g) => g.dataType)).toContain('order_book_depth');
    expect(inventory.gaps.map((g) => g.dataType)).toContain(
      'market_impact_liquidity',
    );
  });

  it('reports no evidence and still declares its gaps when nothing is on disk', async () => {
    const root = await commerceFixture().then((f) => f.dir),
      source = crosswakeEvidenceSource({
        dataDir: root,
        asset: 'XYZUSDT',
        market: 'spot',
      }),
      { items, gaps } = await source.inventory(T0);
    expect(items).toEqual([]);
    expect(gaps.length).toBeGreaterThan(0);
  });
});

describe('reconciliation and remaining validation branches', () => {
  async function stuckPurchase() {
    const first = await commerceFixture({
        mockSellers: { [MOCK_LIQUIDITY]: { variant: 'timeout-after-payment' } },
      }),
      decision = await first.services.identifyNeeds('run_reconcile'),
      need = decision.needs.find(
        (n) => n.requiredDataType === 'order_book_depth',
      )!,
      offer = first.services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!,
      intent = await first.services.quote(offer, need);
    await first.services.approve(intent.purchaseId, 'test-operator');
    expect((await first.services.execute(intent.purchaseId)).status).toBe(
      'settlement_unknown',
    );
    return { dir: first.dir, purchaseId: intent.purchaseId };
  }

  it('marks a purchase settled when the seller grants access on reconciliation', async () => {
    const { dir, purchaseId } = await stuckPurchase(),
      second = await commerceFixture({
        dir,
        mockSellers: { [MOCK_LIQUIDITY]: { variant: 'access-granted' } },
      });
    expect(await second.services.client.reconcile(purchaseId)).toBe('settled');
    const record = await second.services.ledger.purchase(purchaseId);
    expect(record?.paymentState).toBe('SETTLED');
    expect(record?.deliveryState).toBe('DELIVERED');
  });

  it('reports a stuck payment as not settled when the seller still demands payment', async () => {
    const { dir, purchaseId } = await stuckPurchase(),
      second = await commerceFixture({ dir, mockSellers: {} });
    expect(await second.services.client.reconcile(purchaseId)).toBe(
      'not_settled',
    );
    const record = await second.services.ledger.purchase(purchaseId);
    expect(record?.paymentState).toBe('SETTLEMENT_UNKNOWN');
  });

  it('reports still_unknown for a purchase it has no record of', async () => {
    const { services } = await commerceFixture();
    expect(await services.client.reconcile('pur_0000000000000000')).toBe(
      'still_unknown',
    );
  });

  const base = {
    schema: 'liquidity-v1',
    asset: 'SOLUSDT',
    market: 'spot',
    asOf: T0 - 1000,
    source: 'mock',
    spreadBps: 2,
    bidDepthUsdt: 1000,
    askDepthUsdt: 1000,
    impact: [{ notionalUsdt: 1000, buyBps: 1, sellBps: 1 }],
  };

  async function intentFor() {
    const { services } = await commerceFixture(),
      decision = await services.identifyNeeds('run_validation'),
      need = decision.needs.find(
        (n) => n.requiredDataType === 'order_book_depth',
      )!,
      offer = services.registry.get(
        'mock-liquidity-analytics',
        'orderbook-liquidity-v1',
      )!;
    return services.quote(offer, need);
  }

  it('rejects a payload for the wrong market', async () => {
    const outcome = validatePurchasedData({
      intent: await intentFor(),
      body: JSON.stringify({ ...base, market: 'usdm' }),
      contentType: 'application/json',
      responseTs: T0,
      now: T0,
    });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(/market identity mismatch/);
  });

  it('rejects a payload with no source provenance', async () => {
    const outcome = validatePurchasedData({
      intent: await intentFor(),
      body: JSON.stringify({ ...base, source: '' }),
      contentType: 'application/json',
      responseTs: T0,
      now: T0,
    });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(
      /does not match liquidity-v1|no source provenance/,
    );
  });

  it('rejects an unsupported content type', async () => {
    const outcome = validatePurchasedData({
      intent: await intentFor(),
      body: JSON.stringify(base),
      contentType: 'text/csv',
      responseTs: T0,
      now: T0,
    });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(/unsupported content type/);
  });

  it('rejects internally inconsistent impact figures', async () => {
    const outcome = validatePurchasedData({
      intent: await intentFor(),
      body: JSON.stringify({
        ...base,
        impact: [{ notionalUsdt: 1000, buyBps: 9000, sellBps: 1 }],
      }),
      contentType: 'application/json',
      responseTs: T0,
      now: T0,
    });
    expect(outcome.state).toBe('VALIDATION_FAILED');
    expect(outcome.reasons.join(' ')).toMatch(/internally inconsistent/);
  });

  it('validates a well-formed payload and attests to the limits of that', async () => {
    const outcome = validatePurchasedData({
      intent: await intentFor(),
      body: JSON.stringify(base),
      contentType: 'application/json',
      responseTs: T0,
      now: T0,
    });
    expect(outcome.state).toBe('VALIDATED');
    expect(outcome.normalized).toMatchObject({ asset: 'SOLUSDT' });
    expect(outcome.attestation).toMatch(/not certified true/);
    expect(outcome.injectionFindings).toEqual([]);
  });
});

describe('ledger concurrency and integrity', () => {
  it('serialises concurrent appends and keeps a valid hash chain', async () => {
    const { services, dir } = await commerceFixture(),
      ledger = new CommerceLedger(join(dir, 'commerce'), () => T0),
      writes = Array.from({ length: 8 }, (_, i) =>
        ledger.append({
          at: T0 + i,
          kind: 'payment',
          purchaseId: `pur_${String(i).padStart(16, '0')}`,
          researchRunId: 'run_concurrent',
          mode: 'mock',
          paymentState: 'CREATED',
          deliveryState: 'PENDING',
          validationState: 'PENDING',
          amountUsdc: '0',
          detail: { i },
        }),
      );
    expect(services.env.mode).toBe('mock');
    await Promise.all(writes);
    const events = await ledger.events();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(verifyLedger(events)).toMatchObject({ ok: true });
  });

  it('refuses to proceed unlocked when the lock is held', async () => {
    const { dir } = await commerceFixture(),
      ledger = new CommerceLedger(join(dir, 'commerce'), () => T0);
    await mkdir(join(dir, 'commerce', '.lock'), { recursive: true });
    await expect(
      ledger.append({
        at: T0,
        kind: 'payment',
        purchaseId: 'pur_0000000000000001',
        researchRunId: 'run_locked',
        mode: 'mock',
        paymentState: 'CREATED',
        deliveryState: 'PENDING',
        validationState: 'PENDING',
        amountUsdc: '0',
        detail: {},
      }),
    ).rejects.toThrow(/lock is held/);
    expect(await ledger.events()).toEqual([]);
  }, 15_000);
});
