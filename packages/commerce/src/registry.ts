import {
  providerOfferSchema,
  type ProviderOffer,
  type ProviderRegistry,
} from './types.js';

/**
 * Only registered providers are usable, and only those the policy allowlists.
 * A registry entry is a validated service configuration: documented endpoint,
 * payment asset, recipient and price metadata. Prices here are metadata for
 * evaluation; a purchase always uses the seller's own 402 challenge.
 */
export class ProviderRegistryIndex {
  private constructor(private readonly byId: Map<string, ProviderOffer>) {}

  static from(registry: ProviderRegistry): ProviderRegistryIndex {
    const byId = new Map<string, ProviderOffer>();
    for (const provider of registry.providers) {
      const offer = providerOfferSchema.parse(provider);
      const key = `${offer.providerId}/${offer.serviceId}`;
      if (byId.has(key))
        throw new Error(`Duplicate provider service in registry: ${key}`);
      byId.set(key, offer);
    }
    return new ProviderRegistryIndex(byId);
  }

  all(): ProviderOffer[] {
    return [...this.byId.values()];
  }

  get(providerId: string, serviceId: string): ProviderOffer | null {
    return this.byId.get(`${providerId}/${serviceId}`) ?? null;
  }

  has(providerId: string): boolean {
    return [...this.byId.values()].some((o) => o.providerId === providerId);
  }
}
