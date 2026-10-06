import { describe, it, expect } from 'vitest';
import { IngestionPipeline } from '../packages/market-data/src/pipeline.js';
import { JournalReplay } from '../packages/market-data/src/journal.js';
import type { JournalRecord } from '../packages/domain/src/journal.js';
import type { Snapshot } from '../packages/domain/src/index.js';
const start = 1700000000000;
const records: JournalRecord[] = [
  {
    kind: 'session',
    ts: start,
    symbols: ['BTCUSDT'],
    quoteMaxAge: 5000,
    latenessMs: 2000,
  },
  { kind: 'connection', ts: start + 50, connected: true },
  {
    kind: 'quote',
    symbol: 'BTCUSDT',
    bid: 9,
    ask: 11,
    ts: start + 1100,
    clock: 'receipt',
  },
  {
    kind: 'trade',
    symbol: 'BTCUSDT',
    id: 1,
    ts: start + 1200,
    receivedAt: start + 1220,
    price: 10,
    quantity: 2,
    buyerMaker: false,
  },
  { kind: 'flush', ts: start + 4000, watermark: start + 2000, connected: true },
  { kind: 'connection', ts: start + 2500, connected: false },
  { kind: 'connection', ts: start + 2800, connected: true },
  {
    kind: 'trade',
    symbol: 'BTCUSDT',
    id: 2,
    ts: start + 2200,
    receivedAt: start + 2850,
    price: 12,
    quantity: 1,
    buyerMaker: true,
  },
  { kind: 'flush', ts: start + 5000, watermark: start + 3000, connected: true },
];
describe('durable replay', () => {
  it('streams long disconnected intervals in bounded batches', () => {
    const replay = new JournalReplay();
    replay.apply(records[0]!);
    let rows = 0,
      largest = 0;
    for (const batch of replay.applyBatches({
      kind: 'flush',
      ts: start + 3600000,
      watermark: start + 3600000,
      connected: false,
    })) {
      rows += batch.length;
      largest = Math.max(largest, batch.length);
      expect(
        batch.every((row) => !row.isComplete && row.tradeCount === 0),
      ).toBe(true);
    }
    expect(rows).toBe(3600);
    expect(largest).toBeLessThanOrEqual(60);
  });
  it('allows initial closure before session start while lateness warms up', () => {
    const replay = new JournalReplay();
    replay.apply(records[0]!);
    expect(
      replay.apply({
        kind: 'flush',
        ts: start + 1000,
        watermark: start - 1000,
        connected: false,
      }),
    ).toEqual([]);
    expect(
      replay.apply({
        kind: 'flush',
        ts: start + 2000,
        watermark: start,
        connected: false,
      }),
    ).toEqual([]);
    expect(() =>
      replay.apply({
        kind: 'flush',
        ts: start + 3000,
        watermark: start - 1000,
        connected: false,
      }),
    ).toThrow('backwards');
  });
  it('matches persisted live normalization including interrupted buckets', async () => {
    const journal: JournalRecord[] = [],
      live: Snapshot[] = [];
    const p = new IngestionPipeline(
      async (rows) => {
        journal.push(...rows);
      },
      async (rows) => {
        live.push(...rows);
      },
    );
    for (const r of records) p.push(r);
    await p.close();
    const replay = new JournalReplay(),
      recovered = journal.flatMap((r) => replay.apply(r));
    expect(recovered).toEqual(live);
    expect(live[1]).toMatchObject({
      tradeCount: 1,
      isComplete: true,
      quoteTs: start + 1100,
    });
    expect(live[2]?.isComplete).toBe(false);
    expect(JSON.stringify(new JournalReplay())).toBeDefined();
    const again = new JournalReplay();
    expect(records.flatMap((r) => again.apply(r))).toEqual(recovered);
  });
  it('never applies an event when its journal write fails', async () => {
    const p = new IngestionPipeline(
      async () => {
        throw new Error('disk full');
      },
      async () => {
        throw new Error('should not write snapshots');
      },
    );
    p.push(records[0]!);
    await expect(p.close()).rejects.toThrow('disk full');
    expect(() => p.push(records[1]!)).toThrow('disk full');
    expect(p.diagnostics.failed).toBe(true);
  });
  it('fails instead of dropping data when backlog exceeds capacity', async () => {
    let release!: () => void;
    const p = new IngestionPipeline(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      async () => {},
      1,
      1,
    );
    p.push(records[0]!);
    p.push(records[1]!);
    expect(() => p.push(records[2]!)).toThrow('capacity');
    release();
    await expect(p.close()).rejects.toThrow('capacity');
  });
  it('rejects legacy journals that cannot reproduce closure timing', () => {
    expect(() => new JournalReplay().apply(records[2]!)).toThrow('session');
  });
});
