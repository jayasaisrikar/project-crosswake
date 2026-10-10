import { compareUsdc, formatUsdc, parseUsdc } from './money.js';
import {
  authorizationDecisionSchema,
  type AuthorizationDecision,
  type CheckResult,
  type CommerceMode,
  type ProviderOffer,
  type PurchaseIntent,
  type SpendPolicy,
} from './types.js';
import type { CommerceLedger } from './ledger.js';

export interface AuthorizeInput {
  intent: PurchaseIntent;
  policy: SpendPolicy;
  /** Live run state: mode, operator enable flag, runtime stop, current budget. */
  runtime: {
    mode: CommerceMode;
    mainnetEnabled: boolean;
    emergencyDisabled: boolean;
    now: number;
    walletBalanceUsdc: bigint;
    walletNetwork: string;
    walletAddress: string;
    dayCommittedUsdc: bigint;
    runCommittedUsdc: bigint;
    idempotencyKeySeen: boolean;
    equivalentAlreadyPurchased: boolean;
  };
}

const check = (name: string, passed: boolean, detail: string): CheckResult => ({
  check: name,
  passed,
  detail,
});

/**
 * The deterministic purchase policy. It is a pure function of the intent, the
 * committed policy file and observed ledger/runtime state - no model, no
 * randomness, no I/O. The executor calls it a second time immediately before
 * signing, so a decision can never be inherited from an earlier, weaker moment.
 */
export function authorizePurchase(
  input: AuthorizeInput,
): AuthorizationDecision {
  const { intent, policy, runtime } = input,
    offer: ProviderOffer = intent.offer,
    requirement = intent.quote.requirement,
    amount = BigInt(requirement.amount),
    checks: CheckResult[] = [];

  checks.push(
    check(
      'mode_matches_intent',
      runtime.mode === intent.mode,
      `intent mode ${intent.mode}, runtime mode ${runtime.mode}`,
    ),
    check(
      'emergency_stop_clear',
      !runtime.emergencyDisabled && !policy.emergencyDisabled,
      runtime.emergencyDisabled || policy.emergencyDisabled
        ? 'commerce spending is disabled'
        : 'spending enabled',
    ),
    check(
      'mainnet_explicitly_enabled',
      intent.mode !== 'mainnet' ||
        (runtime.mainnetEnabled &&
          process.env.COMMERCE_MAINNET_ENABLED === 'true'),
      intent.mode === 'mainnet'
        ? 'mainnet requires COMMERCE_MODE=mainnet, COMMERCE_MAINNET_ENABLED=true and a separate mainnet key'
        : 'not a mainnet purchase',
    ),
    check(
      'provider_allowlisted',
      policy.allowProviders.includes(offer.providerId),
      offer.providerId,
    ),
    check(
      'provider_verified',
      offer.verificationStatus !== 'unverified',
      `verification status ${offer.verificationStatus}`,
    ),
    check(
      'recipient_allowlisted',
      policy.allowRecipients.includes(requirement.payTo),
      requirement.payTo,
    ),
    check(
      'recipient_matches_registry',
      requirement.payTo.toLowerCase() === offer.payTo.toLowerCase(),
      'the 402 challenge recipient must equal the registered recipient',
    ),
    check(
      'network_approved',
      (policy.networks[intent.mode] ?? []).includes(requirement.network),
      `${requirement.network} for ${intent.mode} mode`,
    ),
    check(
      'wallet_network_matches',
      runtime.walletNetwork === requirement.network,
      `wallet ${runtime.walletNetwork}, requirement ${requirement.network}`,
    ),
    check(
      'asset_approved',
      policy.assets[requirement.network] === requirement.asset,
      `asset ${requirement.asset} on ${requirement.network}`,
    ),
    check(
      'scheme_approved',
      policy.approvedSchemes.includes(requirement.scheme),
      requirement.scheme,
    ),
    check(
      'resource_is_registered_endpoint',
      requirement.resource === offer.endpoint,
      'the paid resource must be the registered service endpoint',
    ),
    check(
      'per_payment_cap',
      compareUsdc(amount, parseUsdc(policy.maxPerPaymentUsdc)) <= 0,
      `${formatUsdc(amount)} <= ${policy.maxPerPaymentUsdc} USDC`,
    ),
    check(
      'per_run_cap',
      compareUsdc(
        runtime.runCommittedUsdc + amount,
        parseUsdc(policy.maxPerResearchRunUsdc),
      ) <= 0,
      `${runtime.runCommittedUsdc + amount} <= ${policy.maxPerResearchRunUsdc} USDC committed this run`,
    ),
    check(
      'daily_cap',
      compareUsdc(
        runtime.dayCommittedUsdc + amount,
        parseUsdc(policy.maxDailyUsdc),
      ) <= 0,
      `${runtime.dayCommittedUsdc + amount} <= ${policy.maxDailyUsdc} USDC committed today`,
    ),
    check(
      'need_cost_ceiling',
      compareUsdc(amount, parseUsdc(intent.need.maximumAcceptableCostUsdc)) <=
        0,
      `${formatUsdc(amount)} <= ${intent.need.maximumAcceptableCostUsdc} USDC`,
    ),
    check(
      'quote_unexpired',
      intent.quote.expiresAt > runtime.now,
      `quote expires at ${new Date(intent.quote.expiresAt).toISOString()}`,
    ),
    check(
      'idempotency_key_unused',
      !runtime.idempotencyKeySeen,
      runtime.idempotencyKeySeen
        ? `idempotency key ${intent.idempotencyKey} was already used`
        : 'first use of this idempotency key',
    ),
    check(
      'no_equivalent_purchase_in_run',
      !runtime.equivalentAlreadyPurchased,
      runtime.equivalentAlreadyPurchased
        ? 'equivalent data was already purchased in this research run'
        : 'no equivalent purchase recorded',
    ),
    check(
      'wallet_balance_sufficient',
      intent.mode === 'mainnet'
        ? true
        : compareUsdc(runtime.walletBalanceUsdc, amount) >= 0,
      `balance ${runtime.walletBalanceUsdc} >= ${amount}`,
    ),
    check(
      'payer_is_not_recipient',
      runtime.walletAddress.toLowerCase() !== requirement.payTo.toLowerCase(),
      'the payer and recipient must differ',
    ),
  );

  const failed = checks.filter((c) => !c.passed),
    requiredHumanApproval = true;
  return authorizationDecisionSchema.parse({
    authorized: failed.length === 0,
    requiredHumanApproval,
    reasons: failed.length
      ? failed.map((c) => `${c.check}: ${c.detail}`)
      : [
          'All deterministic checks passed. A recorded human approval is still required before signing.',
        ],
    checks,
    amountUsdc: formatUsdc(amount),
  });
}

export async function authorizeWithLedger(
  ledger: CommerceLedger,
  input: Omit<AuthorizeInput, 'runtime'> & {
    runtime: Omit<
      AuthorizeInput['runtime'],
      | 'dayCommittedUsdc'
      | 'runCommittedUsdc'
      | 'idempotencyKeySeen'
      | 'equivalentAlreadyPurchased'
    >;
  },
): Promise<AuthorizationDecision> {
  const budget = await ledger.budgetSnapshot(
    input.runtime.now,
    input.intent.purchaseId,
  );
  return authorizePurchase({
    ...input,
    runtime: {
      ...input.runtime,
      dayCommittedUsdc: budget.dayCommittedUsdc,
      runCommittedUsdc: await ledger.runCommittedUsdc(
        input.intent.researchRunId,
        input.intent.purchaseId,
      ),
      idempotencyKeySeen: await ledger.hasIdempotencyKey(
        input.intent.idempotencyKey,
        input.intent.purchaseId,
      ),
      equivalentAlreadyPurchased: await ledger.hasDeliveredEquivalent(
        input.intent.researchRunId,
        input.intent.offer.providerId,
        input.intent.offer.serviceId,
        input.intent.need.requiredDataType,
        input.intent.purchaseId,
      ),
    },
  });
}
