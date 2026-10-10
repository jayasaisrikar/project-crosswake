import type { ProviderRegistryIndex } from './registry.js';
import type { ResearchNeed } from './types.js';
import type { ProviderOffer } from './types.js';

export interface DiscoveryResult {
  candidates: ProviderOffer[];
  rejected: { offer: ProviderOffer; reason: string }[];
}

/**
 * Discovery is deterministic and registry-driven. There is no scraping, no
 * invented endpoint and no model-generated provider: a service is discoverable
 * only because an operator registered and verified it.
 */
export function discoverProviders(
  registry: ProviderRegistryIndex,
  need: ResearchNeed,
): DiscoveryResult {
  const candidates: ProviderOffer[] = [],
    rejected: { offer: ProviderOffer; reason: string }[] = [];
  for (const offer of registry.all()) {
    if (!offer.supportedDataTypes.includes(need.requiredDataType)) {
      rejected.push({
        offer,
        reason: `does not offer ${need.requiredDataType}`,
      });
      continue;
    }
    if (!offer.supportedAssets.includes(need.asset)) {
      rejected.push({ offer, reason: `does not cover ${need.asset}` });
      continue;
    }
    candidates.push(offer);
  }
  return { candidates, rejected };
}
