import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { z } from 'zod';
import { symbolSchema, type Snapshot } from '../../domain/src/index.js';
import { sha256File } from '../../market-data/src/archive.js';
const price = z.number().positive().nullable(),
  volume = z.number().nonnegative();
export const snapshotSchema = z.object({
  ts: z.number().int().positive(),
  symbol: symbolSchema,
  open: price,
  high: price,
  low: price,
  close: price,
  baseVolume: volume,
  quoteVolume: volume,
  buyQuoteVolume: volume,
  sellQuoteVolume: volume,
  tradeCount: z.number().int().nonnegative(),
  bestBid: price,
  bestAsk: price,
  spreadBps: z.number().nonnegative().nullable(),
  sourceLatencyMs: z.number().nullable(),
  isComplete: z.boolean(),
  quoteClock: z.literal('receipt').nullable(),
  availableAt: z.number().int().positive().nullable().optional(),
  quoteTs: z.number().int().positive().nullable().optional(),
});
async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.endsWith('.previous')) yield* walk(path);
    } else if (entry.name.endsWith('.parquet')) yield path;
  }
}
const sqlLiteral = (s: string) => `'${s.replaceAll("'", "''")}'`;
export async function openDataset(
  root: string,
  source: 'live' | 'historical',
  symbols?: string[],
) {
  const paths: string[] = [];
  const provenance: {
    path: string;
    sha256: string;
    firstTs: number;
    lastTs: number;
  }[] = [];
  let firstTs = Infinity,
    lastTs = 0;
  for await (const path of walk(join(root, 'normalized'))) {
    const historical = path.split('/').includes('historical');
    if (historical !== (source === 'historical')) continue;
    if (symbols && !symbols.some((s) => path.includes(`symbol=${s}/`)))
      continue;
    let manifest: { sha256: string; firstTs: number; lastTs: number };
    try {
      manifest = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if ((await sha256File(path)) !== manifest.sha256)
      throw new Error(`Parquet checksum mismatch: ${path}`);
    firstTs = Math.min(firstTs, manifest.firstTs);
    lastTs = Math.max(lastTs, manifest.lastTs);
    paths.push(path);
    provenance.push({
      path,
      sha256: manifest.sha256,
      firstTs: manifest.firstTs,
      lastTs: manifest.lastTs,
    });
  }
  if (!paths.length)
    throw new Error(
      'No committed Parquet files match requested source and symbols',
    );
  paths.sort();
  provenance.sort((a, b) => a.path.localeCompare(b.path));
  const datasetHash = createHash('sha256')
    .update(JSON.stringify(provenance))
    .digest('hex');
  async function* batches(range?: {
    startTs: number;
    endTs: number;
  }): AsyncGenerator<Snapshot[]> {
    if (
      range &&
      (!Number.isSafeInteger(range.startTs) ||
        !Number.isSafeInteger(range.endTs) ||
        range.startTs >= range.endTs)
    )
      throw new Error('Invalid dataset clock range');
    const instance = await DuckDBInstance.create(':memory:', {
        memory_limit: '512MB',
      }),
      connection = await instance.connect();
    try {
      const result = await connection.stream(
        `SELECT * FROM read_parquet([${paths.map(sqlLiteral).join(',')}], union_by_name=true, hive_partitioning=false) ${range ? `WHERE ts >= ${range.startTs} AND ts < ${range.endTs}` : ''} ORDER BY ts, symbol`,
      );
      let batch: Snapshot[] = [];
      let ts = 0;
      let seen = new Set<string>();
      for await (const chunk of result.yieldRowObjects())
        for (const record of chunk) {
          const normalized = Object.fromEntries(
            Object.entries(record).map(([key, value]) => [
              key,
              typeof value === 'bigint' ? Number(value) : value,
            ]),
          );
          const row = snapshotSchema.parse(normalized);
          if (ts && row.ts !== ts) {
            yield batch;
            batch = [];
            seen = new Set();
          }
          ts = row.ts;
          if (seen.has(row.symbol))
            throw new Error(
              `Overlapping ${source} source rows at ${row.symbol}/${row.ts}; choose a nonoverlapping dataset`,
            );
          seen.add(row.symbol);
          batch.push(row);
        }
      if (batch.length) yield batch;
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }
  return { paths, provenance, datasetHash, firstTs, lastTs, batches };
}
