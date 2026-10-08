import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { downloadArchive } from '../../../packages/market-data/src/archive.js';
import { epochMs } from '../../../packages/domain/src/index.js';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { getJson } from '../../../packages/market-data/src/klines.js';
import { deliver, sinksFromEnv } from '../../../packages/notify/src/index.js';
import {
  trendLedger,
  regimeByDay,
  runTrend,
  trendStats,
  type DailyBar,
  type TrendTrade,
} from '../../../packages/backtest/src/trend.js';

const root = process.env.CROSSWAKE_DATA ?? 'data',
  planFlag = process.argv.indexOf('--plan'),
  planPath =
    planFlag > 0 ? process.argv[planFlag + 1]! : 'configs/trend-plan-v005.json',
  plan = JSON.parse(await readFile(planPath, 'utf8')),
  dailyDir = (s: string) => join(root, 'daily', s);

function months(from: string, to: string) {
  const out: string[] = [];
  for (
    let d = new Date(from + 'T00:00:00Z');
    d < new Date(to + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1)
  )
    out.push(d.toISOString().slice(0, 7));
  return out;
}

async function history() {
  const all = months(plan.periods.development[0], plan.periods.test[1]);
  for (const symbol of plan.symbols as string[]) {
    await mkdir(dailyDir(symbol), { recursive: true });
    let got = 0,
      missing = 0;
    for (const month of all) {
      const csv = join(dailyDir(symbol), `${month}.csv`);
      try {
        await readFile(csv);
        got++;
        continue;
      } catch {}
      const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1d/${symbol}-1d-${month}.zip`,
        dest = join(root, 'archives', 'daily', `${symbol}-1d-${month}.zip`);
      await mkdir(join(root, 'archives', 'daily'), { recursive: true });
      try {
        await downloadArchive(url, dest);
      } catch {
        missing++;
        continue;
      }
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
    for (const line of (
      await readFile(join(dailyDir(symbol), f), 'utf8')
    ).split(/\r?\n/)) {
      if (!/^\d/.test(line)) continue;
      const c = line.split(',');
      const b = {
        ts: epochMs(Number(c[0])),
        open: +c[1]!,
        high: +c[2]!,
        low: +c[3]!,
        close: +c[4]!,
      };
      if (
        !(b.open > 0 && b.close > 0) ||
        (bars.length && b.ts <= bars.at(-1)!.ts)
      )
        throw new Error(`Bad bar ${symbol} ${c[0]}`);
      bars.push(b);
    }
  return bars;
}

async function test() {
  const rules = {
      ...plan.entry,
      ...plan.exit,
      costBpsRoundTrip: plan.costBpsRoundTrip,
    },
    regime = regimeByDay(
      await load(plan.regimeSymbol),
      plan.entry.regimeSmaDays,
    ),
    trades: TrendTrade[] = [];
  for (const symbol of plan.symbols as string[])
    trades.push(...runTrend(symbol, await load(symbol), regime, rules));
  const inPeriod = ([a, b]: [string, string]) =>
    trades.filter(
      (t) => t.entryTs >= Date.parse(a) && t.exitTs < Date.parse(b),
    );
  const dev = trendStats(inPeriod(plan.periods.development)),
    tst = trendStats(inPeriod(plan.periods.test)),
    a = plan.acceptance,
    reasons: string[] = [];
  if ((tst?.trades ?? 0) < a.minClosedTrades)
    reasons.push('insufficient_closed_trades');
  if (tst) {
    if (tst.winRate < a.winRateRange[0] || tst.winRate > a.winRateRange[1])
      reasons.push('win_rate_outside_target');
    if (tst.ci95[0] <= a.netExpectancyBpsCi95LowerAbove)
      reasons.push('expectancy_inconclusive');
    if (tst.profitFactor < a.profitFactorMin)
      reasons.push('profit_factor_below_target');
  }
  const report = {
    version: plan.version,
    ranAt: new Date().toISOString(),
    development: dev,
    test: tst,
    passed: reasons.length === 0,
    reasons,
  };
  await mkdir(join(root, 'research'), { recursive: true });
  await writeFile(
    join(root, 'research', `${plan.version}.json`),
    JSON.stringify({ ...report, trades }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

const DAY = 86_400_000,
  // v005's frozen plan predates the field; its live record starts 1 Oct 2026.
  FORWARD_START = Date.parse(
    (plan.forwardStart ?? '2026-10-01') + 'T00:00:00Z',
  ),
  pct = (bps: number) => `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`;

/** Last ~200 daily bars from REST. The final row is today's unfinished bar: its open is real (fills), its close is only a mark. */
async function recentBars(symbol: string): Promise<DailyBar[]> {
  const rows = await getJson<unknown[][]>(
    fetch,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=200`,
  );
  return rows.map((c) => ({
    ts: Number(c[0]),
    open: +c[1]!,
    high: +c[2]!,
    low: +c[3]!,
    close: +c[4]!,
  }));
}

async function live() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const out = join(root, 'trend', 'live', plan.version),
    rules = {
      ...plan.entry,
      ...plan.exit,
      costBpsRoundTrip: plan.costBpsRoundTrip,
    },
    { sinks, channels } = sinksFromEnv(process.env),
    once = process.argv.includes('--once');
  await mkdir(out, { recursive: true });
  const sentPath = join(out, 'delivered.json'),
    sent = new Set<string>(
      existsSync(sentPath) ? JSON.parse(await readFile(sentPath, 'utf8')) : [],
    );
  for (;;) {
    const bars = new Map<string, DailyBar[]>(),
      skipped: string[] = [];
    for (const symbol of plan.symbols as string[]) {
      try {
        const b = await recentBars(symbol);
        // A pair whose newest bar is not today's is delisted or halted.
        if (
          b.length >
            (symbol === plan.regimeSymbol
              ? plan.entry.regimeSmaDays
              : plan.entry.breakoutDays) &&
          b.at(-1)!.ts === Math.floor(Date.now() / DAY) * DAY
        )
          bars.set(symbol, b);
        else skipped.push(symbol);
      } catch {
        skipped.push(symbol);
      }
    }
    const btc = bars.get(plan.regimeSymbol);
    if (!btc) throw new Error('BTC bars unavailable');
    const closedBtc = btc.slice(0, -1),
      regime = regimeByDay(closedBtc, plan.entry.regimeSmaDays),
      ledger = trendLedger(bars, regime, rules, FORWARD_START),
      lastClose = closedBtc.at(-1)!,
      sma =
        closedBtc
          .slice(-plan.entry.regimeSmaDays)
          .reduce((a, b) => a + b.close, 0) / plan.entry.regimeSmaDays,
      stats = trendStats(ledger.closed);
    const state = {
      version: plan.version,
      updatedAt: Date.now(),
      lastDailyClose: lastClose.ts + DAY,
      nextDailyClose: lastClose.ts + 2 * DAY,
      forwardStart: FORWARD_START,
      regime: {
        on: regime.get(lastClose.ts) === true,
        btcClose: lastClose.close,
        btcSma: sma,
      },
      universe: bars.size,
      skipped,
      open: ledger.open,
      events: ledger.events.slice(0, 100),
      closed: ledger.closed,
      stats,
      // Only v005 has a frozen historical test; v006 is judged on live paper alone.
      backtest:
        plan.version === 'trend-daily-v005'
          ? {
              test: {
                trades: 243,
                winRate: 0.337,
                netExpectancyBps: 153,
                ci95: [-287, 629],
              },
            }
          : null,
      symbols: [...bars.keys()],
      channels,
      executionEnabled: false,
    };
    const tmp = join(out, 'state.json.tmp');
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, join(out, 'state.json'));
    // Only events from the latest close are announced; older ones were either sent already or are history.
    for (const e of ledger.events.filter(
      (e) => e.decidedAt >= lastClose.ts && !sent.has(e.id),
    )) {
      const text =
        e.kind === 'entry'
          ? `[${plan.version}] BUY ${e.symbol} at today's open (~${e.price}). 20-day breakout, BTC uptrend. Exit on a close below the 10-day low. Paper signal, not advice.`
          : `[${plan.version}] SELL ${e.symbol} at today's open (~${e.price}), ${e.reason}. Paper result ${pct(e.netBps!)}.`;
      const d = await deliver(sinks, {
        kind: e.kind === 'entry' ? 'signal' : 'paper_exit',
        id: e.id,
        at: e.fillAt,
        text,
      });
      await writeFile(
        join(out, 'deliveries.jsonl'),
        d.map((x) => JSON.stringify(x) + '\n').join(''),
        { flag: 'a' },
      );
      sent.add(e.id);
    }
    await writeFile(sentPath, JSON.stringify([...sent]));
    console.log({
      at: new Date().toISOString(),
      regimeOn: state.regime.on,
      open: ledger.open.length,
      closed: ledger.closed.length,
      skipped,
    });
    if (once) return;
    // Re-check hourly; the daily close at 00:00 UTC is picked up within the first five minutes.
    const untilClose = state.nextDailyClose + 5 * 60_000 - Date.now();
    await new Promise((r) =>
      setTimeout(r, Math.max(60_000, Math.min(3_600_000, untilClose))),
    );
  }
}

const cmd = process.argv[2];
const run = ({ history, test, live } as Record<string, () => Promise<void>>)[
  cmd ?? ''
];
if (run) await run();
else console.error('Usage: trend <history|test|live>');
