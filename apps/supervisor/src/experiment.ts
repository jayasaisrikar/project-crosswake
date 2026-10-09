import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  createExperimentWorkflow,
  identifier,
  newExperimentId,
} from '../../../packages/research-runtime/src/experiments.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((x) => x !== '--'),
  options: {
    protocol: { type: 'string', default: 'v001' },
    // Lets the dashboard launcher know the run id before the run starts.
    id: { type: 'string' },
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    'protocol-dir': { type: 'string', default: 'research/frozen' },
  },
});
const dataDir = resolve(values['data-dir']!);
await mkdir(join(dataDir, 'research-runtime'), { recursive: true });
const storage = new LibSQLStore({
  id: 'crosswake-experiment-storage',
  url: `file:${join(dataDir, 'research-runtime', 'mastra.db')}`,
});
const workflow = createExperimentWorkflow({
  dataDir,
  protocolDir: resolve(values['protocol-dir']!),
});
const mastra = new Mastra({ storage, workflows: { experiment: workflow } });
try {
  const run = await workflow.createRun({
    runId: values.id ? identifier.parse(values.id) : newExperimentId(),
    resourceId: 'crosswake',
  });
  const result = await run.start({
    inputData: { protocolId: values.protocol!, experimentId: run.runId },
  });
  if (result.status !== 'success')
    throw new Error(
      `Workflow ${run.runId}: ${result.status}; ${'error' in result ? String(result.error) : 'inspect stored snapshot'}`,
    );
  console.log(result.result);
} finally {
  await mastra.shutdown();
}
