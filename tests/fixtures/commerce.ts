import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import policyDefaults from '../../configs/commerce/policy.json' with { type: 'json' };
import providersDefaults from '../../configs/commerce/providers.json' with { type: 'json' };
import type {
  ResearchGap,
  ResearchEvidenceSource,
} from '../../packages/commerce/src/need.js';
import {
  createCommerceServices,
  type CommerceServices,
  type MockSellerConfig,
} from '../../packages/commerce/src/services.js';
import type {
  EvidenceRef,
  ProviderOffer,
} from '../../packages/commerce/src/types.js';
import {
  createMockWallet,
  type WalletAdapter,
} from '../../packages/commerce/src/wallet.js';

export const T0 = 1_760_000_000_000;

export function evidence(
  dataType: EvidenceRef['dataType'],
  overrides: Partial<EvidenceRef> = {},
): EvidenceRef {
  return {
    id: `evidence-${dataType}`,
    dataType,
    classification: 'measured',
    source: 'fixture',
    asOf: T0 - 60_000,
    freshnessMs: 3_600_000,
    digest: 'a'.repeat(32),
    summary: `fixture ${dataType}`,
    ...overrides,
  };
}

export const ALL_GAPS: ResearchGap[] = [
  {
    dataType: 'order_book_depth',
    reason: 'depth is not persisted locally',
    expectedResearchBenefit: 'executability',
    desiredFreshnessMs: 86_400_000,
    maxCostUsdc: '0.25',
    priority: 'high',
  },
  {
    dataType: 'market_impact_liquidity',
    reason: 'impact curves are computed transiently only',
    expectedResearchBenefit: 'realistic costs',
    desiredFreshnessMs: 86_400_000,
    maxCostUsdc: '0.25',
    priority: 'high',
  },
  {
    dataType: 'holder_concentration',
    reason: 'no holder source is integrated',
    expectedResearchBenefit: 'risk input',
    desiredFreshnessMs: 86_400_000,
    maxCostUsdc: '0.25',
    priority: 'medium',
  },
  {
    dataType: 'token_flow_metrics',
    reason: 'no exchange-flow source is integrated',
    expectedResearchBenefit: 'corroboration',
    desiredFreshnessMs: 86_400_000,
    maxCostUsdc: '0.25',
    priority: 'medium',
  },
];

export function fixtureSource(
  options: {
    items?: EvidenceRef[];
    gaps?: ResearchGap[];
    asset?: string;
    market?: 'spot' | 'usdm';
  } = {},
): ResearchEvidenceSource {
  return {
    asset: options.asset ?? 'SOLUSDT',
    market: options.market ?? 'spot',
    async inventory() {
      return {
        items: options.items ?? [evidence('btc_correlation_metrics')],
        gaps: options.gaps ?? ALL_GAPS,
        provenance: ['fixture'],
      };
    },
  };
}

export interface CommerceFixtureOptions {
  source?: ResearchEvidenceSource;
  policy?: Partial<typeof policyDefaults>;
  providers?: ProviderOffer[];
  mode?: 'mock' | 'testnet' | 'mainnet';
  mainnetEnabled?: boolean;
  mockSellers?: Record<string, MockSellerConfig>;
  wallet?: WalletAdapter;
  /** Skip the injected mock wallet so the real wallet factory is exercised. */
  omitWallet?: boolean;
  /** Reuse an existing data dir, so two service instances share one ledger. */
  dir?: string;
  clock?: () => number;
}

export interface CommerceFixture {
  services: CommerceServices;
  dir: string;
  policy: typeof policyDefaults;
}

const providers = (providersDefaults as { providers: ProviderOffer[] })
  .providers;

/** Writes a temp policy + registry so tests can change caps without touching configs/. */
export async function commerceFixture(
  options: CommerceFixtureOptions = {},
): Promise<CommerceFixture> {
  const dir =
      options.dir ?? (await mkdtemp(join(tmpdir(), 'crosswake-commerce-'))),
    policy = { ...policyDefaults, ...options.policy },
    registry = {
      ...providersDefaults,
      providers: options.providers ?? providers,
    },
    policyPath = join(dir, 'policy.json'),
    registryPath = join(dir, 'providers.json');
  await writeFile(policyPath, JSON.stringify(policy, null, 2));
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
  const services = await createCommerceServices({
    dataDir: dir,
    source: options.source ?? fixtureSource(),
    policyPath,
    registryPath,
    mode: options.mode ?? 'mock',
    mainnetEnabled: options.mainnetEnabled ?? false,
    ...(options.omitWallet
      ? {}
      : { wallet: options.wallet ?? createMockWallet('crosswake-test') }),
    clock: options.clock ?? (() => T0),
    mockSellers: options.mockSellers,
  });
  return { services, dir, policy: policy as typeof policyDefaults };
}

export const MOCK_LIQUIDITY = 'mock-liquidity-analytics/orderbook-liquidity-v1';
export const MOCK_INTEL = 'mock-market-intel/holder-flow-v1';

export { providers };
