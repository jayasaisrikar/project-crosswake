import { parseArgs } from 'node:util';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { openDataset } from '../../../packages/storage/src/read.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((x) => x !== '--'),
  options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    from: { type: 'string' },
    to: { type: 'string' },
    output: { type: 'string' },
    symbols: {
      type: 'string',
      default: process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT',
    },
  },
});
if (!values.from || !values.to)
  throw new Error('An explicit ISO wall-clock --from and --to are required');
const start = Date.parse(values.from),
  end = Date.parse(values.to);
if (
  !Number.isSafeInteger(start) ||
  !Number.isSafeInteger(end) ||
  start >= end ||
  start % 1000 ||
  end % 1000
)
  throw new Error('Use increasing whole-second ISO clocks');
const dataset = await openDataset(values['data-dir']!, 'live');
const counts = new Map<
  string,
  { rows: number; complete: number; quotes: number; maxLatency: number }
>();
for await (const batch of dataset.batches({ startTs: start, endTs: end }))
  for (const r of batch) {
    const c = counts.get(r.symbol) ?? {
      rows: 0,
      complete: 0,
      quotes: 0,
      maxLatency: 0,
    };
    c.rows++;
    c.complete += Number(r.isComplete);
    c.quotes += Number(r.bestBid !== null);
    c.maxLatency = Math.max(
      c.maxLatency,
      r.availableAt ? r.availableAt - r.ts : 0,
    );
    counts.set(r.symbol, c);
  }
let late = 0,
  rejected = 0,
  peakMemoryBytes = 0,
  healthSamples = 0,
  disconnects = 0;
const symbols = new Set(values.symbols!.split(',').map((s) => s.trim()));
if (symbols.size < 2 || [...symbols].some((s) => !/^[A-Z0-9]{5,20}$/.test(s)))
  throw new Error(
    'Declare at least two valid --symbols for the operations gate',
  );
for (const name of await readdir(join(values['data-dir']!, 'raw'))) {
  if (!name.endsWith('.jsonl')) continue;
  let lastLate = 0,
    lastRejected = 0;
  for await (const line of createInterface({
    input: createReadStream(join(values['data-dir']!, 'raw', name)),
    crlfDelay: Infinity,
  })) {
    const r = JSON.parse(line);
    if (r.ts >= end) continue;
    if (r.ts < start) {
      if (r.kind === 'health') {
        lastLate = r.late;
        lastRejected = r.rejected;
      }
      continue;
    }
    if (r.kind === 'connection' && !r.connected) disconnects++;
    if (r.kind === 'health') {
      healthSamples++;
      peakMemoryBytes = Math.max(peakMemoryBytes, r.memoryBytes);
      late += Math.max(0, r.late - lastLate);
      rejected += Math.max(0, r.rejected - lastRejected);
      lastLate = r.late;
      lastRejected = r.rejected;
    }
  }
}
const expected = (end - start) / 1000;
const coverage = [...symbols].map((symbol) => {
  const c = counts.get(symbol);
  return {
    symbol,
    expectedSeconds: expected,
    storedSeconds: c?.rows ?? 0,
    completeFraction: (c?.complete ?? 0) / expected,
    quoteFraction: (c?.quotes ?? 0) / expected,
    maxClosureDelayMs: c?.maxLatency ?? null,
  };
});
async function bytes(folder: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(folder, { withFileTypes: true })) {
    const p = join(folder, e.name);
    total += e.isDirectory() ? await bytes(p) : (await stat(p)).size;
  }
  return total;
}
const passed =
  end - start >= 86400000 &&
  coverage.length >= 2 &&
  coverage.every((c) => c.completeFraction >= 0.995) &&
  healthSamples > 0;
const report = {
  start,
  end,
  durationHours: (end - start) / 3600000,
  datasetHash: dataset.datasetHash,
  coverage,
  lateObservedInHealthSamples: late,
  rejectedObservedInHealthSamples: rejected,
  disconnects,
  peakMemoryBytes: healthSamples ? peakMemoryBytes : null,
  healthSamples,
  currentDiskBytes: await bytes(values['data-dir']!),
  passed24HourGate: passed,
  limitations: [
    'Requires at least 24 hours; no elapsed-time substitution',
    'Health sampling does not measure instantaneous memory peaks',
    'Coverage denominator is the entire requested interval for the declared universe, including downtime',
    'Disk size is measured now; compare two reports for growth',
    'Legacy journals without health records cannot establish late-event totals',
  ],
};
const output =
  values.output ??
  join(values['data-dir']!, 'operations', `${start}-${end}.json`);
await mkdir(join(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2));
console.log(report);
