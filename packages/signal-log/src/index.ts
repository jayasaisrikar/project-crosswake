/**
 * Append-only, hash-chained signal log. Each entry's hash covers its own fields and the
 * previous entry's hash, so editing, reordering or deleting any published entry breaks
 * every hash after it. Uses Web Crypto so the same code verifies in Node and the browser.
 */
export const GENESIS = '0'.repeat(64);

export interface SignalLogFields {
  seq: number;
  version: string;
  id: string;
  kind: 'entry' | 'exit';
  symbol: string;
  /** Daily close that produced the decision (ms). */
  decidedAt: number;
  /** Bar whose open is the assumed fill (ms). */
  fillAt: number;
  /** Reference price quoted in the alert. */
  price: number;
  netBps?: number;
  reason?: string;
  /** When the entry was appended, i.e. when the signal went out (ms). */
  publishedAt: number;
  /** True for signals sent before the log existed; appended later, honestly marked. */
  backfill?: boolean;
  prevHash: string;
}
export interface SignalLogEntry extends SignalLogFields {
  hash: string;
}

const ORDER: (keyof SignalLogFields)[] = [
  'seq',
  'version',
  'id',
  'kind',
  'symbol',
  'decidedAt',
  'fillAt',
  'price',
  'netBps',
  'reason',
  'publishedAt',
  'backfill',
  'prevHash',
];

/** Canonical encoding: fixed key order, absent optional fields omitted. */
export function canonical(f: SignalLogFields): string {
  const o: Record<string, unknown> = {};
  for (const k of ORDER) if (f[k] !== undefined) o[k] = f[k];
  return JSON.stringify(o);
}

export async function hashFields(f: SignalLogFields): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(f));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function nextEntry(
  log: SignalLogEntry[],
  f: Omit<SignalLogFields, 'seq' | 'prevHash'>,
): Promise<SignalLogEntry> {
  const last = log.at(-1);
  const fields: SignalLogFields = {
    ...f,
    seq: (last?.seq ?? 0) + 1,
    prevHash: last?.hash ?? GENESIS,
  };
  return { ...fields, hash: await hashFields(fields) };
}

export type Verification =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; brokenAt: number; problem: string };

export async function verify(log: SignalLogEntry[]): Promise<Verification> {
  let prev = GENESIS;
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    const fail = (problem: string): Verification => ({
      ok: false,
      count: log.length,
      brokenAt: e.seq ?? i + 1,
      problem,
    });
    if (e.seq !== i + 1) return fail(`expected seq ${i + 1}, found ${e.seq}`);
    if (e.prevHash !== prev) return fail('prevHash does not match the previous entry');
    const { hash, ...fields } = e;
    if ((await hashFields(fields)) !== hash) return fail('entry contents do not match its hash');
    prev = hash;
  }
  return { ok: true, count: log.length, head: prev };
}

export function parseLog(text: string): SignalLogEntry[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SignalLogEntry);
}

/** Short fingerprint shown in Telegram posts and on the site. */
export const fingerprint = (hash: string) => hash.slice(0, 12);
