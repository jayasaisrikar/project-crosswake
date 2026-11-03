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

const TIMEOUT_MS = 8000;
const ATTEMPTS = 2;

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
