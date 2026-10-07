import { once } from 'node:events';
import { Memory } from '@mastra/memory';
import { createEvidenceServer } from '../packages/research-runtime/src/evidence-api.js';
import { resolveModel } from '../packages/research-runtime/src/model.js';
import { describe, it, expect } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import {
  createResearchRuntime,
  researchModes,
  researchSubagents,
  validateDelegation,
} from '../packages/research-runtime/src/runtime.js';
import {
  createExperimentWorkflow,
  readExperiment,
  registryFile,
} from '../packages/research-runtime/src/experiments.js';
import { ParquetWriter } from '../packages/storage/src/index.js';
import { walkForward } from '../packages/backtest/src/walk-forward.js';
import { frozen, frames, loader } from './fixtures/research.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crosswake-runtime-'));
  const protocolDir = join(root, 'protocols');
  await mkdir(protocolDir);
  await writeFile(join(protocolDir, 'synthetic.json'), JSON.stringify(frozen));
  return { root, protocolDir, dataDir: root };
}
describe('research runtime', () => {
  it('persists thread, mode and explicit research state; reapplies permission policies without a model call', async () => {
    const f = await fixture();
    try {
      let runtime = await createResearchRuntime({
        ...f,
        modelId: 'openai/gpt-4.1-mini',
        sessionId: 'persistence',
      });
      const thread = runtime.session.thread.requireId();
      expect(runtime.session.mode.get()).toBe('investigate');
      expect(runtime.session.resolveToolApproval('arbitrary_shell')).toBe(
        'deny',
      );
      expect(runtime.session.resolveToolApproval('research_status')).toBe(
        'allow',
      );
      await expect(runtime.runExperiment('synthetic')).rejects.toThrow(
        'experiment mode',
      );
      const memory = new Memory({ storage: runtime.storage });
      await memory.saveMessages({
        messages: [
          {
            id: 'persistent-message',
            threadId: thread,
            resourceId: 'crosswake',
            role: 'user',
            createdAt: new Date(),
            content: {
              format: 2,
              parts: [{ type: 'text', text: 'Research evidence only' }],
            },
          },
        ],
      });
      await runtime.switchMode('review');
      await runtime.close();
      const bindingPath = join(
        f.root,
        'research-runtime',
        'sessions',
        'persistence.json',
      );
      const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
      binding.state = {
        lastExperimentId: 'crashed-run',
        lastExperimentStatus: 'running',
      };
      await writeFile(bindingPath, JSON.stringify(binding));
      runtime = await createResearchRuntime({
        ...f,
        modelId: 'openai/gpt-4.1-mini',
        sessionId: 'persistence',
      });
      expect(runtime.session.thread.requireId()).toBe(thread);
      expect(runtime.session.mode.get()).toBe('review');
      const persisted = await runtime.controller.queryThreadMessages({
        threadId: thread,
        resourceId: 'crosswake',
      });
      expect(JSON.stringify(persisted)).toContain('Research evidence only');
      expect(runtime.session.state.get()).toMatchObject({
        lastExperimentId: 'crashed-run',
        lastExperimentStatus: 'interrupted',
      });
      expect(runtime.session.resolveToolApproval('arbitrary_shell')).toBe(
        'deny',
      );
      await expect(
        createResearchRuntime({
          ...f,
          modelId: 'openai/gpt-4.1-mini',
          sessionId: 'persistence',
        }),
      ).rejects.toThrow('locked');
      await runtime.close();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }, 20000);
  it('keeps delegation read-only and mode exposure explicit', () => {
    expect(() =>
      validateDelegation({
        agentType: 'data-reviewer',
        task: 'Inspect',
        forked: true,
      }),
    ).toThrow();
    expect(() =>
      validateDelegation({
        agentType: 'data-reviewer',
        task: 'Inspect',
        modelId: 'override',
      }),
    ).toThrow();
    for (const subagent of researchSubagents) {
      expect(subagent.forked).toBe(false);
      expect(subagent.allowedWorkspaceTools).toEqual([]);
      expect(subagent.allowedControllerTools).not.toContain('run_experiment');
    }
    for (const mode of researchModes)
      expect(mode.availableTools!.includes('run_experiment')).toBe(
        mode.id === 'experiment',
      );
  });
  it('matches pure walk-forward results and persists workflow snapshots with no LLM', async () => {
    const f = await fixture();
    const writer = await ParquetWriter.create(f.root);
    const data = frames();
    await writer.write(data.flat());
    writer.close();
    const storage = new LibSQLStore({
      id: 'test-workflow',
      url: `file:${join(f.root, 'workflow.db')}`,
    });
    const workflow = createExperimentWorkflow(f);
    const mastra = new Mastra({ storage, workflows: { experiment: workflow } });
    try {
      const run = await workflow.createRun({
        runId: 'parity',
        resourceId: 'crosswake',
      });
      const result = await run.start({
        inputData: { protocolId: 'synthetic', experimentId: 'parity' },
      });
      expect(result.status).toBe('success');
      const saved = await readExperiment(f, 'parity');
      const pure = await walkForward(loader(data), frozen);
      expect(saved.metrics).toEqual(pure.unseenMetrics);
      const full = JSON.parse(
        await readFile(
          join(f.root, 'experiments', 'parity', 'report.json'),
          'utf8',
        ),
      );
      expect(full.unseenTrades).toEqual(pure.unseenTrades);
      expect(full.executionAuthorized).toBe(false);
      expect((await workflow.listWorkflowRuns({})).runs.length).toBeGreaterThan(
        0,
      );
      const repeat = await workflow.createRun({ runId: 'repeat' });
      expect(
        (
          await repeat.start({
            inputData: { protocolId: 'synthetic', experimentId: 'parity' },
          })
        ).status,
      ).toBe('failed');
      full.source = 'tampered';
      await writeFile(
        join(f.root, 'experiments', 'parity', 'report.json'),
        JSON.stringify(full),
      );
      await expect(readExperiment(f, 'parity')).rejects.toThrow('checksum');
    } finally {
      await mastra.shutdown();
      await rm(f.root, { recursive: true, force: true });
    }
  }, 20000);
  it('fails closed on insufficient data and registry escape', async () => {
    const f = await fixture();
    const writer = await ParquetWriter.create(f.root);
    await writer.write(frames(10).flat());
    writer.close();
    const workflow = createExperimentWorkflow(f);
    const mastra = new Mastra({ workflows: { experiment: workflow } });
    try {
      const run = await workflow.createRun();
      expect(
        (
          await run.start({
            inputData: { protocolId: 'synthetic', experimentId: 'too-short' },
          })
        ).status,
      ).toBe('failed');
      await expect(
        readFile(join(f.root, 'experiments', 'too-short', 'report.json')),
      ).rejects.toThrow();
      await expect(registryFile(f.protocolDir, '../escape')).rejects.toThrow();
      await writeFile(join(f.root, 'outside.json'), '{}');
      await symlink(
        join(f.root, 'outside.json'),
        join(f.protocolDir, 'escape.json'),
      );
      await expect(registryFile(f.protocolDir, 'escape')).rejects.toThrow(
        'escapes',
      );
    } finally {
      await mastra.shutdown();
      await rm(f.root, { recursive: true, force: true });
    }
  }, 20000);
});

it('serves local evidence read-only and rejects mutation and arbitrary file paths', async () => {
  const f = await fixture();
  const server = createEvidenceServer(f);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    expect(await (await fetch(base + '/protocols')).json()).toEqual({
      protocols: ['synthetic'],
    });
    expect((await fetch(base + '/protocols/synthetic')).status).toBe(200);
    expect((await fetch(base + '/protocols/%2E%2E%2Foutside')).status).toBe(
      400,
    );
    expect((await fetch(base + '/experiments/missing')).status).toBe(404);
    expect((await fetch(base + '/health', { method: 'POST' })).status).toBe(
      405,
    );
    expect((await fetch(base + '/health?path=.env')).status).toBe(400);
    expect(await (await fetch(base + '/health')).json()).toEqual({
      collector: null,
      researchStatus: 'UNVALIDATED',
      executionEnabled: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('opencode model resolution', () => {
  it('passes built-in provider IDs through unchanged', () => {
    expect(resolveModel('openai/gpt-4o')).toBe('openai/gpt-4o');
  });
  it('requires OPENCODE_API_KEY for opencode/ models', () => {
    const saved = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      expect(() => resolveModel('opencode/muse-spark-1.3-contributor')).toThrow(
        'OPENCODE_API_KEY',
      );
    } finally {
      if (saved !== undefined) process.env.OPENCODE_API_KEY = saved;
    }
  });
  it('builds a gateway Responses model for opencode/ IDs', () => {
    const saved = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';
    try {
      const model = resolveModel('opencode/muse-spark-1.3-contributor');
      expect(typeof model).toBe('object');
      expect((model as { modelId?: string }).modelId).toBe(
        'muse-spark-1.3-contributor',
      );
    } finally {
      if (saved !== undefined) process.env.OPENCODE_API_KEY = saved;
      else delete process.env.OPENCODE_API_KEY;
    }
  });
});
