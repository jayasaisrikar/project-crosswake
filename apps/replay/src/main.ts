import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { journalSchema } from '../../../packages/domain/src/journal.js';
import { JournalReplay } from '../../../packages/market-data/src/journal.js';
import { ParquetWriter } from '../../../packages/storage/src/index.js';
const input = process.argv[2],
  output = process.argv[3];
if (!input || !output)
  throw new Error('Usage: pnpm replay JOURNAL OUTPUT_DIRECTORY');
if (resolve(output) === resolve(process.env.DATA_DIR ?? './data'))
  throw new Error('Replay output must be separate from live data');
await mkdir(output, { recursive: false });
const writer = await ParquetWriter.create(output),
  replay = new JournalReplay(),
  hash = createHash('sha256');
let records = 0,
  rows = 0;
const buffer: ReturnType<JournalReplay['apply']> = [];
try {
  for await (const line of createInterface({
    input: createReadStream(input),
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    const record = journalSchema.parse(JSON.parse(line));
    records++;
    for (const snapshots of replay.applyBatches(record)) {
      for (const snapshot of snapshots) {
        hash.update(JSON.stringify(snapshot) + '\n');
        rows++;
      }
      buffer.push(...snapshots);
      if (buffer.length >= 3600) {
        await writer.write(buffer);
        buffer.length = 0;
      }
    }
  }
  await writer.write(buffer);
  await writeFile(
    join(output, 'replay-manifest.json'),
    JSON.stringify(
      {
        input: resolve(input),
        records,
        rows,
        normalizedSha256: hash.digest('hex'),
        counters: replay.counters,
        partialTailPolicy: 'Only recorded closed buckets are recovered',
      },
      null,
      2,
    ),
  );
  console.log({ records, rows, ...replay.counters });
} catch (error) {
  await writeFile(join(output, 'FAILED'), String(error));
  throw error;
} finally {
  writer.close();
}
