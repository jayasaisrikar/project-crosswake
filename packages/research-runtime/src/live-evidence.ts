import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { latestContext } from '../../context/src/index.js';
/** Stream the ledger with bounded retained output; never return arbitrary local files. */
export async function liveEvidence(root: string, limit = 100) {
  let health: Record<string, unknown> | null = null;
  try {
    health = JSON.parse(
      await readFile(join(root, 'collector-health.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const events: Record<string, unknown>[] = [],
    counts: Record<string, number> = {};
  if (typeof health?.paperPath === 'string') {
    const base = await realpath(root),
      path = await realpath(health.paperPath),
      rel = relative(base, path);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Ledger path outside data root');
    // Freeze the byte boundary. Ignore only an incomplete trailing append, never interior corruption.
    const size = (await stat(path)).size;
    const stream = createReadStream(path, { end: Math.max(0, size - 1) });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    let consumed = 0;
    for await (const line of lines) {
      consumed += Buffer.byteLength(line) + 1;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        if (consumed > size) break;
        throw new Error('Paper ledger integrity failure');
      }
      if (
        ['candidate', 'trade', 'entry_rejection', 'entry'].includes(
          String(event.kind),
        )
      ) {
        counts[String(event.kind)] = (counts[String(event.kind)] ?? 0) + 1;
        events.push(event);
        if (events.length > limit) events.shift();
      }
    }
  }
  return {
    health,
    events: events.reverse(),
    counts,
    context: await latestContext(root),
    researchStatus: 'UNVALIDATED',
    executionEnabled: false,
  };
}
