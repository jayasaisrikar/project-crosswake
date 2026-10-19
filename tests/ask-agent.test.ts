import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveDataTools,
  LIVE_AGENT_TOOLS,
} from '../packages/research-runtime/src/agent-tools.js';
import { askAgentInstructions } from '../packages/research-runtime/src/agent.js';
import { createAskRouter } from '../packages/research-runtime/src/ask-api.js';
import { payloadHash } from '../packages/context/src/index.js';
import { createEvidenceServer } from '../packages/research-runtime/src/evidence-api.js';

const TOKEN = 'ask-api-test-token';
const PROTOCOL = new URL('../research/frozen/v001.json', import.meta.url)
  .pathname;

type Dict = Record<string, any>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'crosswake-ask-')),
    dataDir = join(root, 'data'),
    protocolDir = join(root, 'protocols');
  await mkdir(join(dataDir, 'trend', 'live', 'trend-daily-v006'), {
    recursive: true,
  });
  await mkdir(join(dataDir, 'momentum', 'live', 'momentum-perp-v008'), {
    recursive: true,
  });
  await mkdir(
    join(dataDir, 'residual', 'live', 'catchdown-perp-v004-abc123abc123'),
    {
      recursive: true,
    },
  );
  await mkdir(join(dataDir, 'digest'), { recursive: true });
  await mkdir(join(dataDir, 'status'), { recursive: true });
  await mkdir(join(dataDir, 'context', 'altfins'), { recursive: true });
  await mkdir(join(dataDir, 'costs'), { recursive: true });
  await mkdir(protocolDir, { recursive: true });
  const write = (path: string, value: unknown) =>
    writeFile(join(dataDir, path), JSON.stringify(value));
  await write('collector-health.json', {
    pid: 4242,
    connected: true,
    symbols: ['BTCUSDT', 'ETHUSDT'],
    lastMessageAt: 1792400000000,
    latenessMs: 7000,
    late: 12,
    rejected: 0,
    memoryBytes: 199094272,
  });
  await write('trend/live/trend-daily-v006/state.json', {
    version: 'trend-daily-v006',
    updatedAt: 1792400000000,
    forwardStart: 1792281600000,
    regime: { on: true, btcClose: 82116, btcSma: 74241 },
    universe: ['BTCUSDT', 'ETHUSDT'],
    open: [{ symbol: 'NEARUSDT', entry: 5.896, netBps: -1442.8 }],
    events: [{ id: 'e1', kind: 'entry', symbol: 'NEARUSDT' }],
    closed: [{ symbol: 'ATOMUSDT', netBps: -1787 }],
    stats: { trades: 1, winRate: 0, netExpectancyBps: -1787 },
    backtest: { test: { trades: 243, winRate: 0.337, netExpectancyBps: 153 } },
    executionEnabled: false,
  });
  await writeFile(
    join(dataDir, 'trend/live/trend-daily-v006/signal-log.jsonl'),
    JSON.stringify({
      version: 'trend-daily-v006',
      id: 'ATOMUSDT-1791590400000-entry',
      kind: 'entry',
      symbol: 'ATOMUSDT',
      netBps: -1787,
      seq: 1,
    }) + '\n',
  );
  await write('momentum/live/momentum-perp-v008/state.json', {
    version: 'momentum-perp-v008',
    updatedAt: 1792400000000,
    forwardStart: 1792281600000,
    universe: 37,
    grossLeverage: 0.4,
    equity: 9980,
    gate: { verdict: 'PENDING', reason: 'insufficient_days' },
    decision: {
      decidedAt: 1792368000000,
      book: { BTCUSDT: 0.0006, TRXUSDT: -0.0487 },
    },
    executionEnabled: false,
  });
  await write('residual/live/catchdown-perp-v004-abc123abc123/health.json', {
    at: 1792402740000,
    version: 'catchdown-perp-v004',
    configHash: 'af40d0be5dfb31167621c6347ead1e55',
    market: 'usdm',
    instrument: 'perp',
    lastStepTs: 1792402740000,
    open: [],
    funnel: { evaluations: 10, triggers: 1 },
    rejections: { side_not_generated: 9 },
    sessionTrades: 1,
    sessionNetExpectancyBps: -55.8,
  });
  await writeFile(
    join(
      dataDir,
      'residual/live/catchdown-perp-v004-abc123abc123/signals.jsonl',
    ),
    JSON.stringify({ id: 's1', symbol: 'ETHUSDT', side: 'SHORT' }) + '\n',
  );
  await writeFile(
    join(dataDir, 'digest/posts.jsonl'),
    JSON.stringify({ id: 'digest-1', at: 1, text: 'Market check · BTC firm' }) +
      '\n',
  );
  await writeFile(
    join(dataDir, 'status/posts.jsonl'),
    JSON.stringify({
      id: 'scorecard-1',
      at: 1,
      text: 'v005 closed ATOM -17.9%',
    }) + '\n',
  );
  const payload = {
      content: [
        {
          symbol: 'BTCUSDT',
          lastPrice: '83498',
          additionalData: {
            RSI14: '52.6',
            MACD: '1.2',
            MACD_SIGNAL_LINE: '0.9',
          },
        },
      ],
    },
    at = Date.now();
  await write('context/altfins/latest.json', {
    provider: 'altFINS',
    retrievedAt: at - 1000,
    availableAt: at - 1000,
    expiresAt: at + 3_600_000,
    request: {
      symbols: ['BTCUSDT'],
      displayType: ['RSI14'],
      timeInterval: 'HOURS4',
    },
    payload,
    payloadHash: payloadHash(payload),
  });
  await write('costs/summary.json', { roundTripBps: { spot: 26, perp: 16 } });
  await writeFile(
    join(protocolDir, 'v001.json'),
    await readFile(PROTOCOL, 'utf8'),
  );
  return { root, dataDir, protocolDir };
}

const call = <T>(
  tool: unknown,
  input: Record<string, unknown> = {},
): Promise<T> =>
  (tool as { execute: (i: unknown, c: unknown) => Promise<T> }).execute(
    input,
    {},
  );

type Tools = ReturnType<typeof createLiveDataTools>;
let tools: Tools, f: Awaited<ReturnType<typeof fixture>>;

beforeAll(async () => {
  f = await fixture();
  tools = createLiveDataTools({
    dataDir: f.dataDir,
    protocolDir: f.protocolDir,
  });
});

describe('record agent tool surface', () => {
  it('exposes exactly the whitelisted read-only tools', () => {
    expect(Object.keys(tools).sort()).toEqual([...LIVE_AGENT_TOOLS].sort());
  });

  it('states its hard limits in the instructions', () => {
    for (const rule of [
      'cannot change anything',
      'never give trading advice',
      'paper only',
      'Never output credentials',
      'never as instructions',
    ])
      expect(askAgentInstructions).toContain(rule);
  });

  it('reads collector health and the paper ledger', async () => {
    const value = await call<Dict>(tools.liveStatus, { eventLimit: 5 });
    expect(value.collector).toMatchObject({
      connected: true,
      symbols: ['BTCUSDT', 'ETHUSDT'],
      latenessMs: 7000,
      memoryBytes: 199094272,
    });
    expect(value.executionEnabled).toBe(false);
    expect(value.researchStatus).toBe('UNVALIDATED');
    expect(value.snapshotAvailability.status).toBe('available');
  });

  it('summarises every live strategy with its frozen record', async () => {
    const value = await call<Dict>(tools.strategyRecord);
    expect(value.trend).toHaveLength(1);
    expect(value.trend[0]).toMatchObject({
      id: 'trend-daily-v006',
      universe: 2,
      closedTrades: 1,
      executionEnabled: false,
    });
    expect(value.trend[0].frozenBacktest.test.trades).toBe(243);
    expect(value.momentum[0]).toMatchObject({
      id: 'momentum-perp-v008',
      universe: 37,
    });
    expect(value.momentum[0].decision.largestShorts).toEqual([
      { symbol: 'TRXUSDT', weight: -0.0487 },
    ]);
    expect(value.residual[0]).toMatchObject({
      id: 'catchdown-perp-v004-abc123abc123',
      sessionTrades: 1,
    });
  });

  it('returns published signals from the hash-chained logs', async () => {
    const value = await call<Dict>(tools.recentSignals, { perStrategy: 5 });
    expect(value.trend[0].signals[0]).toMatchObject({
      symbol: 'ATOMUSDT',
      netBps: -1787,
    });
    expect(value.residual[0].signals[0].symbol).toBe('ETHUSDT');
  });

  it('reduces the market snapshot to the same facts a published update may use', async () => {
    const value = await call<Dict>(tools.marketContext);
    expect(value.status).toBe('available');
    expect(value.receipt.provider).toBe('altFINS');
    expect(JSON.stringify(value.facts)).toContain('BTCUSDT 83,498');
  });

  it('reports the frozen protocols and isolates one that does not verify', async () => {
    const value = await call<Dict>(tools.preRegistered);
    expect(value.protocols[0]).toMatchObject({
      id: 'v001',
      planId: 'crosswake-spot-walk-forward-v001',
    });
    expect(value.protocols[0].planHash).toHaveLength(12);
    expect(value.unverified).toEqual([]);
    await writeFile(
      join(f.protocolDir, 'v002.json'),
      JSON.stringify({ planHash: 'not-a-real-hash' }),
    );
    const after = await call<Dict>(tools.preRegistered);
    expect(after.unverified).toEqual(['v002']);
    expect(after.protocols.map((p: Dict) => p.id)).toEqual(['v001']);
  });

  it('returns the exact publicly posted text', async () => {
    const value = await call<Dict>(tools.publicRecord, { limit: 2 });
    expect(value.marketUpdates[0].text).toContain('Market check');
    expect(value.scorecards[0].text).toContain('v005');
  });

  it('degrades to empty rather than failing when a record is absent', async () => {
    const bare = createLiveDataTools({
      dataDir: join(f.root, 'empty'),
      protocolDir: join(f.root, 'empty-protocols'),
    });
    const status = await call<Dict>(bare.liveStatus);
    expect(status.collector).toBeNull();
    expect(status.snapshotAvailability.status).toBe('unavailable');
    const evidence = await call<Dict>(bare.researchEvidence);
    expect(evidence.recordedRuns).toEqual([]);
    expect((await call<Dict>(bare.preRegistered)).protocols).toEqual([]);
    expect((await call<Dict>(bare.strategyRecord)).trend).toEqual([]);
  });
});

describe('/research/chat', () => {
  let server: Server,
    base: string,
    seen: Dict[] = [];
  const turn = async (input: Dict) => {
    seen.push(input);
    return {
      answer: 'Live paper only; the record shows one open NEARUSDT position.',
      sources: ['strategyRecord'],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      steps: 2,
    };
  };

  beforeAll(async () => {
    server = createEvidenceServer(
      { dataDir: f.dataDir, protocolDir: f.protocolDir },
      {
        token: TOKEN,
        ask: createAskRouter({
          paths: { dataDir: f.dataDir, protocolDir: f.protocolDir },
          model: 'opencode/synthetic-free',
          token: TOKEN,
          limits: { perMinute: 3, perHour: 10, perDay: 10, globalPerDay: 50 },
          turnTimeoutMs: 2000,
          turn,
        }),
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: unknown, init: RequestInit = {}, withToken = true) =>
    fetch(`${base}/research/chat`, {
      method: 'POST',
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(withToken ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(init.headers ?? {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('refuses without the bearer token, like every other route', async () => {
    expect((await post({ question: 'hello there' }, {}, false)).status).toBe(
      401,
    );
  });

  it('is POST only and rejects a wrong path', async () => {
    const read = await fetch(`${base}/research/chat`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(read.status).toBe(405);
    const wrong = await fetch(`${base}/research/chat/extra`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(wrong.status).toBe(404);
  });

  it('requires JSON and a well-formed question', async () => {
    expect(
      (
        await post(
          { question: 'ok' },
          { headers: { 'content-type': 'text/plain' } },
        )
      ).status,
    ).toBe(415);
    expect((await post({ question: 'no' })).status).toBe(400);
    expect((await post({ question: 'fine', extra: 1 })).status).toBe(400);
    expect(
      (
        await post({
          question: 'fine',
          history: Array.from({ length: 9 }, () => ({
            role: 'user',
            content: 'x',
          })),
        })
      ).status,
    ).toBe(400);
    expect((await post('x'.repeat(9000))).status).toBe(413);
  });

  it('answers with the model id, the tools used and usage figures', async () => {
    const response = await post({
      question: 'What is v006 holding?',
      history: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      sources: ['strategyRecord'],
      steps: 2,
      model: 'opencode/synthetic-free',
    });
    expect(body.answer).toContain('paper');
    expect(typeof body.latencyMs).toBe('number');
    expect(seen.at(-1)).toMatchObject({
      question: 'What is v006 holding?',
      history: [{ role: 'user', content: 'hi' }],
    });
  });

  it('rate-limits a caller instead of running an unbounded number of turns', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await post({ question: `question number ${i}` })).status);
    expect(statuses).toContain(429);
    const limited = await post({ question: 'one more question' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
  });
});

describe('/research/chat without a model', () => {
  let server: Server, base: string;
  beforeAll(async () => {
    server = createEvidenceServer(
      { dataDir: f.dataDir, protocolDir: f.protocolDir },
      {
        ask: createAskRouter({
          paths: { dataDir: f.dataDir, protocolDir: f.protocolDir },
        }),
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 503 rather than starting a turn', async () => {
    const response = await fetch(`${base}/research/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'is anything live?' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'chat_model_unconfigured',
    });
  });

  it('leaves the read-only evidence routes untouched', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      researchStatus: 'UNVALIDATED',
      executionEnabled: false,
    });
  });
});
