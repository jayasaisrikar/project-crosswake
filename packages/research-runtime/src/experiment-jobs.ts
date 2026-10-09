/**
 * Starts frozen-protocol experiments from the dashboard. The run itself is the
 * same CLI workflow (`pnpm research:experiment`), spawned as a child process,
 * so the dashboard gains no way to alter a protocol or overwrite evidence.
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  identifier,
  listProtocols,
  newExperimentId,
  type RuntimePaths,
} from './experiments.js';

export const launchInput = z.object({ protocolId: identifier }).strict();
const running = new Map<string, number>();

const jobsDir = (paths: RuntimePaths) => join(paths.dataDir, 'experiment-jobs');

function status(paths: RuntimePaths, id: string) {
  const out = join(paths.dataDir, 'experiments', id);
  if (existsSync(join(out, 'COMPLETE.json'))) return 'complete';
  // FAILED is written by the evaluation step; a preflight failure only leaves an exit code.
  if (
    existsSync(join(out, 'FAILED')) ||
    existsSync(join(jobsDir(paths), `${id}.failed`))
  )
    return 'failed';
  return running.has(id) ? 'running' : 'stopped';
}

export async function launchExperiment(paths: RuntimePaths, raw: unknown) {
  const { protocolId } = launchInput.parse(raw);
  if (!(await listProtocols(paths)).includes(protocolId))
    throw Object.assign(new Error('unknown protocol'), { code: 'ENOENT' });
  if (running.size)
    throw Object.assign(new Error('an experiment is already running'), {
      code: 'EBUSY',
    });
  const id = newExperimentId(),
    dir = jobsDir(paths);
  await mkdir(dir, { recursive: true });
  const log = openSync(join(dir, `${id}.log`), 'a');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('apps/supervisor/src/experiment.ts'),
      '--protocol',
      protocolId,
      '--id',
      id,
      '--data-dir',
      paths.dataDir,
      '--protocol-dir',
      paths.protocolDir,
    ],
    { stdio: ['ignore', log, log] },
  );
  running.set(id, child.pid ?? 0);
  child.on('exit', (code) => {
    running.delete(id);
    if (code !== 0)
      void writeFile(join(dir, `${id}.failed`), String(code ?? 'signal'));
  });
  const job = { id, protocolId, startedAt: Date.now() };
  await writeFile(join(dir, `${id}.json`), JSON.stringify(job), { flag: 'wx' });
  return { ...job, status: 'running' };
}

export async function listJobs(paths: RuntimePaths, limit = 20) {
  const dir = jobsDir(paths);
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const jobs = [];
  for (const f of files) {
    const job = JSON.parse(await readFile(join(dir, f), 'utf8'));
    let tail = '';
    try {
      tail = (await readFile(join(dir, `${job.id}.log`), 'utf8')).slice(-600);
    } catch {}
    jobs.push({ ...job, status: status(paths, job.id), logTail: tail });
  }
  return {
    jobs: jobs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit),
    busy: running.size > 0,
  };
}
