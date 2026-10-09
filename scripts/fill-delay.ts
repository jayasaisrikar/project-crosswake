// Execution-delay sensitivity for a trend plan's frozen test trades.
// The backtest fills at the exact daily open (00:00 UTC); a subscriber acting on an alert
// cannot. This re-prices every trade at the hourly open 1h and 4h later, from Binance's
// public 1h archives, and merges the result into the public performance file.
// Usage: pnpm perf:delay [--plan configs/trend-plan-v005.json]   (after pnpm perf:build)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { downloadArchive } from '../packages/market-data/src/archive.js';
import type { TrendTrade } from '../packages/backtest/src/trend.js';

const HOUR = 3_600_000;
const DELAYS = [0, 1, 4];
const root = process.env.CROSSWAKE_DATA ?? 'data';
const flag = process.argv.indexOf('--plan');
const plan = JSON.parse(
  await readFile(flag > 0 ? process.argv[flag + 1]! : 'configs/trend-plan-v005.json', 'utf8'),
);
const [from, to] = (plan.periods.test as [string, string]).map(Date.parse) as [number, number];
const research = JSON.parse(await readFile(join(root, 'research', `${plan.version}.json`), 'utf8'));
const trades = (research.trades as TrendTrade[]).filter((t) => t.entryTs >= from && t.exitTs < to);

const months = (a: number, b: number) => {
  const out: string[] = [];
  for (let d = new Date(a); d.getTime() <= b; d.setUTCMonth(d.getUTCMonth() + 1, 1))
    out.push(d.toISOString().slice(0, 7));
  return [...new Set(out)];
};

/** Hourly opens keyed by bar start (ms). Downloads and caches missing months. */
async function hourly(symbol: string, need: string[]) {
  const dir = join(root, 'hourly', symbol),
    opens = new Map<number, number>();
  await mkdir(dir, { recursive: true });
  for (const month of need) {
    const csv = join(dir, `${month}.csv`);
    let text = await readFile(csv, 'utf8').catch(() => null);
    if (text === null) {
      const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1h/${symbol}-1h-${month}.zip`,
        dest = join(root, 'archives', 'hourly', `${symbol}-1h-${month}.zip`);
      await mkdir(join(root, 'archives', 'hourly'), { recursive: true });
      try {
        await downloadArchive(url, dest);
      } catch {
        continue;
      }
      const entry = (await unzipper.Open.file(dest)).files.find((f) => f.path.endsWith('.csv'));
      if (!entry) continue;
      text = (await entry.buffer()).toString('utf8');
      await writeFile(csv, text);
    }
    for (const line of text.split(/\r?\n/)) {
      if (!/^\d/.test(line)) continue;
      const c = line.split(',');
      let ts = Number(c[0]);
      if (ts > 1e14) ts = Math.floor(ts / 1000);
      opens.set(ts, Number(c[1]));
    }
  }
  return opens;
}

const bySymbol = new Map<string, TrendTrade[]>();
for (const t of trades) bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);

const repriced = new Map<number, number[]>(DELAYS.map((h) => [h, []]));
let skipped = 0,
  maxBaselineDiff = 0;
for (const [symbol, list] of bySymbol) {
  const need = [...new Set(list.flatMap((t) => [...months(t.entryTs, t.entryTs + 4 * HOUR), ...months(t.exitTs, t.exitTs + 4 * HOUR)]))];
  const opens = await hourly(symbol, need);
  for (const t of list) {
    const prices = DELAYS.map((h) => [opens.get(t.entryTs + h * HOUR), opens.get(t.exitTs + h * HOUR)] as const);
    if (prices.some(([a, b]) => !a || !b)) {
      skipped++;
      continue;
    }
    // The 0h hourly open must reproduce the daily-bar trade; anything else means misaligned data.
    const base = (prices[0]![1]! / prices[0]![0]! - 1) * 1e4 - plan.costBpsRoundTrip;
    maxBaselineDiff = Math.max(maxBaselineDiff, Math.abs(base - t.netBps));
    DELAYS.forEach((h, i) =>
      repriced.get(h)!.push((prices[i]![1]! / prices[i]![0]! - 1) * 1e4 - plan.costBpsRoundTrip),
    );
  }
  console.log({ symbol, trades: list.length });
}

const slots = (plan.symbols as string[]).filter((s) => s !== plan.regimeSymbol).length;
const rows = DELAYS.map((h) => {
  const r = repriced.get(h)!;
  return {
    delayHours: h,
    trades: r.length,
    avgNetBps: r.reduce((a, x) => a + x, 0) / r.length,
    winRate: r.filter((x) => x > 0).length / r.length,
    // Same equal-slot, non-compounding model as the performance page.
    totalReturn: r.reduce((a, x) => a + x / 10_000 / slots, 0),
  };
});
const report = { skipped, maxBaselineDiffBps: maxBaselineDiff, rows };
console.log(JSON.stringify(report, null, 2));
if (maxBaselineDiff > 1) throw new Error('Hourly data does not reproduce the daily fills; not publishing.');

const perfPath = join('apps/landing/public/data', `${plan.version}-performance.json`);
const perf = JSON.parse(await readFile(perfPath, 'utf8'));
perf.summary.fillDelay = report;
await writeFile(perfPath, JSON.stringify(perf));
console.log(`Merged into ${perfPath}`);
