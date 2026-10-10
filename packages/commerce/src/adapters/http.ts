import type {
  AdapterRequestInput,
  ProviderAdapter,
  ProviderResponse,
} from './index.js';
import type { ProviderOffer } from '../types.js';

export interface HttpX402Options {
  /** Hosts the live adapter may contact. The registry is the source of this list. */
  allowedHosts: string[];
  timeoutMs?: number;
  maxBytes?: number;
  fetcher?: typeof fetch;
}

const defaultOptions = { timeoutMs: 15_000, maxBytes: 1_000_000 };

/**
 * Client-side transport for a live x402 seller.
 *
 * SSRF posture: the URL comes from the validated registry entry, its host must
 * be allowlisted, redirects are refused rather than followed, the response is
 * size- and content-type-bounded, and every request carries a hard timeout.
 * Nothing here is reachable from model-generated text.
 */
export function createHttpX402Adapter(
  options: HttpX402Options,
): ProviderAdapter {
  const { allowedHosts, fetcher = fetch } = options,
    timeoutMs = options.timeoutMs ?? defaultOptions.timeoutMs,
    maxBytes = options.maxBytes ?? defaultOptions.maxBytes,
    allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));

  let providerId = '',
    serviceId = '';

  async function send(
    offer: ProviderOffer,
    payment?: AdapterRequestInput['payment'],
  ): Promise<ProviderResponse> {
    const url = new URL(offer.endpoint);
    if (url.protocol !== 'https:')
      throw new Error('Live provider endpoints must be https');
    if (!allowed.has(url.hostname.toLowerCase()))
      throw new Error(`Provider host is not allowlisted: ${url.hostname}`);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payment) headers[payment.headerName] = payment.headerValue;
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '',
      text = await response.text();
    if (text.length > maxBytes)
      throw new Error('Provider response exceeds the bounded size');
    const collected: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      collected[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers: collected,
      body: text,
      contentType,
    };
  }

  return {
    get providerId() {
      return providerId;
    },
    get serviceId() {
      return serviceId;
    },
    async request({ offer, payment }) {
      providerId = offer.providerId;
      serviceId = offer.serviceId;
      const response = await send(offer, payment);
      if (
        response.status === 200 &&
        !/^application\/json\b/.test(response.contentType)
      )
        throw new Error(
          `Provider returned an unsupported content type: ${response.contentType}`,
        );
      return response;
    },
  };
}
