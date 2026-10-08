import { parseArgs } from 'node:util';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  fetchBook,
  measureBook,
  summarizeDepth,
  type DepthSample,
} from '../../../packages/market-data/src/depth.js';
import type { Market } from '../../../packages/market-data/src/klines.js';
import { residualSchema } from '../../../packages/signals/src/residual.js';

const [command, ...rest] = process.argv.slice(2).filter((x) => x !== '--');
const { values } = parseArgs({
  args: rest,
  options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    config: { type: 'string', default: 'configs/residual-spot-v003.json' },
    markets: { type: 'string', default: 'spot,usdm' },
    notionals: { type: 'string', default: '100,1000,10000,50000' },
    'interval-seconds': { type: 'string', default: '60' },
    minutes: { type: 'string' },
  },
});
const dir = join(values['data-dir']!, 'costs');

async function sample() {
  const symbols = residualSchema.parse(
      JSON.parse(await readFile(values.config!, 'utf8')),
    ).symbols,
    markets = values.markets!.split(',') as Market[],
    notionals = values.notionals!.split(',').map(Number),
    interval = Number(values['interval-seconds']) * 1000,
    until = values.minutes
      ? Date.now() + Number(values.minutes) * 60000
      : Infinity;
  if (
    markets.some((m) => m !== 'spot' && m !== 'usdm') ||
    notionals.some((n) => !(n > 0)) ||
    !(interval >= 10000)
  )
    throw new Error(
      'Markets must be spot/usdm, notionals positive, interval at least 10 seconds',
    );
  await mkdir(dir, { recursive: true });
  let stop = false;
  process.once('SIGINT', () => (stop = true));
  process.once('SIGTERM', () => (stop = true));
  console.log(
    `Sampling ${symbols.length} symbols on ${markets.join('+')} every ${interval / 1000}s`,
  );
  while (!stop && Date.now() < until) {
    const started = Date.now(),
      rows: DepthSample[] = [];
    await Promise.all(
      markets.flatMap((market) =>
        symbols.map(async (symbol) => {
          try {
            const book = await fetchBook(symbol, market);
            rows.push({
              ts: Date.now(),
              market,
              symbol,
              ...measureBook(book, notionals),
            });
          } catch (error) {
            console.error(`${market} ${symbol} depth failed: ${error}`);
          }
        }),
      ),
    );
    const file = join(
      dir,
      `depth-${new Date(started).toISOString().slice(0, 10)}.jsonl`,
    );
    if (rows.length)
      await appendFile(
        file,
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    await new Promise((r) =>
      setTimeout(r, Math.max(1000, started + interval - Date.now())),
    );
  }
}

async function report() {
  const samples: DepthSample[] = [];
  for (const name of (await readdir(dir))
    .filter((n) => /^depth-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .sort()) {
    const lines = (await readFile(join(dir, name), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        samples.push(JSON.parse(line));
      } catch (error) {
        // Only an incomplete trailing append is tolerated.
        if (i < lines.length - 2)
          throw new Error(`Corrupt depth sample in ${name}:${i + 1}`);
      }
    });
  }
  if (!samples.length)
    throw new Error('No depth samples yet; run costs:sample first');
  const summary = {
    generatedAt: Date.now(),
    samples: samples.length,
    symbols: summarizeDepth(samples),
    limitations: [
      'REST snapshots of the top 100 levels; hidden liquidity, queue position and latency are not observed',
      'Impact assumes an immediate market order against the visible book at sample time',
    ],
  };
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.table(
    summary.symbols.map((s) => ({
      market: s.market,
      symbol: s.symbol,
      n: s.samples,
      spreadMed: s.spreadBps.median?.toFixed(2),
      ...Object.fromEntries(
        s.roundTripImpact.map((i) => [
          `rt$${i.notionalUsdt}`,
          i.median === null ? 'thin' : i.median.toFixed(2),
        ]),
      ),
    })),
  );
  console.log(`Summary: ${resolve(join(dir, 'summary.json'))}`);
}

const commands: Record<string, () => Promise<void>> = { sample, report };
const run = commands[command ?? ''];
if (!run) throw new Error('Usage: costs <sample|report> [options]');
await run();
