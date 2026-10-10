import { randomBytes } from 'node:crypto';
import { formatUsdc } from './money.js';
import type { CommerceServices } from './services.js';
import type { ResearchNeed } from './types.js';

export interface RunResearchCommerceOptions {
  researchRunId?: string;
  asset: string;
  // jay logs: default to spot for now, but we may want to support USDM in future
  market?: 'spot' | 'usdm';
  autoApprove?: boolean;
  approver?: string;
  maxPurchases?: number;
}

export interface ResearchCommerceRun {
  researchRunId: string;
  status:
    | 'NO_PURCHASE_NEEDED'
    | 'NO_PROVIDER'
    | 'NO_JUSTIFIED_PURCHASE'
    | 'AWAITING_APPROVAL'
    | 'PURCHASED'
    | 'PURCHASE_FAILED'
    | 'VALIDATION_FAILED';
  notes: string[];
  purchaseId: string | null;
  report: Record<string, unknown>;
}

export async function runResearchCommerce(
  services: CommerceServices,
  options: RunResearchCommerceOptions,
): Promise<ResearchCommerceRun> {
  const market = options.market ?? 'spot',
    researchRunId =
      options.researchRunId ??
      `run_${new Date(services.now()).toISOString().slice(0, 10)}_${randomBytes(4).toString('hex')}`,
    counters = {
      needsIdentified: 0,
      missingDataDecisions: 0,
      offersConsidered: 0,
      quotesReceived: 0,
      purchasesRequested: 0,
      purchasesApproved: 0,
      purchasesDeclined: 0,
      purchasesSettled: 0,
      paymentFailures: 0,
      validationFailures: 0,
      duplicatePurchaseAttempts: 0,
      researchTasksCompleted: 0,
    },
    notes: string[] = [];
  const decisions = await services.identifyNeeds(researchRunId);
  counters.needsIdentified = decisions.needs.length;
  counters.missingDataDecisions = decisions.missingDataReport.length;
  notes.push(...decisions.notes);
  const report: Record<string, unknown> = {
    researchRunId,
    asset: options.asset,
    market,
    mode: services.env.mode,
    generatedAt: services.now(),
    evidenceInspected: (await services.source.inventory(services.now())).items,
    needs: decisions.needs,
    missingDataReport: decisions.missingDataReport,
    offers: [] as unknown[],
    recommendation: null as unknown,
    purchase: null as unknown,
    evidence: null as unknown,
    wallet: {
      address: services.wallet.address,
      network: services.wallet.network,
    },
  };
  const providerResponseMs: Record<string, number> = {},
    dataFreshnessMs: Record<string, number> = {};
  const finish = async (
    status: ResearchCommerceRun['status'],
    purchaseId: string | null,
  ): Promise<ResearchCommerceRun> => {
    counters.researchTasksCompleted = 1;
    const cost = await services.costReport(researchRunId, counters, {
      providerResponseMs,
      dataFreshnessMs,
    });
    const evidence = await services.integrate(
      researchRunId,
      options.asset,
      market,
    );
    const outcome = {
      ...report,
      status,
      notes,
      cost,
      evidence,
    };
    await services.ledger.writeRun(researchRunId, outcome);
    await services.ledger.writeEvidence(researchRunId, evidence);
    return { researchRunId, status, notes, purchaseId, report: outcome };
  };
  if (!decisions.needs.length)
    return finish(
      decisions.status === 'NO_PROVIDER' ? 'NO_PROVIDER' : 'NO_PURCHASE_NEEDED',
      null,
    );

  const priorityOrder = { high: 0, medium: 1, low: 2 } as const,
    queue = [...decisions.needs].sort(
      (a: ResearchNeed, b: ResearchNeed) =>
        priorityOrder[a.priority] - priorityOrder[b.priority],
    ),
    maxPurchases = options.maxPurchases ?? 1;
  let purchased = 0,
    lastPurchaseId: string | null = null;
  for (const need of queue) {
    if (purchased >= maxPurchases) break;
    try {
      const discovery = (await import('./discovery.js')).discoverProviders(
        services.registry,
        need,
      );
      counters.offersConsidered += discovery.candidates.length;
      const recommendation = await services.recommend(need);
      (report.offers as unknown[]).push({
        dataType: need.requiredDataType,
        candidates: discovery.candidates.map((offer) => ({
          providerId: offer.providerId,
          serviceId: offer.serviceId,
          quotedPrice: offer.quotedPrice,
        })),
        rejected: discovery.rejected.map((r) => ({
          providerId: r.offer.providerId,
          reason: r.reason,
        })),
        recommendation,
      });
      report.recommendation = recommendation;
      notes.push(
        `need ${need.requiredDataType}: ${recommendation.recommendPurchase ? 'purchase justified' : 'no purchase justified'} - ${recommendation.reasonForSelection}`,
      );
      if (!recommendation.recommendPurchase || !recommendation.selected)
        continue;
      const offer = services.registry.get(
        recommendation.selected.providerId,
        recommendation.selected.serviceId,
      );
      if (!offer) {
        notes.push(
          'selected provider disappeared from the registry; not purchasing',
        );
        continue;
      }
      const quoteStarted = services.now(),
        intent = await services.quote(offer, need),
        quoteMs = services.now() - quoteStarted;
      providerResponseMs[`${offer.providerId}/${offer.serviceId}`] = quoteMs;
      counters.quotesReceived += 1;
      counters.purchasesRequested += 1;
      lastPurchaseId = intent.purchaseId;
      const decision = await services.requestAuthorization(intent.purchaseId);
      if (!decision.authorized) {
        counters.paymentFailures += 1;
        notes.push(`authorisation refused: ${decision.reasons.join('; ')}`);
        continue;
      }
      const approval = await services.authorityFor(intent.purchaseId);
      if (!approval) {
        if (services.env.mode === 'mock' && options.autoApprove) {
          await services.approve(
            intent.purchaseId,
            options.approver ?? `auto:${services.env.mode}`,
          );
          counters.purchasesApproved += 1;
        } else {
          report.purchase = {
            purchaseId: intent.purchaseId,
            state: 'AWAITING_APPROVAL',
          };
          return finish('AWAITING_APPROVAL', intent.purchaseId);
        }
      } else if (approval === 'declined') {
        counters.purchasesDeclined += 1;
        notes.push('purchase declined by the operator');
        continue;
      } else {
        counters.purchasesApproved += 1;
      }
      const executeStarted = services.now(),
        outcome = await services.execute(intent.purchaseId),
        purchasedRecord = await services.purchased(intent.purchaseId);
      providerResponseMs[`${offer.providerId}/${offer.serviceId}`] =
        services.now() - executeStarted;
      if (purchasedRecord)
        dataFreshnessMs[need.requiredDataType] = Math.max(
          0,
          services.now() - purchasedRecord.responseTs,
        );
      report.purchase = outcome;
      if (outcome.status === 'settled') {
        counters.purchasesSettled += 1;
        purchased += 1;
        notes.push(
          `settled ${offer.providerId}/${offer.serviceId} for ${formatUsdc(BigInt(intent.quote.requirement.amount))} USDC via x402 (${outcome.settlement?.source ?? 'unknown'} evidence)`,
        );
      } else if (outcome.status === 'validation_failed') {
        counters.purchasesSettled += 1;
        counters.validationFailures += 1;
        purchased += 1;
        notes.push(
          `payment settled but the payload failed validation: ${outcome.reasons.join('; ')}. The payment record is preserved and the research is marked unusable.`,
        );
      } else if (outcome.status === 'settlement_unknown') {
        counters.paymentFailures += 1;
        notes.push(
          'settlement outcome is unknown; the budget hold is kept and reconciliation is required before any retry',
        );
      } else {
        counters.paymentFailures += 1;
        notes.push(`purchase failed: ${outcome.reasons.join('; ')}`);
      }
    } catch (error) {
      // jay logs: carry on with the deterministic signal path.
      counters.paymentFailures += 1;
      notes.push(
        `commerce step failed for ${need.requiredDataType}: ${String(error)}`,
      );
    }
  }
  const finalStatus: ResearchCommerceRun['status'] =
    counters.purchasesSettled > 0
      ? counters.validationFailures > 0
        ? 'VALIDATION_FAILED'
        : 'PURCHASED'
      : counters.paymentFailures > 0
        ? 'PURCHASE_FAILED'
        : 'NO_JUSTIFIED_PURCHASE';
  return finish(finalStatus, lastPurchaseId);
}
