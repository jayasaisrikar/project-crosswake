import type { ProviderOffer } from '../types.js';

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

export interface PaymentProof {
  headerName: string;
  headerValue: string;
}

export interface AdapterRequestInput {
  offer: ProviderOffer;
  payment?: PaymentProof;
  timeoutMs?: number;
}

/**
 * A provider adapter is the only place that talks to a seller. Swapping a mock
 * seller for a live x402 seller must not change the commerce agent or the
 * policy engine, so everything after `request()` operates on a normalised
 * challenge and a purchased payload.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  readonly serviceId: string;
  request(input: AdapterRequestInput): Promise<ProviderResponse>;
}
