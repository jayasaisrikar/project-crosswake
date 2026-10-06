import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { rename, unlink } from 'node:fs/promises';
export function parseChecksum(text: string, filename: string) {
  const [hash, name] = text.trim().split(/\s+/);
  if (
    !hash ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    name?.replace(/^\*/, '') !== filename
  )
    throw new Error('Invalid archive checksum record');
  return hash.toLowerCase();
}
export async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function retryRequest<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let failure: unknown;
  for (let n = 0; n < attempts; n++) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (error instanceof Error && error.message.startsWith('Permanent HTTP'))
        throw error;
      if (n + 1 < attempts)
        await new Promise((r) => setTimeout(r, 100 * 2 ** n));
    }
  }
  throw failure;
}
export async function downloadArchive(
  url: string,
  destination: string,
  timeoutMs = 120000,
) {
  const filename = new URL(url).pathname.split('/').at(-1)!;
  const checksum = await retryRequest(async () => {
    const response = await fetch(url + '.CHECKSUM', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(
        `${response.status >= 500 || response.status === 429 ? 'Transient' : 'Permanent'} HTTP ${response.status}`,
      );
    return response.text();
  });
  const expected = parseChecksum(checksum, filename);
  try {
    if ((await sha256File(destination)) === expected) return expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await retryRequest(async () => {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body)
      throw new Error(
        `${response.status >= 500 || response.status === 429 ? 'Transient' : 'Permanent'} HTTP ${response.status}`,
      );
    await pipeline(
      Readable.fromWeb(
        response.body as import('node:stream/web').ReadableStream,
      ),
      createWriteStream(destination + '.tmp'),
      { signal },
    );
  });
  if ((await sha256File(destination + '.tmp')) !== expected) {
    await unlink(destination + '.tmp');
    throw new Error('Archive checksum mismatch');
  }
  await rename(destination + '.tmp', destination);
  return expected;
}
export function dateRange(start: string, end = start) {
  const valid = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d)) &&
    new Date(d).toISOString().slice(0, 10) === d;
  if (!valid(start) || !valid(end) || start > end)
    throw new Error('Invalid UTC date range');
  const dates: string[] = [];
  for (let ts = Date.parse(start); ts <= Date.parse(end); ts += 86400000) {
    if (dates.length >= 366) throw new Error('Maximum range is 366 days');
    dates.push(new Date(ts).toISOString().slice(0, 10));
  }
  return dates;
}
