import { spawn } from 'node:child_process';
import { ParquetWriter } from '../packages/storage/src/index.js';
import { liveEvidence } from '../packages/research-runtime/src/live-evidence.js';
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FixedHorizonTracker,
  costStress,
  lagStudy,
} from '../packages/backtest/src/robustness.js';
import { PriceSeries } from '../packages/quant/src/index.js';
import { PaperBacktester } from '../packages/backtest/src/index.js';
import {
  SignalEngine,
  strategySchema,
  type Candidate,
} from '../packages/signals/src/index.js';
import {
  ShadowRuntime,
  type ShadowEvent,
} from '../packages/backtest/src/shadow.js';
import { restoreShadow } from '../packages/backtest/src/recovery.js';
import { JournalReplay } from '../packages/market-data/src/journal.js';
import type { JournalRecord } from '../packages/domain/src/journal.js';
import {
  fetchContext,
  persistContext,
  latestContext,
  contextAt,
  payloadHash,
} from '../packages/context/src/index.js';
import { config, frames, snapshot } from './fixtures/research.js';
function signal() {
  const e = new SignalEngine(config);
  let result: Candidate | undefined;
  for (const rows of frames(184)) {
    const c = e.update(rows);
    result ??= c.find((s) => s.accepted);
  }
  if (!result) throw new Error('No synthetic signal');
  return result;
}
describe('MVP research controls', () => {
  it('keeps fixed horizons distinct by direction and censors missing clocks', () => {
    const s = signal(),
      t = new FixedHorizonTracker([1000, 3000]);
    t.submit([s, { ...s, id: 'short', side: 'SHORT', executable: false }]);
    const start = s.decisionTs + 1000;
    t.update([snapshot(s.symbol, start, 100)]);
    t.update([snapshot(s.symbol, start + 1000, 101)]);
    t.update([snapshot(s.symbol, start + 3000, 103)]);
    t.close();
    expect(
      t.outcomes.find((o) => o.signalId === s.id && o.horizonMs === 1000),
    ).toMatchObject({ status: 'complete' });
    expect(
      t.outcomes.find((o) => o.signalId === 'short' && o.horizonMs === 1000)!
        .returnBps,
    ).toBeCloseTo(-100);
    expect(t.outcomes.find((o) => o.horizonMs === 3000)).toMatchObject({
      status: 'missing_path',
      returnBps: null,
    });
    expect(t.summary().every((x) => x.researchOnly)).toBe(true);
  });
  it('recovers a known lag and runs deterministic maximum-grid shuffle controls', () => {
    const b = new PriceSeries(600),
      a = new PriceSeries(600);
    let seed = 17,
      price = 100;
    const moves: number[] = [];
    for (let i = 0; i < 400; i++) {
      seed = (seed * 16807) % 2147483647;
      moves.push((seed / 2147483647 - 0.5) * 0.002);
      price *= Math.exp(moves[i]!);
      b.add({ ts: 1000000 + i * 1000, price, complete: true, quoteVolume: 1 });
    }
    price = 100;
    for (let i = 0; i < 400; i++) {
      price *= Math.exp(2 * (moves[i - 5] ?? 0));
      a.add({ ts: 1000000 + i * 1000, price, complete: true, quoteVolume: 1 });
    }
    const study = lagStudy(
      b,
      a,
      1399000,
      300000,
      1000,
      [1000, 5000, 15000],
      30,
      99,
    );
    expect(study.best?.lagMs).toBe(5000);
    expect(study.best?.correlation).toBeCloseTo(1);
    expect(study.correctedPermutationP).toBeLessThan(0.05);
    expect(study).toEqual(
      lagStudy(b, a, 1399000, 300000, 1000, [1000, 5000, 15000], 30, 99),
    );
    expect(
      study.shifts.find((s) => s.shiftMs === 5000)?.fit?.correlation,
    ).toBeLessThan(0.5);
  });
  it('cost stress never changes fills or double-charges spread', () => {
    const s = signal(),
      paper = new PaperBacktester(config);
    paper.submit([s]);
    for (let i = 1; i <= 6; i++)
      paper.update([
        snapshot('BTCUSDT', s.decisionTs + i * 1000, s.btcDecisionPrice),
        snapshot(
          s.symbol,
          s.decisionTs + i * 1000,
          s.decisionPrice * (i < 3 ? 1 : 1.02),
        ),
      ]);
    expect(paper.trades.length).toBeGreaterThan(0);
    const original = JSON.stringify(paper.trades),
      stress = costStress(paper.trades);
    expect(stress.scenarios[0]!.metrics).toEqual(
      costStress(paper.trades).scenarios[0]!.metrics,
    );
    expect(stress.scenarios[2]!.metrics.netExpectancyBps!).toBeLessThan(
      stress.scenarios[0]!.metrics.netExpectancyBps!,
    );
    expect(JSON.stringify(paper.trades)).toBe(original);
  });
  it('size/volatility costs reject unsupported capacity and increase observed costs', () => {
    const s = signal(),
      small = new PaperBacktester(
        strategySchema.parse({
          ...config,
          executionCost: {
            notionalUsdt: 100,
            maxParticipation: 0.01,
            impactCoefficientBps: 10,
            volatilityMultiplier: 0.1,
          },
        }),
      ),
      large = new PaperBacktester(
        strategySchema.parse({
          ...config,
          executionCost: {
            notionalUsdt: 1000000,
            maxParticipation: 0.01,
            impactCoefficientBps: 10,
            volatilityMultiplier: 0.1,
          },
        }),
      );
    for (let i = 60; i >= 0; i--)
      for (const p of [small, large])
        p.update([
          snapshot(s.symbol, s.decisionTs - i * 1000, s.decisionPrice),
          snapshot('BTCUSDT', s.decisionTs - i * 1000, s.btcDecisionPrice),
        ]);
    for (const p of [small, large]) p.submit([s]);
    for (let i = 1; i <= 6; i++)
      for (const p of [small, large])
        p.update([
          snapshot('BTCUSDT', s.decisionTs + i * 1000, s.btcDecisionPrice),
          snapshot(
            s.symbol,
            s.decisionTs + i * 1000,
            s.decisionPrice * (i < 3 ? 1 : 1.02),
          ),
        ]);
    expect(large.trades).toHaveLength(0);
    expect(
      large.rejections.some(
        (r) => r.reason === 'capacity_or_volatility_evidence_unavailable',
      ),
    ).toBe(true);
    expect(small.trades[0]!.slippageBps).toBeGreaterThan(
      2 * config.slippageBpsPerSide,
    );
  });
});
describe('point-in-time context', () => {
  it('uses retrieval availability and expiry, with integrity and no secret persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crosswake-context-'));
    try {
      let request: RequestInit | undefined;
      const fake = (async (_url: unknown, options: RequestInit) => {
        request = options;
        return new Response(
          JSON.stringify({
            content: [{ symbol: 'BTC', additionalData: { RSI14: 50 } }],
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      const context = await fetchContext(
        'test-secret',
        ['BTC'],
        fake,
        () => 1000000,
      );
      expect((request?.headers as Record<string, string>)['X-API-KEY']).toBe(
        'test-secret',
      );
      expect(contextAt(context, 999999).status).toBe('not_yet_available');
      expect(contextAt(context, 2000000).status).toBe('stale');
      await persistContext(root, context);
      expect((await latestContext(root, () => 1000001)).status).toBe(
        'available',
      );
      expect(
        await readFile(join(root, 'context', 'altfins', 'latest.json'), 'utf8'),
      ).not.toContain('test-secret');
      expect(() => contextAt({ ...context, payload: {} }, 1000000)).toThrow(
        'integrity',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails without a key or authorization and exposes no provider response body', async () => {
    await expect(fetchContext('', ['BTC'])).rejects.toThrow('not configured');
    await expect(
      fetchContext(
        'secret',
        ['BTC'],
        (async () =>
          new Response('private response', { status: 401 })) as typeof fetch,
      ),
    ).rejects.toThrow('HTTP 401');
    expect(payloadHash({ a: 1 })).toHaveLength(64);
  });
});
it('restores acknowledged paper/model state through an interrupted session exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crosswake-paper-resume-'));
  await mkdir(join(root, 'raw'));
  await mkdir(join(root, 'paper'));
  const journal = join(root, 'raw', 'source.jsonl'),
    ledger = join(root, 'paper', 'source.jsonl');
  const data = frames(184),
    firstTs = data[0]![0]!.ts;
  const records: JournalRecord[] = [
    {
      kind: 'session',
      ts: firstTs - 1000,
      symbols: ['BTCUSDT', 'ETHUSDT'],
      quoteMaxAge: 5000,
      latenessMs: 0,
    },
    { kind: 'connection', ts: firstTs - 1000, connected: true },
  ];
  for (const rows of data) {
    for (const row of rows)
      records.push(
        {
          kind: 'quote',
          symbol: row.symbol,
          bid: row.bestBid!,
          ask: row.bestAsk!,
          ts: row.ts - 1,
          clock: 'receipt',
        },
        {
          kind: 'trade',
          symbol: row.symbol,
          id: row.ts,
          ts: row.ts - 1,
          receivedAt: row.ts - 1,
          price: row.close!,
          quantity: 10,
          buyerMaker: false,
        },
      );
    records.push({
      kind: 'flush',
      ts: rows[0]!.ts + 25,
      watermark: rows[0]!.ts,
      connected: true,
    });
  }
  let clock = 0;
  const emitted: ShadowEvent[] = [],
    original = new ShadowRuntime(
      config,
      async (e) => {
        emitted.push(...e);
      },
      () => clock,
    ),
    replay = new JournalReplay();
  try {
    for (const record of records)
      for (const rows of replay.applyBatches(record)) {
        clock = rows[0]!.availableAt!;
        await original.rows(rows);
      }
    await writeFile(
      journal,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    await writeFile(
      ledger,
      JSON.stringify({
        kind: 'session',
        configHash: original.engine.configHash,
      }) +
        '\n' +
        emitted.map((e) => JSON.stringify(e)).join('\n') +
        '\n',
    );
    const continued: ShadowEvent[] = [],
      restored = await restoreShadow(
        config,
        async (e) => {
          continued.push(...e);
        },
        root,
        [{ journal, ledger }],
        () => clock,
      );
    expect(restored.recoveredSteps).toBe(original.diagnostics.steps);
    expect(restored.runtime.paper.openState.positions.length).toBeGreaterThan(
      0,
    );
    expect(restored.runtime.paper.openState).toEqual(original.paper.openState);
    expect(restored.runtime.engine.relationships).toEqual(
      original.engine.relationships,
    );
    const later = frames(240).slice(184);
    const expected: ShadowEvent[] = [];
    // Original emitter remains attached; compare only events created after restoration.
    const oldCount = emitted.length;
    for (const rows of later) {
      clock = rows[0]!.ts + 25;
      await original.step(rows);
      await restored.runtime.step(rows);
    }
    expected.push(...emitted.slice(oldCount));
    expect(continued).toEqual(expected);
    await writeFile(
      ledger,
      (await readFile(ledger, 'utf8')).replace('"pending":0', '"pending":999'),
    );
    await expect(
      restoreShadow(config, async () => {}, root, [{ journal, ledger }]),
    ).rejects.toThrow('parity');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('operations counts downtime and health deltas over the explicit interval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crosswake-ops-'));
  try {
    const ts = 1700000000000;
    const writer = await ParquetWriter.create(root);
    await writer.write([
      snapshot('BTCUSDT', ts, 100),
      snapshot('ETHUSDT', ts, 100),
    ]);
    writer.close();
    await mkdir(join(root, 'raw'));
    await writeFile(
      join(root, 'raw', 'ops.jsonl'),
      [
        { kind: 'session', ts: ts - 10000, symbols: ['BTCUSDT', 'ETHUSDT'] },
        {
          kind: 'health',
          ts: ts - 1000,
          late: 10,
          rejected: 3,
          memoryBytes: 100,
        },
        {
          kind: 'health',
          ts: ts + 1000,
          late: 12,
          rejected: 4,
          memoryBytes: 200,
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    const output = join(root, 'report.json');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/operations/src/main.ts',
        '--data-dir',
        root,
        '--from',
        new Date(ts).toISOString(),
        '--to',
        new Date(ts + 86400000).toISOString(),
        '--symbols',
        'BTCUSDT,ETHUSDT',
        '--output',
        output,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    child.stdout.on('data', (c) => (log += c));
    child.stderr.on('data', (c) => (log += c));
    expect(
      await new Promise<number | null>((r, j) => {
        child.once('exit', r);
        child.once('error', j);
      }),
      log,
    ).toBe(0);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report).toMatchObject({
      passed24HourGate: false,
      lateObservedInHealthSamples: 2,
      rejectedObservedInHealthSamples: 1,
      peakMemoryBytes: 200,
    });
    expect(report.coverage[0].expectedSeconds).toBe(86400);
    expect(report.coverage[0].completeFraction).toBeCloseTo(1 / 86400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('the evidence API rejects interior ledger corruption but tolerates a partial trailing append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crosswake-ledger-read-'));
  try {
    const paperPath = join(root, 'ledger.jsonl');
    await writeFile(
      join(root, 'collector-health.json'),
      JSON.stringify({ paperPath }),
    );
    await writeFile(paperPath, '{"kind":"entry"}\n{"kind":');
    expect((await liveEvidence(root)).counts.entry).toBe(1);
    await writeFile(paperPath, '{"kind":"entry"}\nbroken\n{"kind":"trade"}\n');
    await expect(liveEvidence(root)).rejects.toThrow('integrity');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
