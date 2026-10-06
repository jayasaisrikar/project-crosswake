import { parseArchiveTrade } from '../packages/market-data/src/history.js';
import { describe, it, expect } from 'vitest';
import {
  epochMs,
  parseTrade,
  parseQuote,
  type Trade,
} from '../packages/domain/src/index.js';
import { Aggregator } from '../packages/market-data/src/aggregator.js';
import { ParquetWriter } from '../packages/storage/src/index.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
const start = 1700000000000;
const trade = (
  id: number,
  ts = start + 100,
  price = 10,
  maker = false,
): Trade => ({
  kind: 'trade',
  symbol: 'BTCUSDT',
  id,
  ts,
  receivedAt: ts + 10,
  price,
  quantity: 2,
  buyerMaker: maker,
});
describe('ingestion', () => {
  it('uses fresh quotes as live coverage without inventing trades or OHLC', () => {
    const a = new Aggregator(['BTCUSDT'], start);
    a.quote({
      kind: 'quote',
      symbol: 'BTCUSDT',
      bid: 9,
      ask: 11,
      ts: start + 500,
      clock: 'receipt',
    });
    expect(a.flush(start + 1000)[0]).toMatchObject({
      isComplete: true,
      tradeCount: 0,
      quoteVolume: 0,
      close: null,
      bestBid: 9,
      bestAsk: 11,
    });
    expect(a.flush(start + 7000).at(-1)?.isComplete).toBe(false);
  });
  it('parses capitalized archive booleans and microseconds', () => {
    expect(
      parseArchiveTrade(`1,10,2,20,${start * 1000},True,True`, 'BTCUSDT'),
    ).toMatchObject({ buyerMaker: true, ts: start, receivedAt: null });
    expect(() =>
      parseArchiveTrade(`1,10,2,20,${start},unknown,True`, 'BTCUSDT'),
    ).toThrow();
  });
  it('invalidates partial startup and reconnect intervals', () => {
    const a = new Aggregator(['BTCUSDT'], start + 5, 0, true);
    a.trade(trade(1));
    expect(a.flush(start + 1000)[0]?.isComplete).toBe(false);
    a.invalidate(start + 1100, start + 1200);
    a.trade(trade(2, start + 1500));
    expect(a.flush(start + 2000)[0]?.isComplete).toBe(false);
  });
  it('carries only past quotes when newer buckets are pending', () => {
    const a = new Aggregator(['BTCUSDT'], start);
    a.quote({
      kind: 'quote',
      symbol: 'BTCUSDT',
      bid: 9,
      ask: 11,
      ts: start + 50,
      clock: 'receipt',
    });
    a.trade(trade(1));
    a.quote({
      kind: 'quote',
      symbol: 'BTCUSDT',
      bid: 19,
      ask: 21,
      ts: start + 2050,
      clock: 'receipt',
    });
    a.trade(trade(2, start + 1100));
    const rows = a.flush(start + 2000);
    expect(rows[1]?.bestBid).toBe(9);
  });

  it('normalizes archive clocks and rejects corrupt payloads', () => {
    expect(epochMs(start * 1000)).toBe(start);
    expect(epochMs(start)).toBe(start);
    expect(() =>
      parseTrade(
        { s: 'BTCUSDT', t: 1, T: start, p: '0', q: '1', m: false },
        start,
      ),
    ).toThrow();
    expect(() =>
      parseQuote({ s: 'BTCUSDT', b: '11', a: '10' }, start),
    ).toThrow();
  });
  it('deduplicates, respects close boundary and preserves flow', () => {
    const a = new Aggregator(['BTCUSDT'], start);
    a.quote({
      kind: 'quote',
      symbol: 'BTCUSDT',
      bid: 9,
      ask: 11,
      ts: start + 50,
      clock: 'receipt',
    });
    a.trade(trade(1));
    a.trade(trade(1));
    a.trade(trade(2, start + 999, 12, true));
    a.trade(trade(3, start + 1000, 13));
    const [r] = a.flush(start + 1000);
    expect(r).toMatchObject({
      open: 10,
      close: 12,
      tradeCount: 2,
      buyQuoteVolume: 20,
      sellQuoteVolume: 24,
      isComplete: true,
    });
    expect(a.counters.duplicates).toBe(1);
    a.trade(trade(4));
    expect(a.counters.late).toBe(1);
    expect(a.flush(start + 2000)[0]?.tradeCount).toBe(1);
  });
  it('does not fabricate missing prices or historical quotes', () => {
    const a = new Aggregator(['BTCUSDT'], start, 0, true);
    a.trade(trade(1));
    const rows = a.flush(start + 2000);
    expect(rows[0]?.bestBid).toBeNull();
    expect(rows[1]).toMatchObject({ close: null, isComplete: false });
  });
  it('marks disconnected and stale quote buckets incomplete', () => {
    const a = new Aggregator(['BTCUSDT'], start, 100);
    a.quote({
      kind: 'quote',
      symbol: 'BTCUSDT',
      bid: 9,
      ask: 11,
      ts: start + 50,
      clock: 'receipt',
    });
    a.trade(trade(1));
    expect(a.flush(start + 1000, false)[0]?.isComplete).toBe(false);
  });
  it('writes valid Parquet and manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosswake-'));
    const w = await ParquetWriter.create(dir);
    try {
      const a = new Aggregator(['BTCUSDT'], start, 0, true);
      a.trade(trade(1));
      await w.write(a.flush(start + 1000));
      const folder = join(
        dir,
        'normalized/venue=binance/market=spot/date=2023-11-14/symbol=BTCUSDT',
      );
      const names = await readdir(folder);
      expect(names.filter((n) => n.endsWith('.parquet'))).toHaveLength(1);
      const db = await DuckDBInstance.create(':memory:');
      const c = await db.connect();
      try {
        const result = await c.runAndReadAll(
          `SELECT tradeCount FROM read_parquet('${folder}/*.parquet')`,
        );
        expect(result.getRowObjects()[0]?.tradeCount).toBe(1n);
      } finally {
        c.closeSync();
        db.closeSync();
      }
    } finally {
      w.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
