import { DuckDBInstance } from '@duckdb/node-api';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sha256File } from '../../market-data/src/archive.js';
import { BarStore, MINUTE, type Bar } from '../../quant/src/residual.js';

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
export const barDir = (root: string, symbol: string) =>
  join(
    root,
    'bars',
    'venue=binance',
    'market=spot',
    'interval=1m',
    `symbol=${symbol}`,
  );
export interface BarManifest {
  schemaVersion: 1;
  symbol: string;
  period: string;
  rows: number;
  sha256: string;
  firstTs: number;
  lastTs: number;
  source: { url: string; sha256: string };
}
/** Writes one verified archive period as Parquet with a hash manifest, replacing it atomically. */
export async function writeBarPeriod(
  root: string,
  symbol: string,
  period: string,
  bars: Bar[],
  source: BarManifest['source'],
) {
  if (!bars.length) throw new Error('Refusing to write an empty bar period');
  const dir = barDir(root, symbol),
    id = randomUUID(),
    json = join(dir, `${id}.json.tmp`),
    temp = join(dir, `${id}.parquet.tmp`),
    final = join(dir, `period=${period}.parquet`);
  await mkdir(dir, { recursive: true });
  await writeFile(json, bars.map((b) => JSON.stringify(b)).join('\n') + '\n');
  const instance = await DuckDBInstance.create(':memory:'),
    conn = await instance.connect();
  try {
    await conn.run(
      `COPY (SELECT * FROM read_json_auto(${literal(json)}, format='newline_delimited', columns={ts:'BIGINT',open:'DOUBLE',high:'DOUBLE',low:'DOUBLE',close:'DOUBLE',quoteVolume:'DOUBLE'}) ORDER BY ts) TO ${literal(temp)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
    await rm(json, { force: true });
  }
  const manifest: BarManifest = {
    schemaVersion: 1,
    symbol,
    period,
    rows: bars.length,
    sha256: await sha256File(temp),
    firstTs: bars[0]!.ts,
    lastTs: bars.at(-1)!.ts,
    source,
  };
  await rename(temp, final);
  await writeFile(
    final + '.manifest.json.tmp',
    JSON.stringify(manifest, null, 2),
  );
  await rename(final + '.manifest.json.tmp', final + '.manifest.json');
  return manifest;
}
export async function readBarManifest(path: string) {
  try {
    return JSON.parse(
      await readFile(path + '.manifest.json', 'utf8'),
    ) as BarManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/**
 * Loads verified 1m bars for [startTs, endTs) into an aligned store. Every
 * file overlapping the range is checksum-verified; overlapping periods for
 * one symbol are rejected rather than silently merged.
 */
export async function loadBarStore(
  root: string,
  symbols: string[],
  startTs: number,
  endTs: number,
) {
  if (startTs % MINUTE || endTs % MINUTE || startTs >= endTs)
    throw new Error('Bar range must be increasing whole minutes');
  const store = new BarStore(startTs, symbols, (endTs - startTs) / MINUTE),
    provenance: { symbol: string; period: string; sha256: string }[] = [],
    instance = await DuckDBInstance.create(':memory:', { memory_limit: '1GB' }),
    conn = await instance.connect();
  try {
    for (const symbol of symbols) {
      let names: string[] = [];
      try {
        names = (await readdir(barDir(root, symbol))).filter((n) =>
          n.endsWith('.parquet'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const files: string[] = [],
        spans: [number, number][] = [];
      for (const name of names.sort()) {
        const path = join(barDir(root, symbol), name),
          manifest = await readBarManifest(path);
        if (!manifest || manifest.symbol !== symbol) continue;
        if (manifest.lastTs < startTs || manifest.firstTs >= endTs) continue;
        if (
          spans.some(([a, b]) => manifest.firstTs <= b && manifest.lastTs >= a)
        )
          throw new Error(`Overlapping bar periods for ${symbol}: ${name}`);
        if ((await sha256File(path)) !== manifest.sha256)
          throw new Error(`Bar checksum mismatch: ${path}`);
        spans.push([manifest.firstTs, manifest.lastTs]);
        files.push(path);
        provenance.push({
          symbol,
          period: manifest.period,
          sha256: manifest.sha256,
        });
      }
      if (!files.length)
        throw new Error(`No verified bars for ${symbol} in range`);
      const result = await conn.runAndReadAll(
        `SELECT ts, close, quoteVolume FROM read_parquet([${files.map(literal).join(',')}]) WHERE ts >= ${startTs} AND ts < ${endTs} ORDER BY ts`,
      );
      const [ts, close, volume] = result.getColumnsJS() as [
        bigint[],
        number[],
        number[],
      ];
      for (let i = 0; i < ts.length; i++)
        store.set(symbol, {
          ts: Number(ts[i]),
          close: close[i]!,
          quoteVolume: volume[i]!,
        });
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  provenance.sort((a, b) =>
    (a.symbol + a.period).localeCompare(b.symbol + b.period),
  );
  return {
    store,
    provenance,
    datasetHash: createHash('sha256')
      .update(JSON.stringify({ startTs, endTs, provenance }))
      .digest('hex'),
  };
}
