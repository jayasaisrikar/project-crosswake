import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { downloadArchive } from '../../../packages/market-data/src/archive.js';
import { epochMs } from '../../../packages/domain/src/index.js';
import {
  fundingArchiveUrl,
  getJson,
} from '../../../packages/market-data/src/klines.js';
import { deliver, escapeHtml, sinksFromEnv } from '../../../packages/notify/src/index.js';
import {
  M15,
  rStats,
  rulesFromPlan,
  runHtfRsi,
  type Bar15,
  type Funding,
  type HtfSignal,
} from '../../../packages/backtest/src/htf-rsi.js';

const root = process.env.CROSSWAKE_DATA ?? 'data',
  planFlag = process.argv.indexOf('--plan'),
  planPath =
    planFlag > 0 ? process.argv[planFlag + 1]! : 'configs/htf-rsi-plan-v007.json',
  plan = JSON.parse(await readFile(planPath, 'utf8')),
  rules = rulesFromPlan(plan),
  symbols = plan.symbols as string[],
  barDir = (s: string) => join(root, 'perp15m', s),
  fundDir = (s: string) => join(root, 'funding', s);

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

async function fetchCsv(url: string, csv: string) {
  if (existsSync(csv)) return true;
  const dest = join(root, 'archives', 'htf', url.split('/').at(-1)!);
  await mkdir(join(root, 'archives', 'htf'), { recursive: true });
  try {
    await downloadArchive(url, dest);
  } catch {
    return false;
  }
  const zip = await unzipper.Open.file(dest),
    entry = zip.files.find((f) => f.path.endsWith('.csv'));
  if (!entry) throw new Error(`No CSV in ${dest}`);
  await writeFile(csv, (await entry.buffer()).toString('utf8'));
  return true;
}

async function history() {
  const all = months(plan.periods.development[0], plan.periods.test[1]);
  for (const symbol of symbols) {
    await mkdir(barDir(symbol), { recursive: true });
    await mkdir(fundDir(symbol), { recursive: true });
    let bars = 0,
      funding = 0;
    for (const month of all) {
      const k = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/15m/${symbol}-15m-${month}.zip`;
      if (await fetchCsv(k, join(barDir(symbol), `${month}.csv`))) bars++;
      if (
        await fetchCsv(
          fundingArchiveUrl(symbol, month),
          join(fundDir(symbol), `${month}.csv`),
        )
      )
        funding++;
    }
    console.log({ symbol, months: all.length, bars, funding });
  }
}

async function loadBars(symbol: string): Promise<Bar15[]> {
  const bars: Bar15[] = [];
  for (const f of (await readdir(barDir(symbol)).catch(() => [])).sort())
    for (const line of (await readFile(join(barDir(symbol), f), 'utf8')).split(
      /\r?\n/,
    )) {
      if (!/^\d/.test(line)) continue;
      const c = line.split(','),
        b = {
          ts: epochMs(Number(c[0])),
          open: +c[1]!,
          high: +c[2]!,
          low: +c[3]!,
          close: +c[4]!,
          volume: +c[5]!,
        };
      if (
        !(b.open > 0 && b.close > 0) ||
        b.ts % M15 ||
        (bars.length && b.ts <= bars.at(-1)!.ts)
      )
        throw new Error(`Bad bar ${symbol} ${c[0]}`);
      bars.push(b);
    }
  return bars;
}
async function loadFunding(symbol: string): Promise<Funding[]> {
  const out: Funding[] = [];
  for (const f of (await readdir(fundDir(symbol)).catch(() => [])).sort())
    for (const line of (await readFile(join(fundDir(symbol), f), 'utf8')).split(
      /\r?\n/,
    )) {
      if (!/^\d/.test(line)) continue;
      const [ts, , rate] = line.split(',');
      out.push({ ts: epochMs(Number(ts)), rate: Number(rate) });
    }
  return out;
}

async function test() {
  const bars = new Map<string, Bar15[]>(),
    funding = new Map<string, Funding[]>();
  for (const s of symbols) {
    bars.set(s, await loadBars(s));
    funding.set(s, await loadFunding(s));
  }
  const inPeriod = (xs: HtfSignal[], [a, b]: [string, string]) =>
    xs.filter((t) => t.ts >= Date.parse(a) && t.ts < Date.parse(b));
  const signals = runHtfRsi(bars, funding, rules),
    cheap = runHtfRsi(bars, funding, { ...rules, costBpsRoundTrip: 5 }),
    dev = rStats(inPeriod(signals, plan.periods.development)),
    tst = rStats(inPeriod(signals, plan.periods.test)),
    a = plan.acceptance,
    reasons: string[] = [];
  if ((tst?.trades ?? 0) < a.minClosedTrades)
    reasons.push('insufficient_closed_trades');
  if (tst) {
    if (tst.winRate < a.winRateRange[0] || tst.winRate > a.winRateRange[1])
      reasons.push('win_rate_outside_target');
    if (tst.ci95[0] <= a.netExpectancyRCi95LowerAbove)
      reasons.push('expectancy_inconclusive');
    if (tst.profitFactor < a.profitFactorMin)
      reasons.push('profit_factor_below_target');
  }
  const skipped: Record<string, number> = {};
  for (const s of inPeriod(signals, plan.periods.test))
    if (s.skipReason) skipped[s.skipReason] = (skipped[s.skipReason] ?? 0) + 1;
  const report = {
    version: plan.version,
    ranAt: new Date().toISOString(),
    coverage: Object.fromEntries(
      [...bars].map(([s, b]) => [
        s,
        { bars: b.length, from: new Date(b[0]?.ts ?? 0).toISOString(), to: new Date(b.at(-1)?.ts ?? 0).toISOString() },
      ]),
    ),
    development: dev,
    test: tst,
    testSkipped: skipped,
    testAt5Bps: (({ trades, winRate, expectancyR, ci95, profitFactor }) => ({ trades, winRate, expectancyR, ci95, profitFactor }))(
      rStats(inPeriod(cheap, plan.periods.test)) ?? ({} as any),
    ),
    passed: reasons.length === 0,
    reasons,
  };
  await mkdir(join(root, 'research'), { recursive: true });
  await writeFile(
    join(root, 'research', `${plan.version}.json`),
    JSON.stringify({ ...report, signals }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

/** Last ~3000 closed 15m bars (two REST pages); the unfinished bar is dropped. */
async function recentBars(symbol: string): Promise<Bar15[]> {
  const rows: unknown[][] = [];
  let end = Date.now();
  for (let page = 0; page < 2; page++) {
    const got = await getJson<unknown[][]>(
      fetch,
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=1500&endTime=${end}`,
    );
    rows.unshift(...got);
    end = Number(got[0]![0]) - 1;
  }
  return rows
    .map((c) => ({
      ts: Number(c[0]),
      open: +c[1]!,
      high: +c[2]!,
      low: +c[3]!,
      close: +c[4]!,
      volume: +c[5]!,
    }))
    .filter((b, i, a) => b.ts + M15 <= Date.now() && (i === 0 || b.ts > a[i - 1]!.ts));
}
async function recentFunding(symbol: string): Promise<Funding[]> {
  const rows = await getJson<{ fundingTime: number; fundingRate: string }[]>(
    fetch,
    `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=200`,
  );
  return rows.map((r) => ({ ts: r.fundingTime, rate: Number(r.fundingRate) }));
}

const fmt = (x: number) => Number(x.toPrecision(6));
async function live() {
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const out = join(root, 'trend', 'live', plan.version),
    liveFrom = Date.parse(plan.periods.liveFrom + 'T00:00:00Z'),
    { sinks, channels } = sinksFromEnv(process.env),
    once = process.argv.includes('--once');
  await mkdir(out, { recursive: true });
  const sentPath = join(out, 'delivered.json'),
    ledgerPath = join(out, 'ledger.json'),
    sent = new Set<string>(
      existsSync(sentPath) ? JSON.parse(await readFile(sentPath, 'utf8')) : [],
    ),
    // Signals already closed keep their recorded result even after they leave the REST window.
    ledger = new Map<string, HtfSignal>(
      existsSync(ledgerPath)
        ? (JSON.parse(await readFile(ledgerPath, 'utf8')) as HtfSignal[]).map((s) => [s.id, s])
        : [],
    );
  for (;;) {
    const bars = new Map<string, Bar15[]>(),
      funding = new Map<string, Funding[]>(),
      skipped: string[] = [];
    for (const s of symbols)
      try {
        bars.set(s, await recentBars(s));
        funding.set(s, await recentFunding(s));
      } catch {
        skipped.push(s);
      }
    for (const s of runHtfRsi(bars, funding, rules)) {
      if (s.ts < liveFrom) continue;
      const prev = ledger.get(s.id);
      if (!prev || prev.exitReason === 'open' || prev.status === 'skipped') ledger.set(s.id, s);
    }
    const all = [...ledger.values()].sort((a, b) => b.ts - a.ts),
      open = all.filter((s) => s.status === 'taken' && s.exitReason === 'open'),
      lastBar = Math.max(...[...bars.values()].map((b) => b.at(-1)?.ts ?? 0));
    await writeFile(ledgerPath, JSON.stringify(all));
    const state = {
      kind: 'htf-rsi',
      version: plan.version,
      updatedAt: Date.now(),
      lastClose: lastBar + M15,
      nextClose: lastBar + 2 * M15,
      forwardStart: liveFrom,
      universe: bars.size,
      skipped,
      symbols: [...bars.keys()],
      open: open.map((s) => ({ ...s, lastClose: bars.get(s.symbol)?.at(-1)?.close })),
      events: all.slice(0, 100),
      stats: rStats(all),
      channels,
      executionEnabled: false,
    };
    const tmp = join(out, 'state.json.tmp');
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, join(out, 'state.json'));
    for (const s of all.filter((s) => s.status === 'taken')) {
      const key = s.exitReason === 'open' ? `${s.id}-entry` : `${s.id}-exit`;
      if (sent.has(key) || (s.exitReason !== 'open' && !sent.has(`${s.id}-entry`) && Date.now() - s.exitTs! > 3_600_000)) continue;
      const coin = escapeHtml(s.symbol.replace(/USDT$/, '')),
        long = s.side === 'long',
        r = s.realizedR ?? 0;
      const text =
        s.exitReason === 'open'
          ? [
              `${long ? '🟢' : '🔴'} <b>${long ? 'LONG' : 'SHORT'} ${coin}</b> · perp · 15m`,
              '',
              `▸ <b>Entry</b>   <code>~${fmt(s.entry!)}</code>  (next 15m open)`,
              `▸ <b>Stop</b>    <code>${fmt(s.stop)}</code>  (${((s.rDistance! / s.entry!) * 100).toFixed(2)}%)`,
              '',
              '<b>Plan</b>',
              '• Take 50% off at 1.5R',
              '• Move stop to breakeven after 1R',
              '• Close after 16 bars (4h) if still open',
              '',
              `<b>Why</b>  RSI ${s.rsiPrev.toFixed(1)} → ${s.rsi.toFixed(1)} · 4h ADX ${s.adx4h.toFixed(1)}`,
              '',
              `<i>${escapeHtml(plan.version)} · paper signal, not advice</i>`,
            ].join('\n')
          : [
              `${r >= 0 ? '✅' : '❌'} <b>EXIT ${coin}</b> ${s.side}`,
              '',
              `▸ <b>Result</b>  <code>${r >= 0 ? '+' : ''}${r.toFixed(2)}R</code>`,
              `▸ <b>Reason</b>  ${escapeHtml(String(s.exitReason))}${s.scaled ? ' (half taken at 1.5R)' : ''}`,
              '',
              `<i>${escapeHtml(plan.version)} · paper result</i>`,
            ].join('\n');
      const d = await deliver(sinks, {
        kind: s.exitReason === 'open' ? 'signal' : 'paper_exit',
        id: key,
        at: s.exitReason === 'open' ? s.ts : s.exitTs!,
        text,
        html: true,
      });
      await writeFile(join(out, 'deliveries.jsonl'), d.map((x) => JSON.stringify(x) + '\n').join(''), { flag: 'a' });
      sent.add(key);
      if (s.exitReason !== 'open') sent.add(`${s.id}-entry`);
    }
    await writeFile(sentPath, JSON.stringify([...sent]));
    console.log({ at: new Date().toISOString(), open: open.length, signals: all.length, skipped });
    if (once) return;
    // Wake ~20s after each 15m close.
    const wait = state.nextClose + 20_000 - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(30_000, Math.min(M15 + 20_000, wait))));
  }
}

const cmd = process.argv[2];
const run = ({ history, test, live } as Record<string, () => Promise<void>>)[cmd ?? ''];
if (run) await run();
else console.error('Usage: htf <history|test|live> [--plan path] [--once]');
