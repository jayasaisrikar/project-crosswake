import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { createCommerceRouter } from '../packages/commerce/src/api.js';
import { verifyLedger } from '../packages/commerce/src/ledger.js';
import { createEvidenceServer } from '../packages/research-runtime/src/evidence-api.js';
import { commerceFixture } from './fixtures/commerce.js';
import type { CommerceServices } from '../packages/commerce/src/services.js';

const TOKEN = 'commerce-api-test-token';

let server: Server, base: string, services: CommerceServices, dataDir: string;

const call = (
  path: string,
  init: RequestInit = {},
  withToken = true,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(withToken ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });

const post = (path: string, body: unknown, withToken = true) =>
  call(path, { method: 'POST', body: JSON.stringify(body) }, withToken);

beforeAll(async () => {
  const fixture = await commerceFixture();
  services = fixture.services;
  dataDir = fixture.dir;
  const protocolDir = join(dataDir, 'protocols');
  await mkdir(protocolDir, { recursive: true });
  server = createEvidenceServer(
    { dataDir, protocolDir },
    {
      token: TOKEN,
      commerce: createCommerceRouter({ services, token: TOKEN }),
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/research/commerce API', () => {
  it('leaves the existing evidence route untouched', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      researchStatus: 'UNVALIDATED',
    });
  });

  it('refuses every commerce route without the bearer token', async () => {
    expect((await call('/research/commerce/providers', {}, false)).status).toBe(
      401,
    );
    expect((await call('/research/commerce/budget', {}, false)).status).toBe(
      401,
    );
    expect((await post('/research/commerce/analyze', {}, false)).status).toBe(
      401,
    );
    const denied = await post('/research/commerce/analyze', {}, false);
    expect(await denied.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('cannot spend at all when no token is configured anywhere', async () => {
    // A deployment that forgot RESEARCH_API_TOKEN must not be able to spend,
    // even from the loopback interface.
    const open = createEvidenceServer(
      { dataDir, protocolDir: join(dataDir, 'protocols') },
      { commerce: createCommerceRouter({ services }) },
    );
    await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
    try {
      expect(
        (await fetch(`${origin}/research/commerce/providers`)).status,
      ).toBe(200);
      const denied = await fetch(`${origin}/research/commerce/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({
        error: 'commerce_mutations_require_research_api_token',
      });
      expect(
        (
          await fetch(`${origin}/research/commerce/disable`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"disabled":true}',
          })
        ).status,
      ).toBe(401);
    } finally {
      await new Promise<void>((resolve) => open.close(() => resolve()));
    }
  });

  it('lists providers, gaps and offers', async () => {
    const providers = await (await call('/research/commerce/providers')).json();
    expect(providers.providers).toHaveLength(3);
    const offers = await (await call('/research/commerce/offers')).json();
    expect(offers.asset).toBe('SOLUSDT');
    expect(offers.gaps.map((g: { dataType: string }) => g.dataType)).toContain(
      'order_book_depth',
    );
    expect(offers.candidates.length).toBeGreaterThan(0);
  });

  it('reports the budget with decimal amounts and the caps', async () => {
    const budget = await (await call('/research/commerce/budget')).json();
    expect(budget.mode).toBe('mock');
    expect(budget.mainnetEnabled).toBe(false);
    expect(budget.policy.maxPerPaymentUsdc).toBe('0.25');
    expect(budget.daySpentUsdc).toMatch(/^\d+(\.\d{1,6})?$/);
  });

  it('runs an analysis but never auto-approves a purchase', async () => {
    const response = await post('/research/commerce/analyze', {
      asset: 'SOLUSDT',
      researchRunId: 'run_api_test',
    });
    expect(response.status).toBe(202);
    const run = await response.json();
    expect(run.status).toBe('AWAITING_APPROVAL');
    expect(run.purchaseId).toMatch(/^pur_[a-f0-9]{16}$/);
    const purchases = await (await call('/research/commerce/purchases')).json();
    expect(
      purchases.purchases.every(
        (p: { paymentState: string }) => p.paymentState !== 'SETTLED',
      ),
    ).toBe(true);
  });

  it('requires an actor to record an approval and then settles on execute', async () => {
    const purchases = await (await call('/research/commerce/purchases')).json(),
      purchaseId = purchases.purchases[0].purchaseId;
    expect(
      (await post(`/research/commerce/purchases/${purchaseId}/approve`, {}))
        .status,
    ).toBe(400);
    const approved = await post(
      `/research/commerce/purchases/${purchaseId}/approve`,
      { actor: 'jay' },
    );
    expect(approved.status).toBe(200);
    const executed = await post(
      `/research/commerce/purchases/${purchaseId}/execute`,
      {},
    );
    expect(executed.status).toBe(200);
    const outcome = await executed.json();
    expect(outcome.status).toBe('settled');
    expect(outcome.settlement.source).toBe('mock');

    const detail = await (
      await call(`/research/commerce/purchases/${purchaseId}`)
    ).json();
    expect(detail.record.validationState).toBe('VALIDATED');
    expect(detail.purchased.contentDigest).toHaveLength(64);

    const audit = await (
      await call(`/research/commerce/purchases/${purchaseId}/audit`)
    ).json();
    expect(verifyLedger(audit.events)).toMatchObject({ ok: true });
    expect(
      audit.events.some(
        (e: { paymentState: string; deliveryState: string }) =>
          e.paymentState === 'SETTLED' && e.deliveryState === 'DELIVERED',
      ),
    ).toBe(true);
  });

  it('exposes the run report with its cost and evidence', async () => {
    const runs = await (await call('/research/commerce/runs')).json();
    expect(runs.runs).toContain('run_api_test');
    const run = await (
      await call('/research/commerce/runs/run_api_test')
    ).json();
    expect(run.report.status).toBe('AWAITING_APPROVAL');
    expect(run.report.cost.usdcPaid).toBe('0');
    expect(run.evidence.counts.measured).toBeGreaterThan(0);
  });

  it('stops spending immediately when the emergency switch is thrown', async () => {
    expect(
      (
        await post('/research/commerce/disable', {
          disabled: true,
          reason: 'test',
        })
      ).status,
    ).toBe(200);
    const budget = await (await call('/research/commerce/budget')).json();
    expect(budget.disabled).toBe(true);
    const refused = await (
      await post('/research/commerce/analyze', {
        asset: 'SOLUSDT',
        researchRunId: 'run_api_disabled',
      })
    ).json();
    expect(refused.status).toBe('PURCHASE_FAILED');
    expect(refused.notes.join(' ')).toMatch(/emergency_stop_clear/);
    await post('/research/commerce/disable', { disabled: false });
    expect(
      (await (await call('/research/commerce/budget')).json()).disabled,
    ).toBe(false);
  });

  it('rejects malformed requests with the right status codes', async () => {
    expect((await call('/research/commerce/nope')).status).toBe(404);
    expect(
      (
        await call('/research/commerce/analyze', {
          method: 'POST',
          body: 'not json',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call('/research/commerce/analyze', {
          method: 'POST',
          body: JSON.stringify({ asset: 'not a symbol' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/research/commerce/analyze', {
          method: 'POST',
          body: JSON.stringify({ asset: 'SOLUSDT', pad: 'x'.repeat(5000) }),
        })
      ).status,
    ).toBe(413);
  });
});
