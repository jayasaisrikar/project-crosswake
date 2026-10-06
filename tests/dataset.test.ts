import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ParquetWriter } from '../packages/storage/src/index.js';
import { openDataset } from '../packages/storage/src/read.js';
import { Aggregator } from '../packages/market-data/src/aggregator.js';
it('rejects overlapping rows rather than multiplying apparent events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosswake-overlap-')),
    writer = await ParquetWriter.create(dir);
  try {
    const a = new Aggregator(['BTCUSDT'], 1700000000000, 0, true),
      rows = a.flush(1700000001000);
    await writer.write(rows);
    await writer.write(rows);
    const dataset = await openDataset(dir, 'live');
    await expect(
      (async () => {
        for await (const batch of dataset.batches()) void batch;
      })(),
    ).rejects.toThrow('Overlapping');
  } finally {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('rejects corrupted Parquet before research starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosswake-corrupt-')),
    writer = await ParquetWriter.create(dir);
  try {
    const a = new Aggregator(['BTCUSDT'], 1700000000000, 0, true);
    await writer.write(a.flush(1700000001000));
    const folder = join(
        dir,
        'normalized/venue=binance/market=spot/date=2023-11-14/symbol=BTCUSDT',
      ),
      file = (await readdir(folder)).find((f) => f.endsWith('.parquet'))!;
    await writeFile(join(folder, file), Buffer.from('corrupt'));
    await expect(openDataset(dir, 'live')).rejects.toThrow('checksum mismatch');
  } finally {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('reuses a fixed dataset snapshot and filters half-open clock ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosswake-ranges-')),
    writer = await ParquetWriter.create(dir);
  try {
    const a = new Aggregator(['BTCUSDT'], 1700000000000, 0, true);
    await writer.write(a.flush(1700000003000));
    const dataset = await openDataset(dir, 'live');
    const counts = [];
    for (let pass = 0; pass < 2; pass++) {
      const rows = [];
      for await (const batch of dataset.batches({
        startTs: 1700000001000,
        endTs: 1700000003000,
      }))
        rows.push(...batch);
      counts.push(rows.map((r) => r.ts));
    }
    expect(counts).toEqual([
      [1700000001000, 1700000002000],
      [1700000001000, 1700000002000],
    ]);
  } finally {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
