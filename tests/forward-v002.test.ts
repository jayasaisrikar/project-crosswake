import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ParquetWriter } from '../packages/storage/src/index.js';
import { PriceSeries } from '../packages/quant/src/index.js';
import { forwardModel } from '../packages/quant/src/forward.js';
import {
  SignalEngine,
  strategySchema,
  type Candidate,
} from '../packages/signals/src/index.js';
import {
  PaperBacktester,
  metrics,
  type PaperTrade,
} from '../packages/backtest/src/index.js';
import { evidenceGate } from '../packages/backtest/src/evidence.js';
import {
  freezeResearch,
  planSchema,
  verifyFrozen,
} from '../packages/backtest/src/research-plan.js';
import { SameEventBenchmarks } from '../packages/backtest/src/comparisons.js';
import {
  evaluateWindow,
  evaluateDelayStress,
} from '../packages/backtest/src/walk-forward.js';
import { ShadowRuntime } from '../packages/backtest/src/shadow.js';
import {
  config as legacy,
  snapshot,
  start,
  loader,
  plan,
} from './fixtures/research.js';
import defaults from '../configs/forward-v002.json' with { type: 'json' };
import protocol from '../configs/research-plan-v002.json' with { type: 'json' };

const config = strategySchema.parse({
  ...defaults,
  horizonMs: 1000,
  windowMs: 600000,
  minSamples: 30,
  relationshipRefreshMs: 10000,
  impulseMinMove: 0.0001,
  minBtcQuoteVolume: 0,
  impulseZMin: 0.1,
  gapZMin: 0.1,
  cooldownMs: 1000,
  decisionLatencyMs: 0,
  maxHoldMs: 1000,
  feeBpsPerSide: 0,
  slippageBpsPerSide: 0,
  costSafetyMultiple: 1,
  forward: {
    ...defaults.forward,
    entryDelayMs: 1000,
    dataLatencyBudgetMs: 0,
    outcomeHorizonMs: 1000,
    minValidationSamples: 10,
    universeWindowMs: 60000,
    minAssetQuoteVolume: 1000,
    minNetRewardRisk: 0.01,
    minQuoteCoverage: 1,
    signalTtlMs: 10000,
    maxEntryDriftBps: 100,
  },
  executionCost: {
    ...defaults.executionCost,
    notionalUsdt: 1,
    impactCoefficientBps: 0,
    volatilityMultiplier: 0,
  },
});
function data(
  count = 750,
  kind: 'delayed' | 'simultaneous' = 'delayed',
  reactionSeconds = 2,
) {
  let seed = 73,
    b = 100,
    a = 100;
  const moves: number[] = [];
  return Array.from({ length: count }, (_, i) => {
    seed = (seed * 16807) % 2147483647;
    const r = (seed / 2147483647 - 0.5) * 0.002;
    moves.push(r);
    b *= Math.exp(r);
    seed = (seed * 16807) % 2147483647;
    const noise = (seed / 2147483647 - 0.5) * 0.0001;
    a *= Math.exp(
      (kind === 'delayed' ? (moves[i - reactionSeconds] ?? 0) * 3 : r * 3) +
        noise,
    );
    return [
      snapshot('BTCUSDT', start + i * 1000, b),
      snapshot('ETHUSDT', start + i * 1000, a),
    ];
  });
}
function series(frames: ReturnType<typeof data>) {
  const b = new PriceSeries(3000),
    a = new PriceSeries(3000);
  for (const rows of frames)
    for (const [i, s] of [b, a].entries()) {
      const r = rows[i]!;
      s.add({
        ts: r.ts,
        price: r.close,
        quoteVolume: r.quoteVolume,
        complete: r.isComplete,
        availableAt: r.availableAt ?? r.ts,
      });
    }
  return [b, a] as const;
}
function signal(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 's',
    ts: start,
    decisionTs: start,
    symbol: 'ETHUSDT',
    side: 'LONG',
    btcImpulseId: 'e',
    btcImpulseReturn: 0.01,
    decisionPrice: 100,
    btcDecisionPrice: 100,
    expectedReturn: 0.02,
    actualReturn: 0.001,
    reactionGap: 0.02,
    gapZ: 3,
    confidence: 10,
    estimatedCostBps: 2,
    relationship: {
      asOf: start - 1000,
      n: 60,
      alpha: 0,
      beta: 1,
      correlation: 0.8,
      r2: 0.64,
      residualVol: 0.001,
      lagMs: 1000,
      lagCorrelation: 0.8,
      lagSamples: 60,
      stability: 0.9,
      btcVol: 0.001,
    },
    configHash: 'test',
    modelVersion: 'test',
    accepted: true,
    executable: true,
    reasons: [],
    entryEligibleTs: start + 1000,
    expiresAt: start + 10000,
    entryPriceLimit: 101,
    targetPrice: 100 * Math.exp(0.014),
    predictedNetBps: 138,
    ...overrides,
  };
}
function warm(p: PaperBacktester, end = 1000) {
  for (let ts = start - 40000; ts <= start + end; ts += 1000)
    p.update(batch(ts));
}
function batch(ts: number, alt = 100) {
  return [
    snapshot('BTCUSDT', ts, 100),
    snapshot('ETHUSDT', ts, alt),
    snapshot('SOLUSDT', ts, alt),
  ];
}

describe('forward inference causality', () => {
  it('detects a true future response and refuses simultaneous correlation as predictive evidence', () => {
    const delayed = series(data()),
      simultaneous = series(data(750, 'simultaneous'));
    const fit = (s: ReturnType<typeof series>) =>
      forwardModel(...s, start + 749000, 600000, 1000, 1000, 1000, 30, 10)!;
    const d = fit(delayed),
      z = fit(simultaneous);
    expect(d.btcBeta).toBeCloseTo(3, 1);
    expect(d.incrementalSkill).toBeGreaterThan(0.95);
    expect(d.lastLabelTs).toBeLessThanOrEqual(d.asOf);
    expect(z.incrementalSkill).toBeLessThan(0.05);
  });
  it('ignores all future prices and excludes labels not yet received', () => {
    const rows = data(850),
      before = series(rows.slice(0, 750)),
      after = series(rows);
    const fit = (s: ReturnType<typeof series>) =>
      forwardModel(...s, start + 749000, 600000, 1000, 1000, 1000, 30, 10);
    expect(fit(before)).toEqual(fit(after));
    const unavailable = series(
      rows
        .slice(0, 750)
        .map((rs) => rs.map((r) => ({ ...r, availableAt: start + 900000 }))),
    );
    expect(fit(unavailable)).toBeNull();
  });
  it('returns no fit when missing history or collinearity makes evidence unusable', () => {
    const rows = data().map((rs) =>
      rs.map((r) => ({ ...r, isComplete: false })),
    );
    expect(
      forwardModel(
        ...series(rows),
        start + 749000,
        600000,
        1000,
        1000,
        1000,
        30,
        10,
      ),
    ).toBeNull();
    const identical = data().map((rs) => [
      rs[0]!,
      { ...rs[0]!, symbol: 'ETHUSDT' },
    ]);
    expect(
      forwardModel(
        ...series(identical),
        start + 749000,
        600000,
        1000,
        1000,
        1000,
        30,
        10,
      ),
    ).toBeNull();
  });
  it('generates causal v002 candidates with past-only universe evidence and actionable entry limits', () => {
    const engine = new SignalEngine(config);
    const candidates = data(750, 'delayed', 3).flatMap((r) => engine.update(r));
    const accepted = candidates.filter((c) => c.executable);
    expect(accepted.length).toBeGreaterThan(0);
    const c = accepted[0]!;
    expect(c.forecast!.asOf).toBeLessThan(c.ts);
    expect(c.universeEvidence!.asOf).toBeLessThan(c.ts);
    expect(c.entryEligibleTs).toBe(c.decisionTs + 1000);
    expect(c.scoreKind).toBe('HEURISTIC_NOT_WIN_PROBABILITY');
    expect(engine.diagnostics.funnel.accepted_candidates).toBeGreaterThan(0);
  });
  it('does not let current volume repair prior liquidity or missing quotes repair coverage', () => {
    const engine = new SignalEngine({
      ...config,
      forward: { ...config.forward!, minAssetQuoteVolume: 1e8 },
    });
    const rows = data(750, 'delayed', 3);
    rows.at(-1)![1]!.quoteVolume = 1e12;
    const candidates = rows.flatMap((r) => engine.update(r));
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((c) =>
        c.reasons.includes('insufficient_asset_liquidity'),
      ),
    ).toBe(true);
    const missing = new SignalEngine(config);
    const result = data(750, 'delayed', 3).flatMap((rs) =>
      missing.update(
        rs.map((r) =>
          r.symbol === 'ETHUSDT'
            ? { ...r, bestAsk: null, bestBid: null, quoteTs: null }
            : r,
        ),
      ),
    );
    expect(result.every((c) => !c.executable)).toBe(true);
    expect(missing.diagnostics.funnel.fit_unavailable).toBeGreaterThan(0);
  });
  it('rejects actual receipt delay beyond the declared budget', () => {
    const engine = new SignalEngine(config);
    const result = data(750, 'delayed', 3).flatMap((rs) =>
      engine.update(rs.map((r) => ({ ...r, availableAt: r.ts + 5000 }))),
    );
    expect(result.length).toBeGreaterThan(0);
    expect(
      result.every((c) => c.reasons.includes('data_latency_budget_exceeded')),
    ).toBe(true);
  });
});

describe('entry economics and controls', () => {
  it('requires a quote after the user delay and charges fees/spread once', () => {
    const c = { ...config, feeBpsPerSide: 1, slippageBpsPerSide: 1 },
      p = new PaperBacktester(c);
    warm(p, 0);
    p.submit([signal()]);
    p.update(batch(start + 1000));
    expect(p.entries).toHaveLength(0);
    p.update(batch(start + 2000));
    expect(p.entries).toHaveLength(1);
    p.update(batch(start + 3000));
    expect(p.trades[0]!.netReturnBps).toBeCloseTo(-6, 2);
  });
  it('expires stale signals and rejects chased prices', () => {
    const p = new PaperBacktester(config);
    warm(p);
    p.submit([signal({ expiresAt: start + 2000 })]);
    p.update(batch(start + 2000));
    expect(p.rejections[0]!.reason).toBe('signal_expired');
    const chase = new PaperBacktester(config);
    warm(chase);
    chase.submit([signal({ entryPriceLimit: 100.1 })]);
    chase.update(batch(start + 2000, 100.2));
    expect(chase.rejections[0]!.reason).toBe('entry_price_limit');
  });
  it('rejects insufficient net target payoff even when the full forecast gap looks large', () => {
    const p = new PaperBacktester({
      ...config,
      forward: { ...config.forward!, minNetRewardRisk: 2 },
    });
    warm(p);
    p.submit([signal()]);
    p.update(batch(start + 2000, 100.5));
    expect(p.rejections[0]!.reason).toBe('entry_net_reward_risk_too_low');
  });
  it('ranks net opportunity instead of heuristic score and caps shared BTC exposure', () => {
    const p = new PaperBacktester(config);
    warm(p);
    p.submit([
      signal({ id: 'eth', confidence: 99, predictedNetBps: 100 }),
      signal({
        id: 'sol',
        symbol: 'SOLUSDT',
        confidence: 1,
        predictedNetBps: 200,
      }),
    ]);
    p.update(batch(start + 2000));
    expect(p.entries[0]!.symbol).toBe('SOLUSDT');
    expect(p.entries).toHaveLength(1);
    p.submit([
      signal({
        id: 'event2',
        btcImpulseId: 'e2',
        decisionTs: start + 2000,
        entryEligibleTs: start + 3000,
      }),
    ]);
    // Keep first position open by using a longer hold for a separate risk-cap instance.
    const capped = new PaperBacktester({ ...config, maxHoldMs: 5000 });
    warm(capped);
    capped.submit([signal()]);
    capped.update(batch(start + 2000));
    capped.submit([
      signal({
        id: 's2',
        symbol: 'SOLUSDT',
        btcImpulseId: 'e2',
        entryEligibleTs: start + 2000,
      }),
    ]);
    capped.update(batch(start + 3000));
    expect(capped.entries).toHaveLength(1);
    expect(capped.rejections.at(-1)!.reason).toBe('exposure_limit');
  });
  it('rejects unsupported size and stale/future entry quotes', () => {
    const p = new PaperBacktester({
      ...config,
      executionCost: { ...config.executionCost!, notionalUsdt: 1e9 },
    });
    warm(p);
    p.submit([signal()]);
    p.update(batch(start + 2000));
    expect(p.rejections[0]!.reason).toBe(
      'capacity_or_volatility_evidence_unavailable',
    );
    const q = new PaperBacktester(config);
    warm(q);
    q.submit([signal()]);
    q.update(batch(start + 2000).map((r) => ({ ...r, quoteTs: start + 5000 })));
    expect(q.entries).toHaveLength(0);
  });
  it('runs same-event BTC and alt momentum controls with costs and fixed holding times', () => {
    const controls = new SameEventBenchmarks(config);
    for (let ts = start - 40000; ts <= start + 1000; ts += 1000)
      controls.update(batch(ts));
    controls.submit([signal(), signal({ id: 'duplicate' })]);
    controls.update(batch(start + 2000));
    controls.update(batch(start + 3000));
    const r = controls.report();
    expect(r.selectedEvents).toBe(1);
    expect(r.btc.metrics.closedTrades).toBe(1);
    expect(r.altMomentum.metrics.closedTrades).toBe(1);
    expect(r.btc.metrics.netExpectancyBps).toBeLessThan(0);
  });
  it('updates human entry eligibility from the actual shadow decision clock', async () => {
    // Train engine directly to isolate live processing delay.
    const emitted: any[] = [];
    const replay = new ShadowRuntime(
      config,
      async (events) => {
        emitted.push(...events);
      },
      () => start + 749000 + 9000,
    );
    data(749, 'delayed', 3).forEach((r) => replay.engine.update(r));
    await replay.step(data(750, 'delayed', 3)[749]!);
    const cs = emitted
      .filter((e) => e.kind === 'candidate')
      .map((e) => e.candidate as Candidate);
    expect(cs.length).toBeGreaterThan(0);
    expect(
      cs.every((c) => !c.executable && c.entryEligibleTs === start + 759000),
    ).toBe(true);
  });
});

describe('research policy and frozen compatibility', () => {
  it('allows profitable 40% winners with adequate payoff, but preserves the legacy rejection', () => {
    const trades = Array.from({ length: 1000 }, (_, i) => ({
      signalId: `s${i}`,
      btcImpulseId: `e${i}`,
      symbol: i % 2 ? 'ETHUSDT' : 'SOLUSDT',
      entryTs: start + i * 1000,
      exitTs: start + i * 1000 + 500,
      entryPrice: 100,
      exitPrice: 100,
      grossReturnBps: 0,
      feeBps: 0,
      slippageBps: 0,
      netReturnBps: i % 5 < 2 ? 30 : -10,
      maeBps: 0,
      mfeBps: 0,
      exitReason: 'time' as const,
    }));
    const criteria = planSchema.parse(protocol).acceptance;
    expect(evidenceGate(trades, criteria).passed).toBe(true);
    expect(evidenceGate(trades, plan.acceptance).reasons).toContain(
      'win_rate_below_target',
    );
    expect(metrics(trades)).toMatchObject({
      winRate: 0.4,
      netPayoffRatio: 3,
      breakevenWinRate: 0.25,
    });
    expect(
      evidenceGate(
        trades.map((t) => ({
          ...t,
          netReturnBps: t.netReturnBps > 0 ? 10 : -10,
        })),
        criteria,
      ).reasons,
    ).toContain('expectancy_inconclusive');
    expect(
      evidenceGate(trades, { ...criteria, maxDrawdownBps: 1 }).reasons,
    ).toContain('drawdown_limit');
    expect(
      evidenceGate(
        trades.map((t) => ({ ...t, btcImpulseId: 'one' })),
        criteria,
      ).reasons,
    ).toContain('insufficient_btc_events');
    expect(
      evidenceGate(
        trades.map((t) => ({ ...t, observedGapMs: 1 })),
        criteria,
      ).reasons,
    ).toContain('unobserved_position_path');
  });
  it('validates production v002 and round-trips old frozen provenance unchanged', async () => {
    const c = strategySchema.parse(defaults),
      p = planSchema.parse(protocol);
    expect(
      verifyFrozen(freezeResearch(p, c)).variants[0]!.config.forward,
    ).toBeDefined();
    const old = JSON.parse(await readFile('research/frozen/v001.json', 'utf8'));
    expect(verifyFrozen(old).planHash).toBe(old.planHash);
    expect(
      strategySchema.safeParse({ ...defaults, windowMs: 60000 }).success,
    ).toBe(false);
    expect(
      strategySchema.safeParse({ ...defaults, executionCost: undefined })
        .success,
    ).toBe(false);
    expect(
      planSchema.safeParse({
        ...protocol,
        acceptance: { ...protocol.acceptance, maxDrawdownBps: undefined },
      }).success,
    ).toBe(false);
  });
  it('freezes models before evaluation, purges boundaries and reports delay stress separately', async () => {
    const rows = data(1200, 'delayed', 3),
      load = loader(rows);
    const result = await evaluateWindow(
      load,
      config,
      start,
      start + 750000,
      start + 1000000,
    );
    expect(result.diagnostics.frozen).toBe(true);
    expect(
      Object.values(result.trainingRelationships).every(
        (f) => f.asOf < start + 750000,
      ),
    ).toBe(true);
    expect(result.candidates).toBeGreaterThan(0);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.benchmarks).toBeDefined();
    const stress = await evaluateDelayStress(
      load,
      { ...config, forward: { ...config.forward!, signalTtlMs: 180000 } },
      start,
      start + 750000,
      start + 1000000,
      [1000, 5000],
    );
    expect(stress.results.map((r) => r.entryDelayMs)).toEqual([1000, 5000]);
    expect(stress.selectionUse).toContain('NOT_FOR_OOS_SELECTION');
    await expect(
      evaluateDelayStress(load, legacy, start, start + 750000, start + 1000000),
    ).rejects.toThrow('forward');
  });
});

it('runs the actual v002 research CLI over persisted quote-backed data and writes usable evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosswake-forward-cli-'));
  const writer = await ParquetWriter.create(dir);
  try {
    await writer.write(data(1200, 'delayed', 3).flat());
    const configPath = join(dir, 'config.json'),
      output = join(dir, 'result');
    await writeFile(configPath, JSON.stringify(config));
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/research/src/main.ts',
        '--data-dir',
        dir,
        '--config',
        configPath,
        '--output',
        output,
      ],
      { timeout: 30000 },
    );
    const report = JSON.parse(
      await readFile(join(output, 'report.json'), 'utf8'),
    );
    expect(report.closedTrades).toBeGreaterThan(0);
    expect(report.signalDiagnostics.modelKind).toBe('FORWARD_RETURN');
    expect(report.benchmarks.btc.metrics.closedTrades).toBeGreaterThan(0);
    expect(report.costStress.scenarios).toHaveLength(3);
    expect(report.researchOnly).toBe(true);
    const candidates = (
      await readFile(join(output, 'candidates.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(candidates.every((c) => c.forecast.lastLabelTs < c.ts)).toBe(true);
  } finally {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 40000);

it('reports all five declared human delay scenarios without selecting on their unseen outcomes', async () => {
  const report = await evaluateDelayStress(
    loader([]),
    strategySchema.parse(defaults),
    start,
    start + 86400000,
    start + 172800000,
  );
  expect(report.results.map((r) => r.entryDelayMs)).toEqual([
    5000, 15000, 30000, 60000, 120000,
  ]);
  expect(report.results.every((r) => r.metrics.winRate === null)).toBe(true);
});
