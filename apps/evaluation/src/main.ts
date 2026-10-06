import { evidenceGate } from '../../../packages/backtest/src/evidence.js';
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { strategySchema } from '../../../packages/signals/src/index.js';
import {
  planSchema,
  freezeResearch,
  verifyFrozen,
  hash,
} from '../../../packages/backtest/src/research-plan.js';
import {
  walkForward,
  evaluateWindow,
} from '../../../packages/backtest/src/walk-forward.js';
import {
  selectionRecord,
  verifySelection,
  reserveHoldout,
  type SelectionRecord,
} from '../../../packages/backtest/src/holdout.js';
import { riskReport } from '../../../packages/backtest/src/reports.js';
import { openDataset } from '../../../packages/storage/src/read.js';
const [mode, ...args] = process.argv.slice(2).filter((x) => x !== '--');
const { values } = parseArgs({
  args,
  options: {
    plan: { type: 'string' },
    freeze: { type: 'string' },
    selection: { type: 'string' },
    output: { type: 'string' },
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
  },
});
if (mode === 'freeze') {
  if (!values.plan || !values.output)
    throw new Error(
      'Usage: pnpm research:freeze -- --plan PLAN --output NEW_FREEZE_FILE',
    );
  const plan = planSchema.parse(
      JSON.parse(await readFile(values.plan, 'utf8')),
    ),
    base = strategySchema.parse(
      JSON.parse(
        await readFile(resolve(dirname(values.plan), plan.baseConfig), 'utf8'),
      ),
    ),
    frozen = freezeResearch(plan, base);
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(values.output, JSON.stringify(frozen, null, 2), {
    flag: 'wx',
  });
  console.log({
    planHash: frozen.planHash,
    output: resolve(values.output),
    variants: frozen.variants.map((v) => v.id),
  });
} else if (mode === 'walk-forward' || mode === 'holdout') {
  if (!values.freeze) throw new Error('A frozen research file is required');
  const frozen = verifyFrozen(
      JSON.parse(await readFile(values.freeze, 'utf8')),
    ),
    dataset = await openDataset(
      values['data-dir']!,
      frozen.plan.source,
      frozen.plan.symbols,
    );
  const requiredStart = Math.min(
      ...frozen.plan.folds.map((f) => Date.parse(f.trainStart)),
    ),
    requiredEnd =
      mode === 'walk-forward'
        ? Math.max(...frozen.plan.folds.map((f) => Date.parse(f.testEnd)))
        : Date.parse(frozen.plan.holdout.end);
  if (dataset.firstTs > requiredStart || dataset.lastTs < requiredEnd - 1000)
    throw new Error(
      `Insufficient dataset coverage for frozen clocks; need ${new Date(requiredStart).toISOString()} through ${new Date(requiredEnd).toISOString()}, observed ${new Date(dataset.firstTs).toISOString()} through ${new Date(dataset.lastTs).toISOString()}`,
    );
  const output =
    values.output ??
    join(
      values['data-dir']!,
      'backtests',
      `${mode}-${hash({ plan: frozen.planHash, data: dataset.datasetHash }).slice(0, 16)}`,
    );
  await mkdir(dirname(resolve(output)), { recursive: true });
  await mkdir(output, { recursive: false });
  try {
    if (mode === 'walk-forward') {
      const result = await walkForward(
        (range) => dataset.batches(range),
        frozen,
      );
      const selection = selectionRecord(
        frozen,
        hash(
          dataset.provenance.filter(
            (p) => p.lastTs <= Date.parse(frozen.plan.holdout.start),
          ),
        ),
        result.selection.chosen,
        result.selection.qualified,
        evidenceGate(
          result.unseenTrades,
          frozen.plan.acceptance,
          result.folds.reduce((n, f) => n + f.test.unfinished.openPositions, 0),
        ).passed && result.unqualifiedFolds.length === 0,
      );
      await writeFile(
        join(output, 'selection.json'),
        JSON.stringify(selection, null, 2),
      );
      await writeFile(
        join(output, 'report.json'),
        JSON.stringify(
          {
            ...result,
            datasetHash: dataset.datasetHash,
            source: frozen.plan.source,
            risk: riskReport(result.unseenTrades),
            limitations: [
              'Universe is fixed before evaluation; current seed universe is not historically representative',
              'Confidence and lag scoring are exploratory',
              'Parameter selection uses validation only; test blocks are unseen',
              'Fitted relationships are frozen within each block',
              'Unqualified folds remain exploratory; locked holdout and forward paper are required',
            ],
          },
          null,
          2,
        ),
      );
      console.log({
        output,
        unqualifiedFolds: result.unqualifiedFolds,
        unseen: result.unseenMetrics,
      });
    } else {
      if (!values.selection)
        throw new Error('A validation selection file is required');
      const selection = JSON.parse(
          await readFile(values.selection, 'utf8'),
        ) as SelectionRecord,
        variant = verifySelection(frozen, selection);
      if (
        selection.datasetHash !==
        hash(
          dataset.provenance.filter(
            (p) => p.lastTs <= Date.parse(frozen.plan.holdout.start),
          ),
        )
      )
        throw new Error(
          'Pre-holdout dataset changed after selection was frozen',
        );
      const reservation = await reserveHoldout(
        values['data-dir']!,
        frozen,
        selection,
      );
      try {
        const h = frozen.plan.holdout,
          result = await evaluateWindow(
            (range) => dataset.batches(range),
            variant.config,
            Date.parse(h.trainStart),
            Date.parse(h.start),
            Date.parse(h.end),
          );
        const m = result.metrics;
        const gate = evidenceGate(
          result.trades,
          frozen.plan.acceptance,
          result.unfinished.openPositions,
        );
        const statisticalPass = gate.passed && selection.walkForwardPassed;
        const report = {
          planHash: frozen.planHash,
          selection,
          datasetHash: dataset.datasetHash,
          ...result,
          risk: riskReport(result.trades),
          statisticalPass,
          gateReasons: gate.reasons,
          status: statisticalPass
            ? 'STATISTICAL_GATES_PASSED_FORWARD_PAPER_REQUIRED'
            : 'INCONCLUSIVE_OR_FAILED',
          executionAuthorized: false,
        };
        await writeFile(
          join(output, 'report.json'),
          JSON.stringify(report, null, 2),
        );
        await writeFile(
          join(reservation, 'result.json'),
          JSON.stringify(
            { output: resolve(output), reportHash: hash(report) },
            null,
            2,
          ),
        );
        console.log({
          output,
          status: report.status,
          closedTrades: m.closedTrades,
        });
      } catch (error) {
        await writeFile(join(reservation, 'FAILED'), String(error));
        throw error;
      }
    }
  } catch (error) {
    await writeFile(join(output, 'FAILED'), String(error));
    throw error;
  }
} else throw new Error('Expected freeze, walk-forward or holdout mode');
