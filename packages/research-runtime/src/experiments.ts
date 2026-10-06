import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  realpath,
} from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyFrozen, hash } from '../../backtest/src/research-plan.js';
import {
  walkForward,
  evaluateWindow,
} from '../../backtest/src/walk-forward.js';
import { evidenceGate } from '../../backtest/src/evidence.js';
import { selectionRecord } from '../../backtest/src/holdout.js';
import { riskReport } from '../../backtest/src/reports.js';
import { openDataset } from '../../storage/src/read.js';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const experimentInput = z
  .object({ protocolId: identifier, experimentId: identifier })
  .strict();
const preparedSchema = experimentInput.extend({
  planHash: z.string(),
  datasetHash: z.string(),
});
const receiptSchema = preparedSchema.extend({
  output: z.string(),
  reportHash: z.string(),
  executionAuthorized: z.literal(false),
});
export type ExperimentReceipt = z.infer<typeof receiptSchema>;
export type RuntimePaths = { dataDir: string; protocolDir: string };

// IDs, never model-supplied paths, address a local registry. Resolve symlinks before use.
export async function registryFile(
  root: string,
  id: string,
  filename?: string,
) {
  identifier.parse(id);
  const base = await realpath(root),
    target = await realpath(
      filename ? join(base, id, filename) : join(base, `${id}.json`),
    );
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Registry path escapes approved root');
  return target;
}
export async function readProtocol(paths: RuntimePaths, id: string) {
  return verifyFrozen(
    JSON.parse(
      await readFile(await registryFile(paths.protocolDir, id), 'utf8'),
    ),
  );
}
export async function listProtocols(paths: RuntimePaths) {
  return (await readdir(paths.protocolDir))
    .filter(
      (x) =>
        x.endsWith('.json') && identifier.safeParse(x.slice(0, -5)).success,
    )
    .map((x) => x.slice(0, -5))
    .sort();
}
function requireCoverage(
  dataset: Awaited<ReturnType<typeof openDataset>>,
  frozen: Awaited<ReturnType<typeof readProtocol>>,
) {
  const start = Math.min(
    ...frozen.plan.folds.map((f) => Date.parse(f.trainStart)),
  );
  const end = Math.max(...frozen.plan.folds.map((f) => Date.parse(f.testEnd)));
  if (dataset.firstTs > start || dataset.lastTs < end - 1000)
    throw new Error(
      'Insufficient dataset coverage for frozen walk-forward clocks',
    );
}
export function createExperimentWorkflow(paths: RuntimePaths) {
  const prepare = createStep({
    id: 'verify-protocol-and-data',
    inputSchema: experimentInput,
    outputSchema: preparedSchema,
    execute: async ({ inputData }) => {
      const frozen = await readProtocol(paths, inputData.protocolId);
      const dataset = await openDataset(
        paths.dataDir,
        frozen.plan.source,
        frozen.plan.symbols,
      );
      requireCoverage(dataset, frozen);
      return {
        ...inputData,
        planHash: frozen.planHash,
        datasetHash: dataset.datasetHash,
      };
    },
  });
  const evaluate = createStep({
    id: 'evaluate-and-publish',
    inputSchema: preparedSchema,
    outputSchema: receiptSchema,
    execute: async ({ inputData }) => {
      const frozen = await readProtocol(paths, inputData.protocolId);
      const dataset = await openDataset(
        paths.dataDir,
        frozen.plan.source,
        frozen.plan.symbols,
      );
      if (
        frozen.planHash !== inputData.planHash ||
        dataset.datasetHash !== inputData.datasetHash
      )
        throw new Error(
          'Experiment inputs changed after preflight; start a new experiment',
        );
      requireCoverage(dataset, frozen);
      const output = resolve(
        paths.dataDir,
        'experiments',
        inputData.experimentId,
      );
      await mkdir(resolve(paths.dataDir, 'experiments'), { recursive: true });
      // No retries may overwrite evidence, including a failed or interrupted run.
      await mkdir(output);
      await writeFile(
        join(output, 'input.json'),
        JSON.stringify(inputData, null, 2),
      );
      try {
        const result = await walkForward(
          (range) => dataset.batches(range),
          frozen,
        );
        const gate = evidenceGate(
          result.unseenTrades,
          frozen.plan.acceptance,
          result.folds.reduce((n, f) => n + f.test.unfinished.openPositions, 0),
        );
        const capacityStress = [];
        for (const notionalUsdt of [100, 1000, 10000]) {
          const folds = [];
          for (const fold of result.folds) {
            const clocks = frozen.plan.folds.find((f) => f.id === fold.id)!;
            const stressConfig = {
              ...fold.selection.chosen.config,
              executionCost: {
                notionalUsdt,
                maxParticipation: 0.01,
                impactCoefficientBps: 10,
                volatilityMultiplier: 0.25,
              },
            };
            const evaluated = await evaluateWindow(
              (range) => dataset.batches(range),
              stressConfig,
              Date.parse(clocks.trainStart),
              Date.parse(clocks.validationEnd),
              Date.parse(clocks.testEnd),
            );
            folds.push({
              id: fold.id,
              metrics: evaluated.metrics,
              unfinished: evaluated.unfinished,
            });
          }
          capacityStress.push({
            notionalUsdt,
            mode: 'STRESS_ONLY_NOT_FOR_SELECTION',
            folds,
          });
        }
        const selection = selectionRecord(
          frozen,
          hash(
            dataset.provenance.filter(
              (p) => p.lastTs <= Date.parse(frozen.plan.holdout.start),
            ),
          ),
          result.selection.chosen,
          result.selection.qualified,
          gate.passed && result.unqualifiedFolds.length === 0,
        );
        const report = {
          ...result,
          capacityStress,
          datasetHash: dataset.datasetHash,
          source: frozen.plan.source,
          risk: riskReport(result.unseenTrades),
          gate,
          executionAuthorized: false as const,
          limitations: [
            'Seed universe and exploratory lag confidence',
            'Quote-sampled fills; size/volatility stress is a proxy, not depth/queue execution',
            'Adaptive live shadow differs from frozen-block evaluation',
            'Holdout and reconciled forward paper remain required',
          ],
        };
        await writeFile(
          join(output, 'report.json'),
          JSON.stringify(report, null, 2),
        );
        await writeFile(
          join(output, 'selection.json'),
          JSON.stringify(selection, null, 2),
        );
        const receipt = {
          ...inputData,
          output,
          reportHash: hash(report),
          executionAuthorized: false as const,
        };
        await writeFile(
          join(output, 'COMPLETE.json'),
          JSON.stringify(receipt, null, 2),
          { flag: 'wx' },
        );
        return receipt;
      } catch (error) {
        await writeFile(join(output, 'FAILED'), String(error));
        throw error;
      }
    },
  });
  return createWorkflow({
    id: 'crosswake-walk-forward',
    inputSchema: experimentInput,
    outputSchema: receiptSchema,
    options: {
      autoRestartActiveRuns: false,
      shouldPersistSnapshot: () => true,
    },
    retryConfig: { attempts: 0, delay: 0 },
  })
    .then(prepare)
    .then(evaluate)
    .commit();
}
export const newExperimentId = () => `experiment-${randomUUID()}`;
export async function readExperiment(paths: RuntimePaths, id: string) {
  const report = JSON.parse(
    await readFile(
      await registryFile(join(paths.dataDir, 'experiments'), id, 'report.json'),
      'utf8',
    ),
  );
  const receipt = receiptSchema.parse(
    JSON.parse(
      await readFile(
        await registryFile(
          join(paths.dataDir, 'experiments'),
          id,
          'COMPLETE.json',
        ),
        'utf8',
      ),
    ),
  );
  if (hash(report) !== receipt.reportHash)
    throw new Error('Experiment report checksum mismatch');
  return {
    receipt,
    qualification: report.qualification,
    metrics: report.unseenMetrics,
    risk: report.risk,
    gate: report.gate,
    unqualifiedFolds: report.unqualifiedFolds,
    limitations: report.limitations,
    capacityStress: report.capacityStress,
    horizonOutcomes: report.folds?.map((f: any) => ({
      foldId: f.id,
      outcomes: f.test.horizonOutcomes,
    })),
  };
}
export async function listExperiments(paths: RuntimePaths) {
  try {
    return (
      await readdir(join(paths.dataDir, 'experiments'), { withFileTypes: true })
    )
      .filter((x) => x.isDirectory() && identifier.safeParse(x.name).success)
      .map((x) => x.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
