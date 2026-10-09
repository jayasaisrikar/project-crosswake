// Builds the public performance page data for a trend plan from its frozen test trades.
// Usage: pnpm perf:build [--plan configs/trend-plan-v005.json]
// Reads data/research/<version>.json (from `pnpm trend:test`) and data/daily/<symbol>/*.csv,
// writes apps/landing/public/data/<version>-performance.json and <version>-test-trades.csv.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrendTrade } from '../packages/backtest/src/trend.js';

const DAY = 86_400_000;
const root = process.env.CROSSWAKE_DATA ?? 'data';
const flag = process.argv.indexOf('--plan');
const plan = JSON.parse(
  await readFile(flag > 0 ? process.argv[flag + 1]! : 'configs/trend-plan-v005.json', 'utf8'),
);
const out = 'apps/landing/public/data';
const [from, to] = (plan.periods.test as [string, string]).map(Date.parse) as [number, number];

async function closes(symbol: string) {
  const dir = join(root, 'daily', symbol),
    m = new Map<number, number>();
  for (const f of (await readdir(dir).catch(() => [] as string[])).sort())
    for (const line of (await readFile(join(dir, f), 'utf8')).split(/\r?\n/)) {
      if (!/^\d/.test(line)) continue;
      const c = line.split(',');
      let ts = Number(c[0]);
      if (ts > 1e14) ts = Math.floor(ts / 1000); // newer archives use microseconds
      m.set(Math.floor(ts / DAY) * DAY, Number(c[4]));
    }
  return m;
}

const research = JSON.parse(await readFile(join(root, 'research', `${plan.version}.json`), 'utf8'));
const trades = (research.trades as TrendTrade[])
  .filter((t) => t.entryTs >= from && t.exitTs < to)
  .sort((a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol));
const alts = (plan.symbols as string[]).filter((s) => s !== plan.regimeSymbol);
const slot = 1 / alts.length;
const px = new Map(await Promise.all([...alts, plan.regimeSymbol].map(async (s) => [s, await closes(s)] as const)));

const days: number[] = [];
for (let d = from; d < to; d += DAY) days.push(d);

// Strategy equity: realised P&L of closed trades plus open positions marked at the close.
const series = days.map((d) => {
  let pnl = 0,
    open = 0;
  for (const t of trades) {
    if (t.exitTs <= d) pnl += slot * (t.netBps / 10_000);
    else if (t.entryTs <= d) {
      const c = px.get(t.symbol)!.get(d);
      if (c) pnl += slot * (c / t.entry - 1);
      open++;
    }
  }
  return { d, equity: 1 + pnl, exposure: open * slot };
});

// Benchmarks over the same days: BTC buy-and-hold, and an equal-weight basket of the same alts.
const btc = px.get(plan.regimeSymbol)!;
const btc0 = btc.get(from)!;
const basketStart = alts.filter((s) => px.get(s)!.has(from));
const basket = (d: number) => {
  let sum = 0;
  for (const s of basketStart) {
    // A delisted coin's last close carries forward, as a holder would be stuck with it.
    let c: number | undefined, k = d;
    while (c === undefined && k >= from) (c = px.get(s)!.get(k)), (k -= DAY);
    sum += (c ?? 0) / px.get(s)!.get(from)!;
  }
  return sum / basketStart.length;
};
let lastBtc = 1;
const points = series.map(({ d, equity, exposure }) => {
  const b = btc.get(d);
  if (b) lastBtc = b / btc0;
  return { t: d, strategy: +equity.toFixed(5), btc: +lastBtc.toFixed(5), basket: +basket(d).toFixed(5), exposure: +exposure.toFixed(4) };
});

function drawdown(values: number[]) {
  let peak = values[0]!, max = 0, start = 0, worst = { from: 0, to: 0 };
  const dd = values.map((v, i) => {
    if (v > peak) (peak = v), (start = i);
    const x = v / peak - 1;
    if (x < max) (max = x), (worst = { from: start, to: i });
    return x;
  });
  return { dd, max, worst };
}
const sDD = drawdown(points.map((p) => p.strategy));
const bDD = drawdown(points.map((p) => p.btc));
const kDD = drawdown(points.map((p) => p.basket));

let streak = 0, longest = 0;
for (const t of [...trades].sort((a, b) => a.exitTs - b.exitTs)) {
  streak = t.netBps <= 0 ? streak + 1 : 0;
  longest = Math.max(longest, streak);
}
const wins = trades.filter((t) => t.netBps > 0);
const last = points.at(-1)!;
const summary = {
  version: plan.version,
  period: plan.periods.test,
  builtAt: new Date().toISOString(),
  model: {
    slots: alts.length,
    sizing: `Capital split into ${alts.length} equal slots, one per coin; no leverage, no compounding.`,
    marking: 'Open positions marked at each daily close; fees and slippage applied at exit.',
    costBpsRoundTrip: plan.costBpsRoundTrip,
  },
  trades: trades.length,
  winRate: wins.length / trades.length,
  avgNetBps: trades.reduce((a, t) => a + t.netBps, 0) / trades.length,
  bestBps: Math.max(...trades.map((t) => t.netBps)),
  worstBps: Math.min(...trades.map((t) => t.netBps)),
  longestLosingStreak: longest,
  avgExposure: points.reduce((a, p) => a + p.exposure, 0) / points.length,
  maxExposure: Math.max(...points.map((p) => p.exposure)),
  totalReturn: { strategy: last.strategy - 1, btc: last.btc - 1, basket: last.basket - 1 },
  maxDrawdown: { strategy: sDD.max, btc: bDD.max, basket: kDD.max },
  worstDrawdown: { from: points[sDD.worst.from]!.t, to: points[sDD.worst.to]!.t },
  basketCoins: basketStart.length,
};
const payload = {
  summary,
  points: points.map((p, i) => ({ ...p, drawdown: +sDD.dd[i]!.toFixed(5) })),
};

await mkdir(out, { recursive: true });
await writeFile(join(out, `${plan.version}-performance.json`), JSON.stringify(payload));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
await writeFile(
  join(out, `${plan.version}-test-trades.csv`),
  ['symbol,entry_date,exit_date,entry_price,exit_price,net_return_pct,exit_reason']
    .concat(trades.map((t) => [t.symbol, day(t.entryTs), day(t.exitTs), t.entry, t.exit, (t.netBps / 100).toFixed(2), t.reason].join(',')))
    .join('\n') + '\n',
);
console.log(JSON.stringify(summary, null, 2));
