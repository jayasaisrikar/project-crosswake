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
import type { FundingEvent, Market } from '../../market-data/src/klines.js';

const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
export const barDir = (root: string, symbol: string, market: Market = 'spot') =>
  join(
    root,
    'bars',
    'venue=binance',
    `market=${market}`,
    'interval=1m',
    `symbol=${symbol}`,
  );
export const fundingDir = (root: string, symbol: string) =>
  join(root, 'funding', 'venue=binance', 'market=usdm', `symbol=${symbol}`);
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
  market: Market = 'spot',
) {
  if (!bars.length) throw new Error('Refusing to write an empty bar period');
  const dir = barDir(root, symbol, market),
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
  market: Market = 'spot',
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
        names = (await readdir(barDir(root, symbol, market))).filter((n) =>
          n.endsWith('.parquet'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const files: string[] = [],
        spans: [number, number][] = [];
      for (const name of names.sort()) {
        const path = join(barDir(root, symbol, market), name),
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
      .update(
        JSON.stringify(
          market === 'spot'
            ? { startTs, endTs, provenance }
            : { market, startTs, endTs, provenance },
        ),
      )
      .digest('hex'),
  };
}

export interface FundingManifest {
  schemaVersion: 1;
  symbol: string;
  period: string;
  rows: number;
  sha256: string;
  firstTs: number;
  lastTs: number;
  source: { url: string; sha256: string | null };
}
/** Writes funding events for one period as JSON with a hash manifest. */
export async function writeFundingPeriod(
  root: string,
  symbol: string,
  period: string,
  events: FundingEvent[],
  source: FundingManifest['source'],
) {
  if (!events.length) throw new Error('Refusing to write empty funding');
  const dir = fundingDir(root, symbol),
    final = join(dir, `period=${period}.json`),
    body = JSON.stringify(events);
  await mkdir(dir, { recursive: true });
  await writeFile(final + '.tmp', body);
  await rename(final + '.tmp', final);
  const manifest: FundingManifest = {
    schemaVersion: 1,
    symbol,
    period,
    rows: events.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    firstTs: events[0]!.ts,
    lastTs: events.at(-1)!.ts,
    source,
  };
  await writeFile(
    final + '.manifest.json.tmp',
    JSON.stringify(manifest, null, 2),
  );
  await rename(final + '.manifest.json.tmp', final + '.manifest.json');
  return manifest;
}
/** Verified funding events in [startTs, endTs) per symbol; overlapping periods are rejected. */
export async function loadFunding(
  root: string,
  symbols: string[],
  startTs: number,
  endTs: number,
) {
  const book = new Map<string, FundingEvent[]>(),
    provenance: { symbol: string; period: string; sha256: string }[] = [];
  for (const symbol of symbols) {
    let names: string[] = [];
    try {
      names = (await readdir(fundingDir(root, symbol))).filter(
        (n) => n.endsWith('.json') && !n.endsWith('.manifest.json'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const events: FundingEvent[] = [];
    for (const name of names.sort()) {
      const path = join(fundingDir(root, symbol), name);
      let manifest: FundingManifest;
      try {
        manifest = JSON.parse(await readFile(path + '.manifest.json', 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (manifest.lastTs < startTs || manifest.firstTs >= endTs) continue;
      const body = await readFile(path, 'utf8');
      if (createHash('sha256').update(body).digest('hex') !== manifest.sha256)
        throw new Error(`Funding checksum mismatch: ${path}`);
      provenance.push({
        symbol,
        period: manifest.period,
        sha256: manifest.sha256,
      });
      events.push(
        ...(JSON.parse(body) as FundingEvent[]).filter(
          (e) => e.ts >= startTs && e.ts < endTs,
        ),
      );
    }
    events.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < events.length; i++)
      if (events[i]!.ts === events[i - 1]!.ts)
        throw new Error(`Overlapping funding periods for ${symbol}`);
    book.set(symbol, events);
  }
  return { book, provenance };
}
