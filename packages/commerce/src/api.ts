import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { formatUsdc } from './money.js';
import { discoverProviders } from './discovery.js';
import type { CommerceServices } from './services.js';
import { purchaseIntentSchema } from './types.js';

export interface CommerceApiOptions {
  services: CommerceServices;
  token?: string;
}

const bodySchema = z.object({}).passthrough();

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status;
  response.end(JSON.stringify(body));
};

const actorSchema = z.object({ actor: z.string().min(1).max(120) });
const disableSchema = z.object({
  disabled: z.boolean(),
  reason: z.string().max(200).nullable().optional(),
});

/**
 * `/research/commerce/*` router.
 *
 * Read routes describe providers, quotes, purchases, budget and audit history.
 * Mutating routes are authenticated twice over: a bearer token AND, for money,
 * a recorded human approval event that names a person. A model's prose is never
 * an approval. Mutations are refused outright when no token is configured, so
 * an unconfigured deployment cannot spend.
 */
export function createCommerceRouter(options: CommerceApiOptions) {
  const { services } = options;

  async function readBody(request: IncomingMessage, limit = 4096) {
    const contentType = request.headers['content-type'] ?? '';
    if (!/^application\/json\b/.test(contentType))
      throw Object.assign(new Error('json_required'), { status: 415 });
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > limit)
        throw Object.assign(new Error('body_too_large'), { status: 413 });
    }
    try {
      return bodySchema.parse(body ? JSON.parse(body) : {});
    } catch {
      throw Object.assign(new Error('invalid_request'), { status: 400 });
    }
  }

  function authorized(request: IncomingMessage): boolean {
    if (!options.token) return false;
    const provided = Buffer.from(request.headers.authorization ?? ''),
      expected = Buffer.from(`Bearer ${options.token}`);
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }

  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
  ): Promise<boolean> {
    // segments[0] === 'research', segments[1] === 'commerce'
    const path = segments.slice(2),
      method = request.method ?? 'GET';
    try {
      if (method !== 'GET' && !authorized(request)) {
        send(response, 401, {
          error: 'commerce_mutations_require_research_api_token',
          detail:
            'Set RESEARCH_API_TOKEN and send it as a bearer token. Spending routes are never open on the loopback interface.',
        });
        return true;
      }
      if (method === 'GET' && options.token && !authorized(request)) {
        send(response, 401, { error: 'unauthorized' });
        return true;
      }
      if (method === 'GET') {
        if (path.length === 1 && path[0] === 'providers') {
          send(response, 200, {
            providers: services.registry.all(),
            registry: services.env.registryPath,
          });
          return true;
        }
        if (path.length === 1 && path[0] === 'budget') {
          const budget = await services.budget(),
            control = await services.ledger.control();
          send(response, 200, {
            mode: services.env.mode,
            mainnetEnabled: services.env.mainnetEnabled,
            policy: {
              maxPerPaymentUsdc: services.policy.maxPerPaymentUsdc,
              maxPerResearchRunUsdc: services.policy.maxPerResearchRunUsdc,
              maxDailyUsdc: services.policy.maxDailyUsdc,
            },
            disabled: control.disabled,
            disabledReason: control.reason,
            wallet: {
              address: services.wallet.address,
              network: services.wallet.network,
            },
            dayKey: budget.dayKey,
            daySpentUsdc: formatUsdc(budget.daySpentUsdc),
            dayHeldUsdc: formatUsdc(budget.dayHeldUsdc),
            dayCommittedUsdc: formatUsdc(budget.dayCommittedUsdc),
            totalSettledUsdc: formatUsdc(budget.totalSettledUsdc),
          });
          return true;
        }
        if (path.length === 1 && path[0] === 'purchases') {
          send(response, 200, { purchases: await services.purchases() });
          return true;
        }
        if (
          path.length === 3 &&
          path[0] === 'purchases' &&
          path[2] === 'audit'
        ) {
          const events = (await services.ledger.events()).filter(
            (event) => event.purchaseId === path[1],
          );
          if (!events.length) {
            send(response, 404, { error: 'not_found' });
            return true;
          }
          send(response, 200, { purchaseId: path[1], events });
          return true;
        }
        if (path.length === 2 && path[0] === 'purchases') {
          const record = await services.ledger.purchase(path[1]!),
            intent = await services.ledger.intent(path[1]!),
            purchased = await services.purchased(path[1]!);
          if (!record) {
            send(response, 404, { error: 'not_found' });
            return true;
          }
          send(response, 200, { record, intent, purchased });
          return true;
        }
        if (path.length === 2 && path[0] === 'runs') {
          const report = await services.ledger.run(path[1]!),
            evidence = await services.ledger.evidence(path[1]!);
          if (!report) {
            send(response, 404, { error: 'not_found' });
            return true;
          }
          send(response, 200, { report, evidence });
          return true;
        }
        if (path.length === 1 && path[0] === 'runs') {
          send(response, 200, { runs: await services.ledger.listRuns() });
          return true;
        }
        if (path.length === 1 && path[0] === 'offers') {
          const inventory = await services.source.inventory(services.now()),
            needs = await services.identifyNeeds('ad-hoc');
          send(response, 200, {
            asset: services.source.asset,
            market: services.source.market,
            gaps: inventory.gaps,
            needs: needs.needs,
            missingDataReport: needs.missingDataReport,
            candidates: needs.needs.flatMap((need) =>
              discoverProviders(services.registry, need).candidates.map(
                (offer) => ({
                  dataType: need.requiredDataType,
                  providerId: offer.providerId,
                  serviceId: offer.serviceId,
                  quotedPrice: offer.quotedPrice,
                }),
              ),
            ),
          });
          return true;
        }
        send(response, 404, { error: 'not_found' });
        return true;
      }
      if (path.length === 1 && path[0] === 'analyze') {
        const body = z
          .object({
            researchRunId: z.string().min(1).max(120).optional(),
            asset: z
              .string()
              .regex(/^[A-Z0-9]{2,20}$/)
              .optional(),
            market: z.enum(['spot', 'usdm']).optional(),
          })
          .strict()
          .parse(await readBody(request));
        const { runResearchCommerce } = await import('./orchestrator.js');
        // The API never auto-approves: money needs a recorded human decision.
        const run = await runResearchCommerce(services, {
          researchRunId: body.researchRunId,
          asset: body.asset ?? services.source.asset,
          market: body.market ?? services.source.market,
          autoApprove: false,
        });
        send(response, 202, run);
        return true;
      }
      if (
        path.length === 3 &&
        path[0] === 'purchases' &&
        path[2] === 'approve'
      ) {
        const body = actorSchema.parse(await readBody(request));
        await services.approve(path[1]!, body.actor);
        send(response, 200, {
          purchaseId: path[1],
          decision: 'approved',
          actor: body.actor,
          note: 'Approval recorded. `execute` performs the payment.',
        });
        return true;
      }
      if (
        path.length === 3 &&
        path[0] === 'purchases' &&
        path[2] === 'decline'
      ) {
        const body = actorSchema.parse(await readBody(request));
        await services.decline(path[1]!, body.actor);
        send(response, 200, { purchaseId: path[1], decision: 'declined' });
        return true;
      }
      if (
        path.length === 3 &&
        path[0] === 'purchases' &&
        path[2] === 'execute'
      ) {
        const intent = await services.ledger.intent(path[1]!);
        if (!intent) {
          send(response, 404, { error: 'not_found' });
          return true;
        }
        purchaseIntentSchema.parse(intent);
        const outcome = await services.execute(path[1]!);
        send(response, 200, outcome);
        return true;
      }
      if (
        path.length === 3 &&
        path[0] === 'purchases' &&
        path[2] === 'reconcile'
      ) {
        const result = await services.client.reconcile(path[1]!);
        send(response, 200, { purchaseId: path[1], result });
        return true;
      }
      if (path.length === 1 && path[0] === 'disable') {
        const body = disableSchema.parse(await readBody(request));
        await services.setDisabled(body.disabled, body.reason ?? null);
        send(response, 200, { disabled: body.disabled });
        return true;
      }
      send(response, 404, { error: 'not_found' });
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        send(response, 400, { error: 'invalid_request', issues: error.issues });
        return true;
      }
      const status = (error as { status?: number }).status;
      if (typeof status === 'number') {
        send(response, status, { error: String((error as Error).message) });
        return true;
      }
      send(response, 409, {
        error: 'commerce_operation_failed',
        detail: String((error as Error).message),
      });
      return true;
    }
  };
}
