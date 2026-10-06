import { z } from 'zod';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const requestSchema = z
  .object({
    symbols: z
      .array(z.string().regex(/^[A-Z0-9]{2,20}$/))
      .min(1)
      .max(100),
    displayType: z
      .array(
        z.enum([
          'MARKET_CAP',
          'RSI14',
          'MACD',
          'MACD_SIGNAL_LINE',
          'SUPPORT',
          'RESISTANCE',
        ]),
      )
      .min(1),
    timeInterval: z.enum(['DAILY', 'HOURS4']),
  })
  .strict();
// Official paged screener contract; retain extra provider fields without inventing indicator values.
const screenerPageSchema = z
  .object({
    content: z
      .array(
        z
          .object({
            symbol: z.string().min(1),
            name: z.string().optional(),
            lastPrice: z.string().optional(),
            additionalData: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
      )
      .max(100),
    totalElements: z.number().int().nonnegative().optional(),
    totalPages: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export const contextSchema = z
  .object({
    provider: z.literal('altFINS'),
    retrievedAt: z.number().int().positive(),
    availableAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    request: requestSchema,
    payload: z.unknown(),
    payloadHash: z.string().length(64),
  })
  .strict();
export type ContextSnapshot = z.infer<typeof contextSchema>;
export const payloadHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Receipt-time availability is authoritative; retroactive API data never becomes historical point-in-time evidence. */
export async function fetchContext(
  key: string,
  symbols: string[],
  fetcher: typeof fetch = fetch,
  clock = Date.now,
): Promise<ContextSnapshot> {
  if (!key.trim()) throw new Error('ALTFINS_API_KEY is not configured');
  const request = requestSchema.parse({
    symbols,
    displayType: ['MARKET_CAP', 'RSI14', 'MACD', 'MACD_SIGNAL_LINE'],
    timeInterval: 'HOURS4',
  });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetcher(
      'https://altfins.com/api/v2/public/screener-data/search-requests?page=0&size=100',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-API-KEY': key,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  if (!response?.ok)
    throw new Error(
      `altFINS request failed with HTTP ${response?.status ?? 'unavailable'}`,
    );
  const text = await response.text();
  if (text.length > 2000000)
    throw new Error('altFINS response exceeds bounded context size');
  const payload: unknown = JSON.parse(text);
  if (!screenerPageSchema.safeParse(payload).success)
    throw new Error(
      'altFINS response does not match the paged screener contract',
    );
  const availableAt = clock();
  return contextSchema.parse({
    provider: 'altFINS',
    retrievedAt: availableAt,
    availableAt,
    expiresAt: availableAt + 15 * 60 * 1000,
    request,
    payload,
    payloadHash: payloadHash(payload),
  });
}
export async function persistContext(root: string, snapshot: ContextSnapshot) {
  const folder = join(root, 'context', 'altfins');
  await mkdir(folder, { recursive: true });
  const text = JSON.stringify(contextSchema.parse(snapshot), null, 2);
  await writeFile(
    join(
      folder,
      `${snapshot.availableAt}-${snapshot.payloadHash.slice(0, 12)}.json`,
    ),
    text,
    { flag: 'wx' },
  );
  const temp = join(folder, `latest.${randomUUID()}.tmp`);
  await writeFile(temp, text);
  await rename(temp, join(folder, 'latest.json'));
}
export function contextAt(snapshot: ContextSnapshot, decisionTs: number) {
  if (payloadHash(snapshot.payload) !== snapshot.payloadHash)
    throw new Error('altFINS context integrity mismatch');
  if (snapshot.availableAt > decisionTs)
    return { status: 'not_yet_available', snapshot: null };
  if (snapshot.expiresAt < decisionTs)
    return { status: 'stale', snapshot: null };
  return { status: 'available', snapshot };
}
export async function latestContext(root: string, clock = Date.now) {
  try {
    const value = contextSchema.parse(
      JSON.parse(
        await readFile(join(root, 'context', 'altfins', 'latest.json'), 'utf8'),
      ),
    );
    return contextAt(value, clock());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'unavailable', snapshot: null };
    throw error;
  }
}
