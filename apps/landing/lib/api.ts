import { signalLogBase } from './site';

export function apiBase() {
  const explicit = process.env.RESEARCH_API_BASE;
  if (!explicit) return null;
  try {
    const url = new URL(explicit);
    if (url.protocol === 'http:' || url.protocol === 'https:')
      return url.origin;
  } catch {
    return null;
  }
  return null;
}

/**
 * The record is served through a best-effort public tunnel whose handshake has been measured
 * anywhere from 0.06s to 90s. Pages that read it are revalidated in the background, so a slow
 * read costs a regeneration, not a visitor; the timeout is set to outlast the slow handshake.
 */
const TIMEOUT_MS = 25_000;
const ATTEMPTS = 2;

/** The public mirror of the record, on a CDN; the evidence API is the fallback. */
export const mirrorBase = () =>
  (process.env.RECORD_MIRROR_BASE ?? signalLogBase)?.replace(/\/+$/, '') ??
  null;

async function readUrl<T>(
  url: string,
  revalidate: number,
  shape: (value: unknown) => boolean,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      next: { revalidate },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return shape(payload) ? (payload as T) : null;
  } catch {
    return null;
  }
}

/**
 * Reads a record route from the public mirror, then from the evidence API. The mirror is a
 * static copy published to the signal-log repository, so a slow or unreachable tunnel no
 * longer empties a page; the API stays the authoritative read when it answers.
 */
export async function readRecord<T>(
  mirrorPath: string,
  apiPath: string,
  revalidate: number,
  shape: (value: unknown) => boolean,
): Promise<T | null> {
  const base = mirrorBase();
  if (base) {
    const mirrored = await readUrl<T>(
      `${base}${mirrorPath}`,
      revalidate,
      shape,
    );
    if (mirrored) return mirrored;
  }
  return readJson<T>(apiPath, revalidate, shape);
}

/**
 * Reads one JSON route from the evidence API. A null means the record could not be read,
 * which callers must show as such rather than as an empty record.
 */
export async function readJson<T>(
  path: string,
  revalidate: number,
  shape: (value: unknown) => boolean,
): Promise<T | null> {
  const base = apiBase(),
    token = process.env.RESEARCH_API_TOKEN;
  if (!base || !token) return null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        next: { revalidate },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = await response.json();
        if (shape(payload)) return payload as T;
        return null;
      }
      if (response.status < 500) return null;
    } catch {
      continue;
    }
  }
  return null;
}
