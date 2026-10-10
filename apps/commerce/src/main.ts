import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { resolve } from 'node:path';
import {
  commerceModeSchema,
  type CommerceMode,
} from '../../../packages/commerce/src/types.js';
import { createCommerceServices } from '../../../packages/commerce/src/services.js';
import {
  crosswakeEvidenceSource,
  hyperliquidDepth,
} from '../../../packages/commerce/src/crosswake-source.js';
import { hlCoin } from '../../../packages/market-data/src/hyperliquid.js';
import { runResearchCommerce } from '../../../packages/commerce/src/orchestrator.js';
import type { MockVariant } from '../../../packages/commerce/src/adapters/mock.js';

const args = process.argv.slice(2),
  command = args[0] ?? 'demo';

function flag(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const dataDir = resolve(flag('data-dir') ?? process.env.DATA_DIR ?? './data'),
  asset = flag('asset') ?? process.env.COMMERCE_ASSET ?? 'SOLUSDT',
  mode = commerceModeSchema.parse(
    flag('mode') ?? process.env.COMMERCE_MODE ?? 'mock',
  ) as CommerceMode;

async function services(overrides: Record<string, MockVariant> = {}) {
  const liveDepth = has('live-depth');
  return createCommerceServices({
    dataDir,
    source: crosswakeEvidenceSource({
      dataDir,
      asset,
      market: 'spot',
      ...(liveDepth ? { depth: hyperliquidDepth(hlCoin(asset)) } : {}),
    }),
    mode,
    clock: Date.now,
    mockSellers: Object.fromEntries(
      Object.entries(overrides).map(([key, variant]) => [key, { variant }]),
    ),
  });
}

const usd = (value: string) => `${value} USDC`;

function printPurchase(record: {
  purchaseId: string;
  providerId: string;
  serviceId: string;
  amountUsdc: string;
  paymentState: string;
  deliveryState: string;
  validationState: string;
  settlement: { transaction: string; source: string } | null;
}) {
  console.log(
    `  ${record.purchaseId} ${record.providerId}/${record.serviceId} ${usd(record.amountUsdc)} ` +
      `payment=${record.paymentState} delivery=${record.deliveryState} validation=${record.validationState}` +
      (record.settlement
        ? ` settlement=${record.settlement.source} (${record.settlement.transaction.slice(0, 26)})`
        : ''),
  );
}

async function demo() {
  const overrides: Record<string, MockVariant> = {};
  const variant = flag('variant');
  if (variant)
    for (const key of [
      'mock-liquidity-analytics/orderbook-liquidity-v1',
      'mock-market-intel/holder-flow-v1',
    ])
      overrides[key] = variant as MockVariant;
  const runtime = await services(overrides);
  console.log(`Crosswake agentic commerce demo`);
  console.log(
    `  mode        ${runtime.env.mode} (mainnet enabled: ${runtime.env.mainnetEnabled})`,
  );
  console.log(`  asset       ${asset} spot`);
  console.log(`  data dir    ${runtime.env.dataDir}`);
  console.log(
    `  wallet      ${runtime.wallet.address} on ${runtime.wallet.network} (mock)`,
  );
  console.log(
    `  caps        ${runtime.policy.maxPerPaymentUsdc} / payment, ${runtime.policy.maxPerResearchRunUsdc} / run, ${runtime.policy.maxDailyUsdc} / day\n`,
  );

  console.log('1. Existing research evidence');
  const inventory = await runtime.source.inventory(runtime.now());
  for (const item of inventory.items)
    console.log(`   - ${item.dataType}: ${item.summary}`);
  console.log(
    `   declared gaps: ${inventory.gaps.map((g) => g.dataType).join(', ')}`,
  );
  if (
    has('live-depth') &&
    !inventory.items.some((i) => i.dataType === 'order_book_depth')
  )
    console.log(
      '   note: live Hyperliquid depth was requested but unavailable; the gap stays open',
    );
  console.log('');

  const run = await runResearchCommerce(runtime, {
    asset,
    market: 'spot',
    autoApprove: mode === 'mock' && !has('no-auto-approve'),
    approver: 'demo-operator',
  });
  console.log(`2. Run ${run.researchRunId} -> ${run.status}`);
  for (const note of run.notes) console.log(`   - ${note}`);

  const report = run.report as {
    offers?: {
      dataType: string;
      candidates: { providerId: string; quotedPrice: string }[];
      recommendation?: unknown;
    }[];
    purchase?: unknown;
    cost?: { usdcPaid: string; totalMarginalCostUsdc: string | null };
    evidence?: {
      counts: Record<string, number>;
      items: unknown[];
      exclusions: unknown[];
    };
  };
  console.log('\n3. Providers considered');
  for (const offer of report.offers ?? [])
    console.log(
      `   ${offer.dataType}: ${offer.candidates.map((c) => `${c.providerId}@${c.quotedPrice}`).join(', ')}`,
    );
  console.log('\n4. Purchase record');
  {
    const purchaseId = (report.purchase as { purchaseId?: string } | undefined)
      ?.purchaseId;
    const record = purchaseId
      ? await runtime.ledger.purchase(purchaseId)
      : null;
    if (record) printPurchase(record);
    else console.log('   no purchase was attempted');
  }
  console.log('\n5. Evidence set');
  console.log(`   classes ${JSON.stringify(report.evidence?.counts ?? {})}`);
  console.log(
    `   items ${report.evidence?.items.length ?? 0}, exclusions ${report.evidence?.exclusions.length ?? 0}`,
  );
  console.log('\n6. Cost');
  console.log(
    `   paid ${report.cost?.usdcPaid} USDC, marginal ${report.cost?.totalMarginalCostUsdc} USDC`,
  );
  console.log('\n7. Audit trail');
  for (const record of await runtime.purchases()) printPurchase(record);
  console.log(`\nReport: data/commerce/runs/${run.researchRunId}.json`);
  console.log(`Audit:  data/commerce/events.jsonl`);
}

async function main() {
  const runtime = await services();
  switch (command) {
    case 'demo':
      return demo();
    case 'run': {
      const run = await runResearchCommerce(runtime, {
        researchRunId: flag('run-id'),
        asset,
        autoApprove: mode === 'mock' && has('auto-approve'),
        approver: flag('approver'),
      });
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    case 'providers':
      console.log(JSON.stringify(runtime.registry.all(), null, 2));
      return;
    case 'offers': {
      const inventory = await runtime.source.inventory(runtime.now()),
        needs = await runtime.identifyNeeds('ad-hoc');
      console.log(
        JSON.stringify(
          {
            gaps: inventory.gaps.map((g) => g.dataType),
            needs: needs.needs.map((n) => n.requiredDataType),
            missingDataReport: needs.missingDataReport,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'budget': {
      const budget = await runtime.budget(),
        control = await runtime.ledger.control();
      console.log(
        JSON.stringify(
          {
            mode: runtime.env.mode,
            disabled: control.disabled,
            dayKey: budget.dayKey,
            daySpentUsdc: budget.daySpentUsdc.toString(),
            dayHeldUsdc: budget.dayHeldUsdc.toString(),
            dayCommittedUsdc: budget.dayCommittedUsdc.toString(),
            caps: {
              perPayment: runtime.policy.maxPerPaymentUsdc,
              perRun: runtime.policy.maxPerResearchRunUsdc,
              perDay: runtime.policy.maxDailyUsdc,
            },
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'purchases': {
      for (const record of await runtime.purchases()) printPurchase(record);
      return;
    }
    case 'purchase': {
      const id = args[1]!,
        record = await runtime.ledger.purchase(id),
        intent = await runtime.ledger.intent(id),
        purchased = await runtime.purchased(id);
      console.log(JSON.stringify({ record, intent, purchased }, null, 2));
      return;
    }
    case 'audit': {
      const events = (await runtime.ledger.events()).filter(
        (event) => event.purchaseId === args[1],
      );
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    case 'approve': {
      await runtime.approve(
        args[1]!,
        flag('actor') ?? process.env.USER ?? 'operator',
      );
      console.log(`approved ${args[1]}; run 'execute ${args[1]}' to pay`);
      return;
    }
    case 'decline': {
      await runtime.decline(
        args[1]!,
        flag('actor') ?? process.env.USER ?? 'operator',
      );
      console.log(`declined ${args[1]}`);
      return;
    }
    case 'execute': {
      const outcome = await runtime.execute(args[1]!);
      console.log(JSON.stringify(outcome, null, 2));
      return;
    }
    case 'reconcile': {
      console.log(await runtime.client.reconcile(args[1]!));
      return;
    }
    case 'disable':
    case 'enable': {
      await runtime.setDisabled(command === 'disable', flag('reason') ?? null);
      console.log(
        `commerce spending ${command === 'disable' ? 'disabled' : 'enabled'}`,
      );
      return;
    }
    case 'evaluate': {
      const runs = await Promise.all(
          (await runtime.ledger.listRuns()).map(async (id) => ({
            id,
            report: await runtime.ledger.run(id),
            evidence: await runtime.ledger.evidence(id),
          })),
        ),
        withEvidence = runs.filter(
          (run) =>
            ((run.evidence?.items as unknown[] | undefined) ?? []).length > 0 &&
            ((run.report?.purchases as unknown[] | undefined) ?? []).length >=
              0,
        );
      console.log(
        JSON.stringify(
          {
            configs: [
              'BASELINE (local evidence only)',
              'ENHANCED (local + purchased)',
            ],
            comparableRuns: withEvidence.length,
            evaluation: 'INSUFFICIENT_EVIDENCE',
            reason:
              'Paid historical data cannot be reconstructed point-in-time from the mock seller, so no comparable out-of-sample window exists. Baseline and enhanced signal metrics are deliberately not fabricated.',
            runs: runs.map((run) => ({
              runId: run.id,
              status: run.report?.status ?? 'unknown',
              evidenceClasses: run.evidence?.counts ?? {},
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'agent': {
      const modelId =
        flag('model') ??
        process.env.RESEARCH_MODEL ??
        process.env.COMMERCE_MODEL;
      if (!modelId)
        throw new Error(
          'the Mastra commerce agent needs a model: set RESEARCH_MODEL (provider/model)',
        );
      const { resolveModel } =
        await import('../../../packages/research-runtime/src/model.js');
      const { randomUUID } = await import('node:crypto');
      const { createCommerceAgent } =
        await import('../../../packages/commerce/src/agent.js');
      const researchRunId =
        flag('run-id') ?? `run_agent_${randomUUID().slice(0, 8)}`;
      const agent = createCommerceAgent({
        model: resolveModel(modelId),
        services: runtime,
        researchRunId,
        asset,
        market: 'spot',
      });
      const prompt =
        flag('prompt') ??
        `Research ${asset}/BTC. Inspect the evidence Crosswake already holds, decide whether any measurable gap is worth paying for, compare the available providers, and if a purchase is justified fetch a quote and request authorisation. Do not attempt to pay.`;
      const result = await agent.generate(prompt, { maxSteps: 12 });
      console.log(result.text);
      console.log('\nAudit: data/commerce/events.jsonl');
      return;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
