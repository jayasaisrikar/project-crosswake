import { parseArchiveTrade } from '../../../packages/market-data/src/history.js';
import {
  downloadArchive,
  dateRange,
} from '../../../packages/market-data/src/archive.js';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import unzipper from 'unzipper';
import { join } from 'node:path';
import { symbolSchema } from '../../../packages/domain/src/index.js';
import { Aggregator } from '../../../packages/market-data/src/aggregator.js';
import { ParquetWriter } from '../../../packages/storage/src/index.js';
const symbol = symbolSchema.parse(process.argv[2] ?? 'BTCUSDT'),
  first = process.argv[3];
if (!first) throw new Error('Usage: pnpm history SYMBOL START_DATE [END_DATE]');
for (const date of dateRange(first, process.argv[4]))
  await importDay(symbol, date);
async function importDay(symbol: string, date: string) {
  const root = process.env.DATA_DIR ?? './data',
    dir = join(root, 'archives', symbol),
    name = `${symbol}-trades-${date}.zip`,
    dest = join(dir, name),
    url = `https://data.binance.vision/data/spot/daily/trades/${symbol}/${name}`,
    done = dest + '.import.json',
    lock = dest + '.lock';
  await mkdir(dir, { recursive: true });
  await mkdir(lock).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error(
        `Import lock exists: ${lock}. Inspect the running importer before removing a stale lock.`,
      );
    throw error;
  });
  try {
    const expected = await downloadArchive(url, dest);
    let marker: { sha256?: string } | undefined;
    try {
      marker = JSON.parse(await readFile(done, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (marker?.sha256 === expected) {
      console.log({ symbol, date, status: 'already_imported' });
      return;
    }
    const staging = join(root, 'staging', symbol + '-' + date);
    await rm(staging, { recursive: true, force: true });
    const start = Date.parse(date),
      agg = new Aggregator([symbol], start, 0, true),
      writer = await ParquetWriter.create(staging);
    let n = 0,
      lastTs = start,
      lastId = -1;
    const buffer: ReturnType<Aggregator['flush']> = [];
    async function flush(watermark: number) {
      for (const rows of agg.flushBatches(watermark)) {
        buffer.push(...rows);
        if (buffer.length >= 3600) {
          await writer.write(buffer);
          buffer.length = 0;
        }
      }
    }
    try {
      const zip = await unzipper.Open.file(dest),
        entry = zip.files.find((f) => f.path.endsWith('.csv'));
      if (!entry) throw new Error('No CSV entry');
      for await (const line of createInterface({
        input: entry.stream(),
        crlfDelay: Infinity,
      })) {
        if (line.startsWith('id,')) continue;
        const trade = parseArchiveTrade(line, symbol);
        if (
          trade.ts < start ||
          trade.ts >= start + 86400000 ||
          trade.ts < lastTs ||
          trade.id <= lastId
        )
          throw new Error('Archive date/order/duplicate violation');
        if (Math.floor(trade.ts / 1000) > Math.floor(lastTs / 1000)) {
          await flush(trade.ts);
        }
        agg.trade(trade);
        lastTs = trade.ts;
        lastId = trade.id;
        n++;
      }
      await flush(start + 86400000);
      await writer.write(buffer);
      const source = join(
          staging,
          'normalized/venue=binance/market=spot',
          `date=${date}`,
          `symbol=${symbol}`,
        ),
        target = join(
          root,
          'normalized/venue=binance/market=spot',
          `date=${date}`,
          `symbol=${symbol}`,
          'historical',
        );
      await mkdir(join(target, '..'), { recursive: true });
      // The import lock prevents competing replacement; existing version is retained until new data is ready.
      const backup = target + '.previous';
      await rm(backup, { recursive: true, force: true });
      let hadPrevious = false;
      try {
        await rename(target, backup);
        hadPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await rename(source, target);
      } catch (error) {
        if (hadPrevious) await rename(backup, target);
        throw error;
      }
      await writeFile(
        done + '.tmp',
        JSON.stringify(
          {
            symbol,
            date,
            url,
            sha256: expected,
            trades: n,
            quoteEvidence: false,
            schemaVersion: 2,
          },
          null,
          2,
        ),
      );
      await rename(done + '.tmp', done);
      await rm(backup, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      console.log({ symbol, date, trades: n, quoteEvidence: false });
    } finally {
      writer.close();
    }
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
