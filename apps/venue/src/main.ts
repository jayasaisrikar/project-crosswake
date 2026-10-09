/**
 * Daily Binance-vs-Hyperliquid close check for the v006 universe.
 *
 *   pnpm venue:check [--days 30] [--threshold-bps 50]
 *
 * Writes output/venue/price-check-<date>.json and exits 1 when any coin is
 * flagged, so a scheduler can alert on it. Read-only: places no orders.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getJson } from '../../../packages/market-data/src/klines.js';
import {
  fetchHlCandles,
  fetchHlContexts,
  hlCoin,
} from '../../../packages/market-data/src/hyperliquid.js';
import {
  compareCloses,
  type DailyClose,
} from '../../../packages/market-data/src/crosscheck.js';

const DAY = 86_400_000;
const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '30' },
    'threshold-bps': { type: 'string', default: '50' },
    plan: { type: 'string', default: 'configs/trend-plan-v006.json' },
  },
});
const days = Number(values.days),
  threshold = Number(values['threshold-bps']);
const plan = JSON.parse(await readFile(values.plan, 'utf8')) as {
  symbols: string[];
};

// Last `days` fully closed UTC days.
const endTs = Math.floor(Date.now() / DAY) * DAY,
  startTs = endTs - days * DAY;

async function binanceCloses(symbol: string): Promise<DailyClose[]> {
  const rows = await getJson<unknown[][]>(
    fetch,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${startTs}&endTime=${endTs - 1}&limit=1000`,
  );
  return rows.map((r) => ({ ts: Number(r[0]), close: Number(r[4]) }));
}

const listed = await fetchHlContexts();
const checks = [];
for (const symbol of plan.symbols) {
  const coin = hlCoin(symbol);
  const [bn, hl] = await Promise.all([
    binanceCloses(symbol),
    listed.has(coin)
      ? fetchHlCandles(coin, '1d', startTs, endTs)
      : Promise.resolve(undefined),
  ]);
  checks.push(compareCloses(symbol, bn, hl, threshold));
}

const flagged = checks.filter((c) => c.status === 'flagged'),
  missing = checks.filter((c) => c.status === 'missing');
const report = {
  generatedAt: new Date().toISOString(),
  window: {
    from: new Date(startTs).toISOString().slice(0, 10),
    to: new Date(endTs - DAY).toISOString().slice(0, 10),
  },
  thresholdBps: threshold,
  summary: {
    checked: checks.length - missing.length,
    flagged: flagged.length,
    missing: missing.map((c) => c.symbol),
  },
  checks,
};
await mkdir('output/venue', { recursive: true });
const file = `output/venue/price-check-${report.window.to}.json`;
await writeFile(file, JSON.stringify(report, null, 2) + '\n');

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(
  `Binance vs Hyperliquid daily closes ${report.window.from} → ${report.window.to}, flag > ${threshold} bps\n`,
);
console.log('symbol        days   median bps   max |bps|   status');
for (const c of checks)
  console.log(
    `${c.symbol.padEnd(12)} ${pad(c.days, 5)} ${pad(c.medianGapBps.toFixed(1), 12)} ${pad(c.maxAbsGapBps.toFixed(1), 11)}   ${c.status}${c.worst && c.status === 'flagged' ? ` (worst ${new Date(c.worst.ts).toISOString().slice(0, 10)})` : ''}`,
  );
console.log(
  `\n${report.summary.checked} checked, ${flagged.length} flagged, ${missing.length} not on Hyperliquid. Wrote ${file}`,
);
if (flagged.length) process.exitCode = 1;
