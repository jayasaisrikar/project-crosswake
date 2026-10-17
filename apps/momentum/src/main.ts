import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { downloadArchive } from '../../../packages/market-data/src/archive.js';
import { getJson } from '../../../packages/market-data/src/klines.js';
import { epochMs } from '../../../packages/domain/src/index.js';
import {
  alphaBeta,
  momentumStats,
  momentumVerdict,
  runMomentum,
  type MomentumRun,
} from '../../../packages/backtest/src/momentum.js';
import type { DailyBar } from '../../../packages/backtest/src/trend.js';

const root = process.env.CROSSWAKE_DATA ?? 'data',
  planFlag = process.argv.indexOf('--plan'),
  planPath =
    planFlag > 0
      ? process.argv[planFlag + 1]!
      : 'configs/momentum-plan-v008.json',
  plan = JSON.parse(await readFile(planPath, 'utf8')),
  barsDir = (s: string) => join(root, 'perp1d', s),
  DAY = 86_400_000,
  FORWARD_START = Date.parse(plan.forwardStart + 'T00:00:00Z');

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
  // Monthly archives up to the last complete month; the current month comes from REST in `test`/`live`.
  const thisMonth = new Date().toISOString().slice(0, 7) + '-01',
    all = months(plan.periods.reference[0], thisMonth);
  for (const symbol of plan.symbols as string[]) {
    await mkdir(barsDir(symbol), { recursive: true });
    let got = 0,
      missing = 0;
    for (const month of all) {
      const csv = join(barsDir(symbol), `${month}.csv`);
      if (existsSync(csv)) {
        got++;
        continue;
      }
      const url = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1d/${symbol}-1d-${month}.zip`,
        dest = join(root, 'archives', 'perp1d', `${symbol}-1d-${month}.zip`);
      await mkdir(join(root, 'archives', 'perp1d'), { recursive: true });
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
  for (const f of (await readdir(barsDir(symbol)).catch(() => [])).sort())
    for (const line of (await readFile(join(barsDir(symbol), f), 'utf8')).split(
      /\r?\n/,
    )) {
      if (!/^\d/.test(line)) continue; // futures archives carry a header row
      const c = line.split(','),
        b = {
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

/** Last ~1500 daily perp bars (~4 years, enough warmup for the 120-day lookback) from REST, closed bars only (the unfinished current day is dropped). */
async function recentBars(symbol: string): Promise<DailyBar[]> {
  const rows = await getJson<unknown[][]>(
      fetch,
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=1500`,
    ),
    today = Math.floor(Date.now() / DAY) * DAY;
  return rows
    .map((c) => ({
      ts: Number(c[0]),
      open: +c[1]!,
      high: +c[2]!,
      low: +c[3]!,
      close: +c[4]!,
    }))
    .filter((b) => b.ts < today);
}

/** Archive bars, topped up with REST bars for days the archives do not cover yet. */
async function loadAll() {
  const bars = new Map<string, DailyBar[]>();
  for (const symbol of plan.symbols as string[]) {
    const hist = await load(symbol),
      last = hist.at(-1)?.ts ?? -Infinity,
      recent = await recentBars(symbol).catch(() => []),
      b = [...hist, ...recent.filter((x) => x.ts > last)];
    if (b.length) bars.set(symbol, b);
  }
  return bars;
}

const summary = (run: MomentumRun, from: number, to = Infinity) => ({
  book: momentumStats(run, run.returns.book, from, to),
  trend: momentumStats(run, run.returns.trend, from, to),
  xsmom: momentumStats(run, run.returns.xsmom, from, to),
  equalWeight: momentumStats(run, run.returns.equalWeight, from, to),
  vsEqualWeight: alphaBeta(run, from, to),
});

async function test() {
  const run = runMomentum(await loadAll(), plan.rules),
    [a, b] = plan.periods.reference as [string, string],
    report = {
      version: plan.version,
      ranAt: new Date().toISOString(),
      label:
        'REFERENCE ONLY - these rules have already seen this data; not out-of-sample',
      costBpsPerSide: plan.rules.costBpsPerSide,
      reference: summary(run, Date.parse(a), Date.parse(b)),
      referenceAt2xCosts: summary(
        runMomentum(await loadAll(), {
          ...plan.rules,
          costBpsPerSide: plan.rules.costBpsPerSide * 2,
        }),
        Date.parse(a),
        Date.parse(b),
      ),
      byYear: Object.fromEntries(
        [2021, 2022, 2023, 2024, 2025, 2026].map((y) => [
          y,
          summary(run, Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)).book,
        ]),
      ),
    };
  await mkdir(join(root, 'research'), { recursive: true });
  await writeFile(
    join(root, 'research', `${plan.version}-reference.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}

async function live() {
  const out = join(root, 'momentum', 'live', plan.version),
    once = process.argv.includes('--once');
  await mkdir(out, { recursive: true });
  for (;;) {
    const bars = new Map<string, DailyBar[]>(),
      skipped: string[] = [];
    for (const symbol of plan.symbols as string[]) {
      try {
        const b = await recentBars(symbol);
        // A pair whose newest closed bar is not yesterday's is delisted or halted.
        if (
          b.length &&
          b.at(-1)!.ts === Math.floor(Date.now() / DAY) * DAY - DAY
        )
          bars.set(symbol, b);
        else skipped.push(symbol);
      } catch {
        skipped.push(symbol);
      }
    }
    if (!bars.has('BTCUSDT')) throw new Error('BTC bars unavailable');
    const run = runMomentum(bars, plan.rules),
      i = run.days.length - 1,
      target = (w: Float64Array) =>
        Object.fromEntries(
          run.symbols
            .map((s, j) => [s, +w[j]!.toFixed(4)])
            .filter(([, x]) => x !== 0),
        ),
      decision = {
        decidedAt: run.days[i]! + DAY,
        fillAt: run.days[i]! + DAY,
        book: target(run.weights.book[i]!),
        trend: target(run.weights.trend[i]!),
        xsmom: target(run.weights.xsmom[i]!),
      },
      equity = run.days
        .map((d, k) => ({ d, r: run.returns.book[k]! }))
        .filter((x) => x.d >= FORWARD_START && Number.isFinite(x.r))
        .reduce<{ at: number; equity: number }[]>(
          (acc, x) => [
            ...acc,
            {
              at: x.d + 2 * DAY,
              equity: (acc.at(-1)?.equity ?? 1) * (1 + x.r),
            },
          ],
          [],
        ),
      state = {
        version: plan.version,
        updatedAt: Date.now(),
        forwardStart: FORWARD_START,
        universe: bars.size,
        skipped,
        decision,
        grossLeverage: Object.values(decision.book).reduce(
          (a: number, x) => a + Math.abs(x as number),
          0,
        ),
        equity,
        live: summary(run, FORWARD_START),
        gate: momentumVerdict(run, plan.acceptance, FORWARD_START),
        executionEnabled: false,
      };
    const decisions = join(out, 'decisions.jsonl'),
      seen = existsSync(decisions) ? await readFile(decisions, 'utf8') : '';
    if (!seen.includes(`"decidedAt":${decision.decidedAt},`))
      await writeFile(decisions, JSON.stringify(decision) + '\n', {
        flag: 'a',
      });
    const tmp = join(out, 'state.json.tmp');
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, join(out, 'state.json'));
    console.log({
      at: new Date().toISOString(),
      gross: state.grossLeverage,
      gate: state.gate.verdict,
      skipped,
    });
    if (once) return;
    // Wake shortly after the next 00:00 UTC daily close.
    const next = Math.floor(Date.now() / DAY) * DAY + DAY + 5 * 60_000;
    await new Promise((r) =>
      setTimeout(r, Math.max(60_000, Math.min(3_600_000, next - Date.now()))),
    );
  }
}

const cmd = process.argv[2];
const run = ({ history, test, live } as Record<string, () => Promise<void>>)[
  cmd ?? ''
];
if (run) await run();
else console.error('Usage: momentum <history|test|live>');
