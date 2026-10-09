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
    const emptyData = await (await fetch(base + '/data')).json();
    expect(emptyData.sources).toEqual([]);
    expect(emptyData.totalBytes).toBe(0);
    expect((await (await fetch(base + '/backtests')).json()).runs).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(f.root, { recursive: true, force: true });
  }
});

it('requires the bearer token once configured, and accepts no other scheme or value', async () => {
  const f = await fixture();
  const server = createEvidenceServer(f, { token: 'test-token' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  const withAuth = (value: string) => ({ headers: { Authorization: value } });
  try {
    expect((await fetch(base + '/health')).status).toBe(401);
    expect(
      (await fetch(base + '/health', withAuth('Bearer wrong'))).status,
    ).toBe(401);
    // Same length as the expected header, so this exercises the comparison itself.
    expect(
      (await fetch(base + '/health', withAuth('Bearer test-tokeN'))).status,
    ).toBe(401);
    expect(
      (await fetch(base + '/health', withAuth('Basic test-token'))).status,
    ).toBe(401);
    const allowed = await fetch(
      base + '/health',
      withAuth('Bearer test-token'),
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).researchStatus).toBe('UNVALIDATED');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(f.root, { recursive: true, force: true });
  }
});

it('summarises dataset coverage and backtest runs from local files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crosswake-data-')),
    protocolDir = join(root, 'protocols');
  await mkdir(protocolDir);
  const bars = join(
    root,
    'bars',
    'venue=binance',
    'market=spot',
    'interval=1m',
    'symbol=BTCUSDT',
  );
  await mkdir(bars, { recursive: true });
  await writeFile(join(bars, 'period=2026-09.parquet'), 'bars');
  await writeFile(
    join(bars, 'period=2026-09.parquet.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      symbol: 'BTCUSDT',
      period: '2026-09',
      rows: 43200,
      firstTs: 1000,
      lastTs: 2592000000,
    }),
  );
  const live = join(
    root,
    'normalized',
    'venue=binance',
    'market=spot',
    'date=2026-10-01',
    'symbol=ETHUSDT',
  );
  await mkdir(live, { recursive: true });
  await writeFile(join(live, 'a.parquet'), 'x');
  await writeFile(
    join(live, 'a.parquet.manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      rows: 3600,
      quoteEvidence: true,
      firstTs: 1000,
      lastTs: 3600000,
    }),
  );
  await mkdir(join(root, 'raw'));
  await writeFile(join(root, 'raw', '2026-10-01-abc.jsonl'), 'x'.repeat(2048));
  const exploratory = join(root, 'backtests', 'run1');
  await mkdir(exploratory, { recursive: true });
  await writeFile(
    join(exploratory, 'report.json'),
    JSON.stringify({
      config: { version: 'catch-up-v001-exploratory' },
      source: 'live',
      snapshots: 594645,
      candidates: 0,
      closedTrades: 0,
      winRate: null,
      netExpectancyBps: null,
      validationStatus: 'EXPLORATORY_NOT_OUT_OF_SAMPLE',
      firstTs: 1000,
      lastTs: 2000,
      limitations: ['exploratory'],
    }),
  );
  const residual = join(root, 'residual', 'backtests', 'run2');
  await mkdir(residual, { recursive: true });
  await writeFile(
    join(residual, 'report.json'),
    JSON.stringify({
      config: { version: 'residual-spot-v003' },
      validationStatus: 'EXPLORATORY_NOT_OUT_OF_SAMPLE',
      range: { startTs: 1000, endTs: 2000 },
      signals: 7622,
      executable: {
        closedTrades: 10,
        wins: 8,
        losses: 2,
        winRate: 0.8,
        netExpectancyBps: 71.8,
        profitFactor: 2.67,
        btcEventCount: 6,
        eventClusterBootstrap: { netExpectancyBps95: [-58.5, 218.7] },
      },
      researchOnly: {
        closedTrades: 8,
        wins: 5,
        losses: 3,
        winRate: 0.625,
        netExpectancyBps: -38.1,
      },
      funnel: { accepted: 184 },
      limitations: ['paper only'],
    }),
  );
  const server = createEvidenceServer({ dataDir: root, protocolDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const data = await (await fetch(base + '/data')).json();
    expect(data.sources.map((s: any) => s.id).sort()).toEqual([
      'bars',
      'journals',
      'live',
    ]);
    const barSource = data.sources.find((s: any) => s.id === 'bars');
    expect(barSource.rows).toBe(43200);
    expect(barSource.symbols).toEqual([
      expect.objectContaining({ symbol: 'BTCUSDT', rows: 43200 }),
    ]);
    const liveSource = data.sources.find((s: any) => s.id === 'live');
    expect(liveSource.market).toBe('spot');
    expect(liveSource.symbols[0]).toMatchObject({
      symbol: 'ETHUSDT',
      rows: 3600,
      firstTs: 1000,
      lastTs: 3600000,
    });
    const journalSource = data.sources.find((s: any) => s.id === 'journals');
    expect(journalSource.files).toBe(1);
    expect(journalSource.bytes).toBe(2048);
    expect(data.totalBytes).toBeGreaterThan(0);
    const runs = (await (await fetch(base + '/backtests')).json()).runs;
    expect(runs).toHaveLength(2);
    const exploratoryRun = runs.find((r: any) => r.kind === 'exploratory');
    expect(exploratoryRun.strategy).toBe('catch-up-v001-exploratory');
    expect(exploratoryRun.units).toEqual({
      label: 'snapshots',
      value: 594645,
    });
    expect(exploratoryRun.trades.closed).toBe(0);
    expect(exploratoryRun.trades.winRate).toBeNull();
    const residualRun = runs.find((r: any) => r.kind === 'residual');
    expect(residualRun.strategy).toBe('residual-spot-v003');
    expect(residualRun.trades.closed).toBe(10);
    expect(residualRun.trades.winRate).toBe(0.8);
    expect(residualRun.trades.expectancy95).toEqual([-58.5, 218.7]);
    expect(residualRun.researchOnly.closed).toBe(8);
    expect(residualRun.limitations).toEqual(['paper only']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
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

describe('opencode free-model protocol', () => {
  it('builds a chat model for -free IDs', () => {
    const saved = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';
    try {
      const model = resolveModel('opencode/longcat-2.5-preview-free');
      expect(typeof model).toBe('object');
      expect((model as { modelId?: string }).modelId).toBe(
        'longcat-2.5-preview-free',
      );
    } finally {
      if (saved !== undefined) process.env.OPENCODE_API_KEY = saved;
      else delete process.env.OPENCODE_API_KEY;
    }
  });
});
