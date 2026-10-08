import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { downloadArchive } from '../../../packages/market-data/src/archive.js';
import { epochMs } from '../../../packages/domain/src/index.js';
import {
  regimeByDay,
  runTrend,
  trendStats,
  type DailyBar,
  type TrendTrade,
} from '../../../packages/backtest/src/trend.js';

const root = process.env.CROSSWAKE_DATA ?? 'data',
  planPath = 'configs/trend-plan-v005.json',
  plan = JSON.parse(await readFile(planPath, 'utf8')),
  dailyDir = (s: string) => join(root, 'daily', s);

function months(from: string, to: string) {
  const out: string[] = [];
  for (let d = new Date(from + 'T00:00:00Z'); d < new Date(to + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1))
    out.push(d.toISOString().slice(0, 7));
  return out;
}

async function history() {
  const all = months(plan.periods.development[0], plan.periods.test[1]);
  for (const symbol of plan.symbols as string[]) {
    await mkdir(dailyDir(symbol), { recursive: true });
    let got = 0, missing = 0;
    for (const month of all) {
      const csv = join(dailyDir(symbol), `${month}.csv`);
      try { await readFile(csv); got++; continue; } catch {}
      const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1d/${symbol}-1d-${month}.zip`,
        dest = join(root, 'archives', 'daily', `${symbol}-1d-${month}.zip`);
      await mkdir(join(root, 'archives', 'daily'), { recursive: true });
      try { await downloadArchive(url, dest); } catch { missing++; continue; }
      const zip = await unzipper.Open.file(dest),
        entry = zip.files.find((f) => f.path.endsWith('.csv'));
      if (!entry) throw new Error(`No CSV in ${dest}`);
      await writeFile(csv, (await entry.buffer()).toString('utf8'));
      got++;
    }
    console.log({ symbol, months: got, missing });
  }
}

async function load(symbol: string): Promise<DailyBar[]> {
  const bars: DailyBar[] = [];
  for (const f of (await readdir(dailyDir(symbol)).catch(() => [])).sort())
    for (const line of (await readFile(join(dailyDir(symbol), f), 'utf8')).split(/\r?\n/)) {
      if (!/^\d/.test(line)) continue;
      const c = line.split(',');
      const b = { ts: epochMs(Number(c[0])), open: +c[1]!, high: +c[2]!, low: +c[3]!, close: +c[4]! };
      if (!(b.open > 0 && b.close > 0) || (bars.length && b.ts <= bars.at(-1)!.ts)) throw new Error(`Bad bar ${symbol} ${c[0]}`);
      bars.push(b);
    }
  return bars;
}

async function test() {
  const rules = { ...plan.entry, ...plan.exit, costBpsRoundTrip: plan.costBpsRoundTrip },
    regime = regimeByDay(await load(plan.regimeSymbol), plan.entry.regimeSmaDays),
    trades: TrendTrade[] = [];
  for (const symbol of plan.symbols as string[])
    trades.push(...runTrend(symbol, await load(symbol), regime, rules));
  const inPeriod = ([a, b]: [string, string]) =>
    trades.filter((t) => t.entryTs >= Date.parse(a) && t.exitTs < Date.parse(b));
  const dev = trendStats(inPeriod(plan.periods.development)),
    tst = trendStats(inPeriod(plan.periods.test)),
    a = plan.acceptance,
    reasons: string[] = [];
  if ((tst?.trades ?? 0) < a.minClosedTrades) reasons.push('insufficient_closed_trades');
  if (tst) {
    if (tst.winRate < a.winRateRange[0] || tst.winRate > a.winRateRange[1]) reasons.push('win_rate_outside_target');
    if (tst.ci95[0] <= a.netExpectancyBpsCi95LowerAbove) reasons.push('expectancy_inconclusive');
    if (tst.profitFactor < a.profitFactorMin) reasons.push('profit_factor_below_target');
  }
  const report = { version: plan.version, ranAt: new Date().toISOString(), development: dev, test: tst, passed: reasons.length === 0, reasons };
  await mkdir(join(root, 'research'), { recursive: true });
  await writeFile(join(root, 'research', `${plan.version}.json`), JSON.stringify({ ...report, trades }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

const cmd = process.argv[2];
const run = ({ history, test } as Record<string, () => Promise<void>>)[cmd ?? ''];
if (run) await run();
else console.error('Usage: trend <history|test>');
