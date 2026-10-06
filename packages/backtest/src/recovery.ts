import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ShadowRuntime, type ShadowEvent } from './shadow.js';
import type { StrategyConfig } from '../../signals/src/index.js';
import { journalSchema } from '../../domain/src/journal.js';
import { JournalReplay } from '../../market-data/src/journal.js';
export const sessionRefSchema = z
  .object({ journal: z.string(), ledger: z.string() })
  .strict();
export type SessionRef = z.infer<typeof sessionRefSchema>;
async function approvedPath(root: string, path: string) {
  const [base, target] = await Promise.all([realpath(root), realpath(path)]),
    rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Paper recovery path escapes data root');
  return target;
}
async function* groups(path: string) {
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  let group: ShadowEvent[] = [];
  try {
    for await (const line of lines) {
      const event = JSON.parse(line) as ShadowEvent;
      if (event.kind === 'session' || event.kind === 'session_end') continue;
      if (event.kind === 'step' && group.length) {
        yield group;
        group = [];
      }
      if (!group.length && event.kind !== 'step')
        throw new Error('Paper ledger has no step boundary');
      group.push(event);
    }
    if (group.length) yield group;
  } finally {
    lines.close();
  }
}
const digest = (events: ShadowEvent[]) =>
  createHash('sha256')
    .update(events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    .digest('hex');
/** Restore quant history and paper positions from durable acknowledged steps, not an approximate checkpoint. */
export async function restoreShadow(
  config: StrategyConfig,
  emit: (events: ShadowEvent[]) => Promise<void>,
  root: string,
  sessions: SessionRef[],
  liveClock: () => number = Date.now,
) {
  let recovering = true,
    clock = 0,
    observed: ShadowEvent[] = [];
  const runtime = new ShadowRuntime(
    config,
    async (events) => {
      if (recovering) observed = events;
      else await emit(events);
    },
    () => (recovering ? clock : liveClock()),
  );
  let recoveredSteps = 0;
  for (const ref of sessions) {
    const journal = await approvedPath(root, ref.journal),
      ledger = await approvedPath(root, ref.ledger);
    const headerLines = createInterface({
      input: createReadStream(ledger),
      crlfDelay: Infinity,
    });
    const first = await headerLines[Symbol.asyncIterator]().next();
    headerLines.close();
    if (first.done) throw new Error('Empty paper recovery ledger');
    const header = JSON.parse(first.value);
    if (
      header.kind !== 'session' ||
      header.configHash !== runtime.engine.configHash
    )
      throw new Error(
        'Paper recovery configuration changed; use a new data directory for a new strategy',
      );
    const source = groups(ledger)[Symbol.asyncIterator]();
    let next = await source.next();
    const replay = new JournalReplay(),
      lines = createInterface({
        input: createReadStream(journal),
        crlfDelay: Infinity,
      });
    try {
      for await (const line of lines)
        for (const rows of replay.applyBatches(
          journalSchema.parse(JSON.parse(line)),
        )) {
          let batch: typeof rows = [];
          const apply = async () => {
            if (!batch.length || next.done) return;
            const expectedTs = z
              .number()
              .int()
              .positive()
              .parse(next.value[0]!.ts);
            if (batch[0]!.ts < expectedTs) return;
            if (batch[0]!.ts !== expectedTs)
              throw new Error('Recovery journal/ledger clock mismatch');
            clock = z
              .number()
              .int()
              .positive()
              .parse(next.value[0]!.decisionAt);
            await runtime.step(batch);
            if (digest(observed) !== digest(next.value))
              throw new Error(
                'Paper recovery parity mismatch; preserve journals and inspect',
              );
            recoveredSteps++;
            next = await source.next();
          };
          for (const row of rows) {
            if (batch.length && batch[0]!.ts !== row.ts) {
              await apply();
              batch = [];
            }
            batch.push(row);
          }
          await apply();
        }
      if (!next.done)
        throw new Error(
          'Paper recovery journal ended before acknowledged steps',
        );
    } finally {
      lines.close();
      await source.return?.();
    }
  }
  recovering = false;
  return { runtime, recoveredSteps };
}
