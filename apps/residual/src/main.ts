import { parseArgs } from 'node:util';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import unzipper from 'unzipper';
import { downloadArchive } from '../../../packages/market-data/src/archive.js';
import {
  fetchKlines,
  klineArchiveUrl,
  monthRange,
  parseKlineCsv,
  periodBounds,
} from '../../../packages/market-data/src/klines.js';
import { dateRange } from '../../../packages/market-data/src/archive.js';
import {
  barDir,
  loadBarStore,
  readBarManifest,
  writeBarPeriod,
} from '../../../packages/storage/src/bars.js';
import { BarStore, MINUTE } from '../../../packages/quant/src/residual.js';
import {
  ResidualEngine,
  residualSchema,
  type ResidualConfig,
  type ResidualSignal,
} from '../../../packages/signals/src/residual.js';
import {
  ResidualSimulator,
  residualReport,
  runResidual,
  type OpenPosition,
} from '../../../packages/backtest/src/residual.js';
import {
  residualHoldout,
  residualPlanSchema,
  residualWalkForward,
} from '../../../packages/backtest/src/residual-research.js';
import { residualStudy } from '../../../packages/backtest/src/residual-study.js';
import { describeSignal, px } from './format.js';

const [command, ...rest] = process.argv.slice(2).filter((x) => x !== '--');
const { values } = parseArgs({
  args: rest,
  options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    config: { type: 'string', default: 'configs/residual-spot-v003.json' },
    plan: { type: 'string' },
    symbols: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    days: { type: 'string' },
    output: { type: 'string' },
    'walk-forward': { type: 'string' },
    once: { type: 'boolean', default: false },
    'lookback-hours': { type: 'string', default: '1,2,4' },
    'hold-hours': { type: 'string', default: '1,2,4' },
  },
});
const root = values['data-dir']!;
const readJson = async (path: string) =>
  JSON.parse(await readFile(path, 'utf8'));
const loadConfig = async (path: string) =>
  residualSchema.parse(await readJson(path));
const iso = (ts: number) => new Date(ts).toISOString().replace('.000Z', 'Z');
async function freshDir(path: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await mkdir(path);
  return path;
}
async function loadPlan(path: string) {
  const plan = residualPlanSchema.parse(await readJson(path)),
    base = await readJson(join(path, '..', plan.baseConfig));
  return { plan, base };
}

async function history() {
  const config = await loadConfig(values.config!),
    symbols = values.symbols?.split(',') ?? config.symbols;
  const periods = [
    ...(values.from ? monthRange(values.from, values.to) : []),
    ...(values.days
      ? dateRange(...(values.days.split(':') as [string, string]))
      : []),
  ];
  if (!periods.length)
    throw new Error(
      'Usage: residual:history -- --from YYYY-MM [--to YYYY-MM] [--days YYYY-MM-DD:YYYY-MM-DD] [--symbols A,B]',
    );
  const jobs = symbols.flatMap((symbol) =>
    periods.map((period) => ({ symbol, period })),
  );
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { symbol, period } = job,
        url = klineArchiveUrl(symbol, period),
        dir = join(root, 'archives', 'klines', symbol),
        dest = join(dir, url.split('/').at(-1)!);
      await mkdir(dir, { recursive: true });
      let sha256: string;
      try {
        sha256 = await downloadArchive(url, dest);
      } catch (error) {
        console.log({
          symbol,
          period,
          status: 'unavailable',
          error: String(error),
        });
        continue;
      }
      const existing = await readBarManifest(
        join(barDir(root, symbol), `period=${period}.parquet`),
      );
      if (existing?.source.sha256 === sha256) {
        console.log({ symbol, period, status: 'already_imported' });
        continue;
      }
      const zip = await unzipper.Open.file(dest),
        entry = zip.files.find((f) => f.path.endsWith('.csv'));
      if (!entry) throw new Error(`No CSV in ${dest}`);
      const { start, end } = periodBounds(period),
        bars = parseKlineCsv(
          (await entry.buffer()).toString('utf8'),
          start,
          end,
        );
      const manifest = await writeBarPeriod(root, symbol, period, bars, {
        url,
        sha256,
      });
      console.log({ symbol, period, rows: manifest.rows });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

async function backtest() {
  const config = await loadConfig(values.config!),
    startTs = Date.parse(values.from ?? ''),
    endTs = Date.parse(values.to ?? '');
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs))
    throw new Error('Supply --from and --to as UTC times');
  const warmup = new ResidualEngine(config).warmupBars * MINUTE,
    { store, datasetHash, provenance } = await loadBarStore(
      root,
      config.symbols,
      startTs - warmup,
      endTs,
    ),
    run = runResidual(store, config, { startTs, endTs }),
    output = await freshDir(
      values.output ??
        join(root, 'residual', 'backtests', `${config.version}-${Date.now()}`),
    ),
    report = {
      paperOnly: true,
      validationStatus: 'EXPLORATORY_NOT_OUT_OF_SAMPLE',
      config,
      configHash: run.configHash,
      datasetHash,
      provenance,
      range: { startTs, endTs },
      signals: run.signals,
      funnel: run.diagnostics,
      entryRejections: run.rejections,
      ...residualReport(run.trades, run.unfinished),
    };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    join(output, 'trades.jsonl'),
    run.trades.map((t) => JSON.stringify(t)).join('\n') + '\n',
  );
  console.log(
    summary(resolve(output), report.executable, report.hedgedEquivalent),
  );
}
function summary(
  output: string,
  m: ReturnType<typeof residualReport>['executable'],
  hedged?: ReturnType<typeof residualReport>['hedgedEquivalent'],
) {
  const r = (x: number | null | undefined, d = 1) =>
    x == null ? null : Number(x.toFixed(d));
  return {
    output,
    trades: m.closedTrades,
    winRate: r(m.winRate, 3),
    breakevenWinRate: r(m.breakevenWinRate, 3),
    netExpectancyBps: r(m.netExpectancyBps),
    expectancy95: m.eventClusterBootstrap?.netExpectancyBps95.map((x) => r(x)),
    payoffRatio: r(m.netPayoffRatio, 2),
    profitFactor: r(m.profitFactor, 2),
    exits: m.exitReasons,
    ...(hedged
      ? { hedgedEquivalentExpectancyBps: r(hedged.netExpectancyBps) }
      : {}),
  };
}

async function study() {
  const config = await loadConfig(values.config!),
    startTs = Date.parse(values.from ?? ''),
    endTs = Date.parse(values.to ?? '');
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs))
    throw new Error('Supply --from and --to as UTC times');
  const hours = (list: string) =>
      list.split(',').map((h) => Number(h) * 3600000),
    grid = hours(values['lookback-hours']!).flatMap((lookbackMs) =>
      hours(values['hold-hours']!).map((holdMs) =>
        residualSchema.parse({ ...config, lookbackMs, holdMs }),
      ),
    ),
    warmup = Math.max(...grid.map((c) => new ResidualEngine(c).warmupBars)),
    { store, datasetHash } = await loadBarStore(
      root,
      config.symbols,
      startTs - warmup * MINUTE,
      endTs,
    ),
    results = grid.map((c) => residualStudy(store, c, { startTs, endTs })),
    output = await freshDir(
      values.output ??
        join(root, 'residual', 'studies', `${config.version}-${Date.now()}`),
    );
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      { config, datasetHash, range: { startTs, endTs }, results },
      null,
      2,
    ),
  );
  const f = (s: { meanBps: number | null; t: number | null; n: number }) =>
    s.meanBps === null
      ? '-'
      : `${s.meanBps.toFixed(1)} (t ${s.t?.toFixed(1)}, n ${s.n})`;
  for (const r of results) {
    console.log(
      `\nlookback ${r.lookbackMs / 3600000}h, hold ${r.holdMs / 3600000}h, ${r.anchors} anchors; outright round-trip cost ${r.outrightCostBps}bps`,
    );
    console.table(
      r.buckets.map((b) => ({
        z: `${b.z[0]}..${b.z[1]}`,
        side: b.side,
        'outright bps': f(b.outright),
        'hedged bps': f(b.hedged),
        'BTC-confirmed outright': f(b.btcConfirmedOutright),
      })),
    );
  }
  console.log(`Report: ${resolve(output)}`);
}

async function walkForward() {
  if (!values.plan) throw new Error('Supply --plan');
  const { plan, base } = await loadPlan(values.plan),
    { store, datasetHash, provenance } = await loadBarStore(
      root,
      (base as ResidualConfig).symbols,
      Date.parse(plan.dataStart),
      Date.parse(plan.walkForwardEnd),
    ),
    report = residualWalkForward(store, plan, base),
    output = await freshDir(
      values.output ??
        join(root, 'residual', 'walk-forward', `${plan.id}-${Date.now()}`),
    );
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify({ ...report, datasetHash, provenance }, null, 2),
  );
  console.log({
    ...summary(
      resolve(output),
      report.outOfSample.executable,
      report.outOfSample.hedgedEquivalent,
    ),
    folds: report.folds.map((f) => ({
      test: iso(f.test[0]!).slice(0, 10),
      chosen: f.chosen,
      trades: f.testMetrics.closedTrades,
      expectancy: f.testMetrics.netExpectancyBps?.toFixed(1) ?? null,
    })),
    gate: report.gate.passed ? 'PASSED' : report.gate.reasons,
    finalSelection: report.finalSelection?.variantId ?? null,
  });
}

async function holdout() {
  if (!values.plan || !values['walk-forward'])
    throw new Error('Supply --plan and --walk-forward REPORT.json');
  const { plan, base } = await loadPlan(values.plan),
    wf = await readJson(values['walk-forward']),
    warmup =
      new ResidualEngine(
        residualSchema.parse(wf.finalSelection?.config ?? base),
      ).warmupBars * MINUTE,
    { store, datasetHash } = await loadBarStore(
      root,
      (base as ResidualConfig).symbols,
      Date.parse(plan.holdout.start) - warmup,
      Date.parse(plan.holdout.end),
    ),
    result = await residualHoldout(root, store, plan, base, wf),
    output = await freshDir(
      values.output ??
        join(root, 'residual', 'holdout', `${plan.id}-${Date.now()}`),
    );
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify({ ...result, datasetHash }, null, 2),
  );
  console.log({
    ...summary(resolve(output), result.report.executable),
    gate: result.gate.passed ? 'PASSED' : result.gate.reasons,
  });
}

async function live() {
  const config = await loadConfig(values.config!),
    engine = new ResidualEngine(config),
    sim = new ResidualSimulator(engine),
    out =
      values.output ??
      join(
        root,
        'residual',
        'live',
        `${config.version}-${engine.configHash.slice(0, 12)}`,
      ),
    statePath = join(out, 'state.json'),
    maxPublishDelayMs = 90000;
  await mkdir(out, { recursive: true });
  const minuteNow = () => Math.floor(Date.now() / MINUTE) * MINUTE,
    startTs = minuteNow() - (engine.warmupBars + 1440) * MINUTE,
    store = new BarStore(startTs, config.symbols, engine.warmupBars + 4320),
    lastFetched = new Map<string, number>();
  async function fetchNew() {
    const end = minuteNow();
    await Promise.all(
      config.symbols.map(async (symbol) => {
        const from = (lastFetched.get(symbol) ?? startTs - MINUTE) + MINUTE;
        if (from >= end) return;
        try {
          for (const bar of await fetchKlines(symbol, from, end)) {
            store.set(symbol, bar);
            lastFetched.set(symbol, bar.ts);
          }
        } catch (error) {
          console.error(
            `[${iso(Date.now())}] ${symbol} fetch failed: ${error}`,
          );
        }
      }),
    );
  }
  console.log(
    `Bootstrapping ${config.symbols.length} symbols from ${iso(startTs)}…`,
  );
  await fetchNew();
  let saved: { lastCloseTs: number } | null = null;
  try {
    saved = await readJson(statePath);
    sim.restore(saved as Parameters<ResidualSimulator['restore']>[0]);
    console.log(`Restored paper state at ${iso(saved!.lastCloseTs)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let next =
    saved && saved.lastCloseTs >= store.closeTimeAt(0)
      ? store.indexClosingAt(saved.lastCloseTs) + 1
      : Math.max(0, (lastFetched.get('BTCUSDT') ?? startTs) - startTs) / MINUTE;
  const publish = (s: ResidualSignal) =>
    Date.now() - s.decisionTs <= maxPublishDelayMs;
  const record = async (path: string, rows: unknown[]) =>
    rows.length &&
    appendFile(
      join(out, path),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  const saveState = async () => {
    await writeFile(statePath + '.tmp', JSON.stringify(sim.state, null, 2));
    await rename(statePath + '.tmp', statePath);
  };
  let stop = false;
  process.once('SIGINT', () => (stop = true));
  process.once('SIGTERM', () => (stop = true));
  for (;;) {
    for (; next < store.length; next++) {
      const ready = config.symbols.every((s) =>
          Number.isFinite(store.close(s, next)),
        ),
        overdue = Date.now() - store.closeTimeAt(next) > 120000;
      if (!ready && !overdue) break;
      const step = sim.step(store, next, publish);
      for (const s of step.queued)
        console.log(
          `\n[${iso(s.decisionTs)}] SIGNAL ${describeSignal(s, config)}`,
        );
      for (const p of step.opened)
        console.log(
          `[${iso(p.entryTs)}] paper entry ${p.signal.side} ${p.signal.symbol} @ ${px(p.entryPrice)}`,
        );
      for (const t of step.closed)
        console.log(
          `[${iso(t.exitTs)}] paper exit ${t.side} ${t.symbol} ${t.exitReason} net ${t.netReturnBps.toFixed(1)}bps`,
        );
      await record('signals.jsonl', step.queued);
      await record('trades.jsonl', step.closed);
      await saveState();
    }
    const m = residualReport(sim.trades).executable;
    await writeFile(
      join(out, 'health.json'),
      JSON.stringify(
        {
          at: Date.now(),
          lastStepTs: sim.state.lastCloseTs,
          open: sim.positions.map((p: OpenPosition) => ({
            id: p.signal.id,
            entryTs: p.entryTs,
          })),
          funnel: engine.diagnostics.funnel,
          rejections: sim.rejections,
          sessionTrades: m.closedTrades,
          sessionNetExpectancyBps: m.netExpectancyBps,
        },
        null,
        2,
      ),
    );
    if (values.once || stop) break;
    const wait = minuteNow() + MINUTE + 3000 - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1000, wait)));
    if (stop) break;
    await fetchNew();
  }
  if (values.once) {
    const i = store.length - 1,
      latest = engine.evaluate(
        store,
        store.indexClosingAt(
          Math.floor(store.closeTimeAt(i) / config.evaluateEveryMs) *
            config.evaluateEveryMs,
        ),
      );
    const fits = Object.entries(engine.diagnostics.fits);
    console.log(
      `Fits ready: ${fits.filter(([, f]) => f).length}/${fits.length}` +
        fits
          .filter(([, f]) => f)
          .map(
            ([symbol, f]) =>
              `\n  ${symbol} beta ${f!.beta.toFixed(2)} corr ${f!.correlation.toFixed(2)} catch-up ${(f!.reversion * 100).toFixed(0)}% (t ${f!.reversionT.toFixed(1)})`,
          )
          .join(''),
    );
    console.log(
      `Latest evaluation at ${iso(store.closeTimeAt(i))}: ${latest.length} triggered residuals` +
        latest
          .map(
            (s) =>
              `\n  ${s.symbol} ${s.side} z ${s.residualZ.toFixed(2)} ${s.accepted ? 'ACCEPTED' : s.reasons.join(',')}`,
          )
          .join(''),
    );
  }
  console.log(`State saved in ${resolve(out)}`);
}

const commands: Record<string, () => Promise<void>> = {
  history,
  study,
  backtest,
  'walk-forward': walkForward,
  holdout,
  live,
};
const run = commands[command ?? ''];
if (!run)
  throw new Error(
    `Usage: residual <${Object.keys(commands).join('|')}> [options]`,
  );
await run();
