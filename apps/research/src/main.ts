import { SameEventBenchmarks } from '../../../packages/backtest/src/comparisons.js';
import { riskReport } from '../../../packages/backtest/src/reports.js';
import {
  FixedHorizonTracker,
  RelationshipStudy,
  costStress,
} from '../../../packages/backtest/src/robustness.js';
import { parseArgs } from 'node:util';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openDataset } from '../../../packages/storage/src/read.js';
import {
  SignalEngine,
  strategySchema,
} from '../../../packages/signals/src/index.js';
import {
  PaperBacktester,
  metrics,
} from '../../../packages/backtest/src/index.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((x) => x !== '--'),
  options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    source: { type: 'string', default: 'live' },
    config: { type: 'string', default: 'configs/catch-up-v001.json' },
    output: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  },
});
if (values.source !== 'live' && values.source !== 'historical')
  throw new Error(
    'Source must be live or historical; sources may not be silently mixed',
  );
const range =
  values.from || values.to
    ? {
        startTs: Date.parse(values.from ?? ''),
        endTs: Date.parse(values.to ?? ''),
      }
    : undefined;
if (
  range &&
  (!Number.isSafeInteger(range.startTs) ||
    !Number.isSafeInteger(range.endTs) ||
    range.startTs % 1000 ||
    range.endTs % 1000 ||
    range.startTs >= range.endTs)
)
  throw new Error(
    'Supply both --from and --to as increasing whole-second timestamps',
  );
const config = strategySchema.parse(
    JSON.parse(await readFile(values.config!, 'utf8')),
  ),
  engine = new SignalEngine(config),
  horizons = new FixedHorizonTracker(),
  studies = new RelationshipStudy(),
  dataset = await openDataset(values['data-dir']!, values.source),
  backtest = new PaperBacktester(config),
  benchmarks = config.forward ? new SameEventBenchmarks(config) : undefined,
  runHash = createHash('sha256')
    .update(
      dataset.datasetHash +
        engine.configHash +
        (range ? JSON.stringify(range) : ''),
    )
    .digest('hex'),
  output =
    values.output ??
    join(values['data-dir']!, 'backtests', runHash.slice(0, 16));
await mkdir(join(output, '..'), { recursive: true });
await mkdir(output, { recursive: false });
let snapshots = 0,
  candidates = 0,
  firstTs: number | undefined,
  lastTs: number | undefined;
try {
  for await (const rows of dataset.batches(range)) {
    snapshots += rows.length;
    firstTs ??= rows[0]!.ts;
    lastTs = rows[0]!.ts;
    backtest.update(rows);
    benchmarks?.update(rows);
    horizons.update(rows);
    studies.update(rows);
    const signals = engine.update(rows);
    backtest.submit(signals);
    benchmarks?.submit(signals);
    horizons.submit(signals);
    candidates += signals.length;
    if (signals.length)
      await appendFile(
        join(output, 'candidates.jsonl'),
        signals.map((s) => JSON.stringify(s)).join('\n') + '\n',
      );
  }
  await writeFile(
    join(output, 'trades.jsonl'),
    backtest.trades.map((t) => JSON.stringify(t)).join('\n') +
      (backtest.trades.length ? '\n' : ''),
  );
  horizons.close();
  const report = {
    signalDiagnostics: engine.diagnostics,
    ...(benchmarks ? { benchmarks: benchmarks.report() } : {}),
    risk: riskReport(backtest.trades),
    horizonOutcomes: horizons.summary(),
    relationshipStudies: lastTs ? studies.report(lastTs) : [],
    costStress: costStress(backtest.trades),
    runHash,
    datasetHash: dataset.datasetHash,
    configHash: engine.configHash,
    config,
    source: values.source,
    requestedRange: range ?? null,
    quoteBacked: values.source === 'live',
    firstTs,
    lastTs,
    snapshots,
    candidates,
    files: dataset.paths,
    ...metrics(backtest.trades),
    unfinished: backtest.unfinished,
    entryRejections: backtest.rejections,
    researchOnly: true,
    limitations: [
      'No walk-forward split or locked holdout in this command',
      'Lag selection and confidence are exploratory',
      'Only long trades enter executable metrics',
      'Historical source has no BBO; executable entries are rejected',
    ],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log({
    output: resolve(output),
    snapshots,
    candidates,
    ...metrics(backtest.trades),
  });
} catch (error) {
  await writeFile(join(output, 'FAILED'), String(error));
  throw error;
}
