import { parseArgs } from 'node:util';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { journalSchema } from '../../../packages/domain/src/journal.js';
import { JournalReplay } from '../../../packages/market-data/src/journal.js';
import { strategySchema } from '../../../packages/signals/src/index.js';
import {
  restoreShadow,
  sessionRefSchema,
} from '../../../packages/backtest/src/recovery.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((v) => v !== '--'),
  options: {
    journal: { type: 'string' },
    ledger: { type: 'string' },
    output: { type: 'string' },
  },
});
if (!values.journal || !values.ledger || !values.output)
  throw new Error(
    'Usage: pnpm paper:replay -- --journal MARKET_JOURNAL --ledger PAPER_LEDGER --output NEW_DIRECTORY',
  );
await mkdir(values.output, { recursive: false });
const source = createInterface({
    input: createReadStream(values.ledger),
    crlfDelay: Infinity,
  }),
  iterator = source[Symbol.asyncIterator](),
  first = await iterator.next();
if (first.done) throw new Error('Empty paper ledger');
const session = z
  .object({
    kind: z.literal('session'),
    marketJournal: z.string(),
    config: strategySchema,
    configHash: z.string(),
    executionEnabled: z.literal(false),
    previousSessions: z.array(sessionRefSchema).optional(),
  })
  .parse(JSON.parse(first.value));
if (resolve(session.marketJournal) !== resolve(values.journal))
  throw new Error('Ledger and market journal provenance mismatch');
let clock = 0;
const observed = createHash('sha256'),
  recovered = createHash('sha256');
let sourceSteps = 0,
  replayedSteps = 0;
const output = join(values.output, 'replayed.jsonl');
const { runtime } = await restoreShadow(
  session.config,
  async (events) => {
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    recovered.update(text);
    await appendFile(output, text);
  },
  resolve(dirname(values.journal), '..'),
  session.previousSessions ?? [],
  () => clock,
);
if (runtime.engine.configHash !== session.configHash)
  throw new Error('Paper config provenance mismatch');
async function nextStep(): Promise<{ ts: number; decisionAt: number } | null> {
  for (;;) {
    const item = await iterator.next();
    if (item.done) return null;
    const event = JSON.parse(item.value) as {
      kind: string;
      ts: number;
      decisionAt: number;
    };
    if (event.kind === 'session_end') continue;
    observed.update(JSON.stringify(event) + '\n');
    if (event.kind === 'step') {
      sourceSteps++;
      return z
        .object({
          ts: z.number().int().positive(),
          decisionAt: z.number().int().positive(),
        })
        .parse(event);
    }
  }
}
try {
  const replay = new JournalReplay();
  for await (const line of createInterface({
    input: createReadStream(values.journal),
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    for (const rows of replay.applyBatches(
      journalSchema.parse(JSON.parse(line)),
    )) {
      let batch: typeof rows = [];
      for (const row of rows) {
        if (batch.length && batch[0]!.ts !== row.ts) {
          const step = await nextStep();
          if (!step || step.ts !== batch[0]!.ts)
            throw new Error('Missing or misaligned paper delivery clock');
          clock = step.decisionAt;
          await runtime.step(batch);
          replayedSteps++;
          batch = [];
        }
        batch.push(row);
      }
      if (batch.length) {
        const step = await nextStep();
        if (!step || step.ts !== batch[0]!.ts)
          throw new Error('Missing or misaligned paper delivery clock');
        clock = step.decisionAt;
        await runtime.step(batch);
        replayedSteps++;
      }
    }
  }
  if (await nextStep())
    throw new Error(
      'Paper ledger contains additional steps beyond market journal',
    );
  const expected = observed.digest('hex'),
    actual = recovered.digest('hex');
  if (expected !== actual)
    throw new Error('Live paper and replay output differ');
  await writeFile(
    join(values.output, 'parity.json'),
    JSON.stringify(
      {
        identical: true,
        sourceSteps,
        replayedSteps,
        derivedSha256: actual,
        diagnostics: runtime.diagnostics,
      },
      null,
      2,
    ),
  );
  console.log({
    identical: true,
    sourceSteps,
    replayedSteps,
    derivedSha256: actual,
  });
} catch (error) {
  await writeFile(join(values.output, 'FAILED'), String(error));
  throw error;
} finally {
  source.close();
}
