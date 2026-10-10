import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  PaymentRequirement,
  ProviderOffer,
  ResearchNeed,
} from './types.js';

export const liquiditySchema = z
  .object({
    schema: z.literal('liquidity-v1'),
    asset: z.string().regex(/^[A-Z0-9]{2,20}$/),
    market: z.enum(['spot', 'usdm']),
    asOf: z.number().int().positive(),
    source: z.string().min(1).max(200),
    spreadBps: z.number().nonnegative().max(10_000),
    bidDepthUsdt: z.number().positive(),
    askDepthUsdt: z.number().positive(),
    impact: z
      .array(
        z
          .object({
            notionalUsdt: z.number().positive(),
            buyBps: z.number().nonnegative().max(10_000),
            sellBps: z.number().nonnegative().max(10_000),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const flowsSchema = z
  .object({
    schema: z.literal('flows-v1'),
    asset: z.string().regex(/^[A-Z0-9]{2,20}$/),
    market: z.enum(['spot', 'usdm']),
    asOf: z.number().int().positive(),
    source: z.string().min(1).max(200),
    topHolderShare: z.number().min(0).max(1),
    exchangeNetFlowUsdc: z.number(),
    onchainLiquidityUsdc: z.number().nonnegative(),
  })
  .strict();

const schemas: Record<string, z.ZodTypeAny> = {
  'liquidity-v1': liquiditySchema,
  'flows-v1': flowsSchema,
};

const INJECTION_PATTERNS: { id: string; pattern: RegExp }[] = [
  {
    id: 'instruction_override',
    pattern:
      /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier)\b/i,
  },
  {
    id: 'wallet_instruction',
    pattern:
      /\b(send|transfer|pay|approve)\b[^.]{0,40}\b(usdc|funds|payment|wallet)\b/i,
  },
  {
    id: 'role_marker',
    pattern: /<\/?(system|assistant|tool_use|instruction)\b/i,
  },
  { id: 'address_in_text', pattern: /0x[0-9a-fA-F]{40}/ },
];

export interface InjectionFinding {
  id: string;
  excerpt: string;
}

/** Purchased content is untrusted input. Instruction-like text is never obeyed. */
export function scanForInjection(text: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { id, pattern } of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) findings.push({ id, excerpt: match[0].slice(0, 120) });
  }
  return findings;
}

export interface ValidationInput {
  intent: {
    need: ResearchNeed;
    offer: ProviderOffer;
    quote: { requirement: PaymentRequirement };
  };
  body: string;
  contentType: string;
  responseTs: number;
  now: number;
  /** Digests already purchased, for duplicate detection. */
  seenDigests?: string[];
  maxBytes?: number;
}

export interface ValidationOutcome {
  state: 'VALIDATED' | 'VALIDATION_FAILED';
  reasons: string[];
  digest: string;
  normalized: unknown;
  injectionFindings: InjectionFinding[];
  attestation: string;
}

/**
 * Deterministic purchased-data validation.
 *
 * A settled payment proves money moved, not that the payload is accurate or
 * safe. Every check here is independent of the payment and of any model:
 * content type, size, JSON well-formedness, schema, asset/market identity,
 * freshness, numeric sanity, internal consistency, duplicates, provenance and
 * prompt injection. A validation failure never reverses a settled payment; it
 * marks the research unusable and the cost is surfaced.
 */
export function validatePurchasedData(
  input: ValidationInput,
): ValidationOutcome {
  const digest = createHash('sha256').update(input.body).digest('hex'),
    reasons: string[] = [];
  let hardFailure = false;
  const fail = (message: string) => {
    reasons.push(message);
    hardFailure = true;
  };

  const maxBytes = input.maxBytes ?? 1_000_000;
  if (!/^application\/json\b/.test(input.contentType))
    fail(`unsupported content type: ${input.contentType || 'none'}`);
  if (input.body.length > maxBytes)
    fail(`response exceeds the bounded size (${input.body.length} bytes)`);
  if ((input.seenDigests ?? []).includes(digest))
    fail('identical payload was already purchased in this research run');

  let parsed: unknown = null,
    parsedOk = false;
  try {
    parsed = JSON.parse(input.body);
    parsedOk = true;
  } catch {
    fail('response body is not valid JSON');
  }

  const injectionFindings = parsedOk ? scanForInjection(input.body) : [];
  if (injectionFindings.length)
    fail(
      `provider content contains instruction-like text (${injectionFindings
        .map((f) => f.id)
        .join(
          ', ',
        )}); the payload is rejected as unusable research rather than obeyed`,
    );

  if (parsedOk) {
    const schema = schemas[input.intent.offer.responseSchema];
    if (!schema)
      fail(`unknown response schema ${input.intent.offer.responseSchema}`);
    else {
      const result = schema.safeParse(parsed);
      if (!result.success)
        fail(
          `payload does not match ${input.intent.offer.responseSchema}: ${result.error.issues
            .slice(0, 3)
            .map(
              (issue) => `${issue.path.join('.') || 'root'} ${issue.message}`,
            )
            .join('; ')}`,
        );
      else {
        const data = result.data as {
          asset: string;
          market: string;
          asOf: number;
          source: string;
        };
        if (data.asset !== input.intent.need.asset)
          fail(
            `asset identity mismatch: paid for ${input.intent.need.asset}, got ${data.asset}`,
          );
        if (data.market !== input.intent.need.market)
          fail(
            `market identity mismatch: expected ${input.intent.need.market}, got ${data.market}`,
          );
        if (typeof data.source !== 'string' || !data.source.trim())
          fail('payload carries no source provenance');
        const age = input.now - data.asOf,
          allowed = Math.max(
            input.intent.need.desiredFreshnessMs,
            input.intent.offer.quoteExpirationMs,
          );
        if (!Number.isFinite(age) || age < 0)
          fail('payload timestamp is not a usable point-in-time value');
        else if (age > allowed)
          fail(
            `payload is stale by ${Math.round(age / 1000)}s (limit ${Math.round(allowed / 1000)}s)`,
          );
        if (input.intent.offer.responseSchema === 'liquidity-v1') {
          const liquidity = result.data as z.infer<typeof liquiditySchema>;
          if (
            liquidity.impact.some(
              (sample) =>
                sample.sellBps > 0 &&
                sample.buyBps > 0 &&
                sample.buyBps > sample.sellBps * 10,
            )
          )
            fail('impact figures are internally inconsistent');
        }
      }
    }
  }

  return {
    state: hardFailure ? 'VALIDATION_FAILED' : 'VALIDATED',
    reasons,
    digest,
    normalized: hardFailure ? null : parsed,
    injectionFindings,
    attestation:
      'Deterministic validation only. A validated payload is well-formed, correctly sourced and fresh; it is not certified true, and a failed validation never reverses a settled payment.',
  };
}
