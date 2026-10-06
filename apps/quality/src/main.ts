import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { openDataset } from '../../../packages/storage/src/read.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((s) => s !== '--'),
  options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    source: { type: 'string', default: 'live' },
    output: { type: 'string' },
  },
});
if (values.source !== 'live' && values.source !== 'historical')
  throw new Error('Invalid source');
const dataset = await openDataset(values['data-dir']!, values.source);
const counts = new Map<
  string,
  {
    rows: number;
    complete: number;
    withTrades: number;
    withQuotes: number;
    firstTs: number;
    lastTs: number;
    latencyTotal: number;
    latencyCount: number;
  }
>();
for await (const batch of dataset.batches())
  for (const row of batch) {
    const c = counts.get(row.symbol) ?? {
      rows: 0,
      complete: 0,
      withTrades: 0,
      withQuotes: 0,
      firstTs: row.ts,
      lastTs: row.ts,
      latencyTotal: 0,
      latencyCount: 0,
    };
    c.rows++;
    c.complete += Number(row.isComplete);
    c.withTrades += Number(row.tradeCount > 0);
    c.withQuotes += Number(row.bestBid !== null);
    c.lastTs = row.ts;
    if (row.sourceLatencyMs !== null) {
      c.latencyTotal += row.sourceLatencyMs;
      c.latencyCount++;
    }
    counts.set(row.symbol, c);
  }
const report = {
  datasetHash: dataset.datasetHash,
  source: values.source,
  symbols: [...counts].map(([symbol, c]) => {
    const expected = (c.lastTs - c.firstTs) / 1000 + 1;
    return {
      symbol,
      ...c,
      expectedBucketCount: expected,
      missingBucketRate: 1 - c.rows / expected,
      completeFraction: c.complete / expected,
      tradeFraction: c.withTrades / expected,
      quoteFraction: c.withQuotes / expected,
      meanTradeLatencyMs: c.latencyCount
        ? c.latencyTotal / c.latencyCount
        : null,
      observedDurationMs: c.lastTs - c.firstTs,
    };
  }),
  limitations: [
    'Coverage is measured between first and last stored timestamps per symbol; offline periods before/after are not included',
    'New live buckets use fresh BBO evidence even when no trade occurs; legacy and historical no-trade buckets remain incomplete',
    '24-hour gate must use an externally recorded run interval',
  ],
};
const text = JSON.stringify(report, null, 2);
if (values.output) await writeFile(values.output, text);
console.log(text);
