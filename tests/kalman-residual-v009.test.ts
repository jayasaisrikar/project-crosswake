import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BarStore, MINUTE } from '../packages/quant/src/residual.js';
import {
  configHash,
  residualSchema,
  type ResidualSignal,
} from '../packages/signals/src/residual.js';
import {
  KalmanResidualEngine,
  kalmanResidualSchema,
  signalGeometry,
  type KalmanResidualConfig,
} from '../packages/signals/src/kalman-residual.js';
import {
  ResidualSimulator,
  runEngine,
  type SignalEngine,
} from '../packages/backtest/src/residual.js';
import {
  residualHoldout,
  residualPlanSchema,
  residualVariants,
} from '../packages/backtest/src/residual-research.js';
import {
  V004_REGRESSION_DIGEST,
  v004RegressionRun,
} from './fixtures/v004-regression.js';
import base from '../configs/residual-kalman-perp-v009.json' with { type: 'json' };
import control from '../configs/residual-kalman-perp-v009-ols.json' with { type: 'json' };
import plan from '../configs/residual-kalman-plan-v009.json' with { type: 'json' };

const HOUR = 3600000,
  DAY = 86400000,
  start = Date.UTC(2026, 0, 1),
  read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function random(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
}
/** Minute bars: BTC random walk; COINT = 1.5·BTC + OU spread (half-life 16 samples); WALK independent. */
function synthetic(
  days: number,
  seed = 9,
  symbols = ['BTCUSDT', 'COINTUSDT', 'WALKUSDT'],
) {
  const u = random(seed),
    g = () =>
      Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()),
    store = new BarStore(start, symbols),
    theta = Math.LN2 / (16 * 15);
  let btc = 0,
    ou = 0,
    walk = 0;
  for (let i = 0; i < (days * DAY) / MINUTE; i++) {
    const ts = start + i * MINUTE;
    btc += 0.002 * g();
    ou = ou * (1 - theta) + 0.0015 * g();
    walk += 0.0008 * g();
    store.set('BTCUSDT', {
      ts,
      close: 50000 * Math.exp(btc),
      quoteVolume: 1e6,
    });
    if (symbols.includes('COINTUSDT'))
      store.set('COINTUSDT', {
        ts,
        close: 20 * Math.exp(1.5 * btc + ou),
        quoteVolume: 1e6,
      });
    if (symbols.includes('WALKUSDT'))
      store.set('WALKUSDT', {
        ts,
        close: 5 * Math.exp(walk),
        quoteVolume: 1e6,
      });
  }
  return store;
}
const small = (
  over: Partial<KalmanResidualConfig> = {},
): KalmanResidualConfig =>
  kalmanResidualSchema.parse({
    ...base,
    symbols: ['BTCUSDT', 'COINTUSDT', 'WALKUSDT'],
    // Test-only: a 6-day window identifies beta, and a very slow filter keeps the OU spread
    // (half-life 16 samples) from being absorbed into alpha. At the frozen delta 1e-5 this
    // fixture's Kalman spread has a dispersion ratio near 0.3 and a half-life under one sample.
    estimationWindowMs: 6 * DAY,
    kalman: { delta: 1e-9, initBars: 96, scaleObsVar: true },
    zWindowBars: 24,
    persistenceRefits: 2,
    minQuoteVolume24h: 0,
    costSafetyMultiple: 0,
    ...over,
  });
const funnelOf = (store: BarStore, c: KalmanResidualConfig, days: number) => {
  const engine = new KalmanResidualEngine(c),
    first = start + engine.warmupBars * MINUTE,
    run = runEngine(
      store,
      engine,
      { startTs: first, endTs: start + days * DAY },
      new Map(),
    );
  return { run, engine };
};

describe('v009 schema and frozen hashes', () => {
  it('parses base and control, rejects out-of-scope or inconsistent configs', () => {
    expect(kalmanResidualSchema.parse(base).hedgeModel).toBe('kalman');
    expect(kalmanResidualSchema.parse(control).hedgeModel).toBe('ols');
    const { version: _a, hedgeModel: _b, ...restBase } = base;
    const { version: _c, hedgeModel: _d, ...restControl } = control;
    expect(restControl).toEqual(restBase);
    for (const bad of [
      { instrument: 'outright' },
      { market: 'spot' },
      { exitZ: 2.0 },
      { exitZ: 2.5 },
      { evaluateEveryMs: 300000 },
      { holdMs: 3600000 },
    ])
      expect(() => kalmanResidualSchema.parse({ ...base, ...bad })).toThrow();
  });
  it('leaves v003 and v004 config hashes unchanged', () => {
    const h = (p: string) => configHash(residualSchema.parse(read(p)));
    expect(h('configs/catchdown-perp-v004.json')).toBe(
      'af40d0be5dfb31167621c6347ead1e553db0d10f68bc1dbf0476f2e83bb3ac53',
    );
    expect(h('configs/residual-spot-v003.json')).toBe(
      '89f11b1593e6d207807a1ec425a768e09949d2f32d728abf1a210c7f3a044f30',
    );
    expect(h('configs/residual-hedged-v003.json')).toBe(
      '936798896a3df6864921203b2b155d2e619533913b998942ed7cda9b2945968e',
    );
  });
  it('reproduces the v004 fixture trades recorded before the v009 simulator changes', () => {
    expect(v004RegressionRun().digest).toBe(V004_REGRESSION_DIGEST);
  });
  it('never lets the OLS control spend a holdout', async () => {
    const p = residualPlanSchema.parse({
      ...plan,
      id: 'residual-kalman-perp-v009-ols',
      baseConfig: 'residual-kalman-perp-v009-ols.json',
    });
    await expect(
      residualHoldout(
        '/nonexistent',
        new BarStore(start, ['BTCUSDT']),
        p,
        control,
        {
          planHash: '',
          gate: { passed: true } as never,
          finalSelection: null,
        },
      ),
    ).rejects.toThrow(/never spends a holdout/);
  });
  it('builds the 4-variant kalman grid', () => {
    const variants = residualVariants(residualPlanSchema.parse(plan), base);
    expect(variants.map((v) => v.id)).toEqual([
      'entryZ=2,zWindowBars=48',
      'entryZ=2,zWindowBars=96',
      'entryZ=2.5,zWindowBars=48',
      'entryZ=2.5,zWindowBars=96',
    ]);
  });
});

describe('v009 engine', () => {
  const days = 8,
    store = synthetic(days),
    { run, engine } = funnelOf(store, small(), days);
  const signals: ResidualSignal[] = [];
  {
    const e = new KalmanResidualEngine(small()),
      first = store.indexClosingAt(start + e.warmupBars * MINUTE);
    for (let i = first; i < store.length; i++)
      signals.push(...e.evaluate(store, i));
  }

  it('fires on a cointegrated pair in both directions and never on a random walk', () => {
    expect(
      signals.some((s) => s.symbol === 'COINTUSDT' && s.side === 'LONG'),
    ).toBe(true);
    expect(
      signals.some((s) => s.symbol === 'COINTUSDT' && s.side === 'SHORT'),
    ).toBe(true);
    expect(signals.filter((s) => s.symbol === 'WALKUSDT')).toHaveLength(0);
    const walks = synthetic(days, 21, ['BTCUSDT', 'WALKUSDT']),
      only = funnelOf(walks, small({ symbols: ['BTCUSDT', 'WALKUSDT'] }), days);
    expect(only.run.signals).toBe(0);
    expect(only.run.diagnostics.not_cointegrated).toBe(
      only.run.diagnostics.evaluations,
    );
  });

  it('maps z > 0 to SHORT and z < 0 to LONG, with consistent geometry', () => {
    for (const s of signals) {
      expect(s.side).toBe(s.residualZ > 0 ? 'SHORT' : 'LONG');
      expect(s.costBps).toBeCloseTo(16 * (1 + Math.abs(s.beta)));
      expect(s.targetBps).toBeCloseTo(
        Math.abs(s.residualBps) - 0 * s.fit.residualVol * 1e4,
      );
      expect(s.stopBps).toBeCloseTo(
        (4 - Math.abs(s.residualZ)) * s.fit.residualVol * 1e4,
      );
      expect(s.kalman?.hedgeModel).toBe('kalman');
      expect(s.eventId).toBe(
        `kres-${Math.floor(s.decisionTs / (4 * HOUR)) * 4 * HOUR}`,
      );
    }
  });

  it('reconciles the funnel', () => {
    const f = run.diagnostics,
      n = (k: string) => f[k] ?? 0;
    expect(n('evaluations') * 2).toBe(
      n('not_cointegrated') +
        n('fit_unavailable') +
        n('spread_inside_band') +
        n('side_not_generated') +
        n('residual_triggers'),
    );
    expect(n('residual_triggers')).toBe(n('accepted') + n('rejected'));
    expect(engine.diagnostics.dispersionRatios.length).toBeGreaterThan(0);
  });

  it('gives the same signals whenever the run starts (replay = live)', () => {
    const e1 = new KalmanResidualEngine(small()),
      e2 = new KalmanResidualEngine(small()),
      first = store.indexClosingAt(start + e1.warmupBars * MINUTE),
      later = first + 17 * 60 + 23,
      a: ResidualSignal[] = [],
      b: ResidualSignal[] = [];
    for (let i = first; i < store.length; i++)
      a.push(...e1.evaluate(store, i).filter(() => i >= later));
    for (let i = later; i < store.length; i++) b.push(...e2.evaluate(store, i));
    expect(b.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('is causal: later bars do not change a decision', () => {
    const cut = store.indexClosingAt(start + 7 * DAY),
      trimmed = new BarStore(start, store.symbols);
    for (let i = 0; i <= cut; i++)
      for (const s of store.symbols)
        trimmed.set(s, {
          ts: store.tsAt(i),
          close: store.close(s, i),
          quoteVolume: 1e6,
        });
    const e = new KalmanResidualEngine(small()),
      first = store.indexClosingAt(start + e.warmupBars * MINUTE),
      out: ResidualSignal[] = [];
    for (let i = first; i <= cut; i++) out.push(...e.evaluate(trimmed, i));
    expect(out).toEqual(
      signals.filter((s) => s.decisionTs <= trimmed.closeTimeAt(cut)),
    );
  });

  it('computes target, stop, cost and hold from z, mean, sd, beta and half-life', () => {
    const g = signalGeometry(kalmanResidualSchema.parse(base), {
      spread: 0.005,
      mean: 0,
      sd: 0.002,
      z: 2.5,
      beta: 1.4,
      halfLife: 10,
    });
    expect(g.targetBps).toBeCloseTo(50);
    expect(g.stopBps).toBeCloseTo(30);
    expect(g.costBps).toBeCloseTo(16 * 2.4);
    expect(g.holdMs).toBe(3 * 10 * 15 * MINUTE);
    expect(
      signalGeometry(kalmanResidualSchema.parse(base), {
        spread: 1,
        mean: 0,
        sd: 0.2,
        z: 5,
        beta: 1,
        halfLife: 90,
      }).holdMs,
    ).toBe(DAY);
  });
});

describe('v009 simulator changes', () => {
  /** Bars from per-symbol close arrays (one per minute). */
  const path = (series: Record<string, number[]>) => {
    const store = new BarStore(start, Object.keys(series));
    for (const [s, closes] of Object.entries(series))
      closes.forEach(
        (close, i) =>
          Number.isFinite(close) &&
          store.set(s, { ts: start + i * MINUTE, close, quoteVolume: 1e6 }),
      );
    return store;
  };
  const fake = (
    at: Map<number, ResidualSignal[]>,
    over: Partial<SignalEngine['config']> = {},
  ): SignalEngine => ({
    config: {
      version: 'fake',
      instrument: 'hedged',
      market: 'usdm',
      executableSides: ['LONG', 'SHORT'],
      entryDelayMs: MINUTE,
      maxEntryDriftBps: 1000,
      maxConcurrentPositions: 5,
      cooldownMs: 0,
      feeBpsPerSide: 5,
      slippageBpsPerSide: 2,
      spreadBps: 2,
      ...over,
    },
    configHash: 'fake',
    warmupBars: 0,
    minHoldMs: 0,
    isEvaluationBar: (_, i) => at.has(i),
    evaluate: (_, i) => at.get(i) ?? [],
    diagnostics: { funnel: {} },
  });
  const signal = (
    store: BarStore,
    i: number,
    over: Partial<ResidualSignal> = {},
  ): ResidualSignal => {
    const s = over.symbol ?? 'ALTUSDT';
    return {
      id: `${s}-${i}`,
      eventId: 'kres-0',
      symbol: s,
      side: 'LONG',
      instrument: 'hedged',
      decisionTs: store.closeTimeAt(i),
      entryAtTs: store.closeTimeAt(i) + MINUTE,
      referencePrice: store.close(s, i),
      btcReferencePrice: store.close('BTCUSDT', i),
      beta: 1.2,
      btcMoveBps: 0,
      btcZ: 0,
      altMoveBps: 0,
      residualBps: 0,
      residualZ: -2.5,
      lagBps: 500,
      expectedBps: 500,
      costBps: 1,
      expectedNetBps: 499,
      targetBps: 500,
      stopBps: 500,
      rewardRisk: 1,
      targetPrice: null,
      stopPrice: null,
      entryPriceLimit: null,
      holdMs: 2 * HOUR,
      fit: {
        symbol: s,
        asOf: 0,
        samples: 0,
        alpha: 0,
        beta: 1.2,
        correlation: 0,
        residualVol: 0,
        btcVol: 0,
        altVol: 0,
        reversion: 0,
        reversionT: 0,
        reversionSamples: 0,
      },
      accepted: true,
      executable: true,
      reasons: [],
      score: 0,
      scoreKind: 'HEURISTIC_NOT_WIN_PROBABILITY',
      configHash: 'fake',
      modelVersion: 'fake',
      ...over,
    };
  };
  const drive = (sim: ResidualSimulator, store: BarStore) => {
    for (let i = 0; i < store.length; i++) sim.step(store, i);
    return sim;
  };

  it('time-exits each position on its own hold', () => {
    const store = path({
        BTCUSDT: Array(240).fill(100),
        ALTUSDT: Array(240).fill(10),
      }),
      sim = drive(
        new ResidualSimulator(
          fake(new Map([[0, [signal(store, 0)]]]), { maxEntryDriftBps: 1000 }),
          undefined,
          new Map(),
        ),
        store,
      ),
      [t] = sim.trades;
    expect(t!.exitReason).toBe('time');
    expect(t!.exitTs - t!.entryTs).toBe(2 * HOUR);
  });

  it('caps positions per event and side only when configured', () => {
    const store = path({
        BTCUSDT: Array(10).fill(100),
        AUSDT: Array(10).fill(1),
        BUSDT: Array(10).fill(2),
        CUSDT: Array(10).fill(3),
      }),
      three = (s: BarStore) =>
        ['AUSDT', 'BUSDT', 'CUSDT'].map((symbol) => signal(s, 0, { symbol })),
      capped = drive(
        new ResidualSimulator(
          fake(new Map([[0, three(store)]]), { maxPositionsPerEvent: 2 }),
          undefined,
          new Map(),
        ),
        store,
      ),
      free = drive(
        new ResidualSimulator(
          fake(new Map([[0, three(store)]])),
          undefined,
          new Map(),
        ),
        store,
      );
    expect(capped.rejections.event_capacity).toBe(1);
    expect(capped.unfinished.openPositions).toBe(2);
    expect(free.rejections.event_capacity).toBeUndefined();
    expect(free.unfinished.openPositions).toBe(3);
  });

  it('profits on a LONG spread when the alt outperforms beta x BTC', () => {
    const alt = [10, 10, ...Array(200).fill(10.1)],
      store = path({ BTCUSDT: Array(202).fill(100), ALTUSDT: alt }),
      sim = drive(
        new ResidualSimulator(
          fake(new Map([[0, [signal(store, 0, { holdMs: HOUR })]]])),
          undefined,
          new Map(),
        ),
        store,
      );
    expect(sim.trades[0]!.grossReturnBps).toBeGreaterThan(0);
    expect(sim.trades[0]!.hedgedGrossBps).toBeCloseTo(100);
  });

  it('books a hedged target exit at the hedged gross within 1 bps', () => {
    const hit = 10 * Math.exp(0.0100001),
      store = path({
        BTCUSDT: Array(10).fill(100),
        ALTUSDT: [10, 10, hit, hit, hit],
      }),
      sim = drive(
        new ResidualSimulator(
          fake(new Map([[0, [signal(store, 0, { targetBps: 100 })]]])),
          undefined,
          new Map(),
        ),
        store,
      ),
      [t] = sim.trades;
    expect(t!.exitReason).toBe('target');
    expect(Math.abs(t!.grossReturnBps - t!.hedgedGrossBps)).toBeLessThan(1);
  });

  it('charges funding on both legs of a hedged LONG spread', () => {
    const store = path({
        BTCUSDT: Array(200).fill(100),
        ALTUSDT: Array(200).fill(10),
      }),
      settle = start + 30 * MINUTE,
      funding = new Map([
        ['ALTUSDT', [{ ts: settle, rate: 0.0003 }]],
        ['BTCUSDT', [{ ts: settle, rate: 0.0001 }]],
      ]),
      sim = drive(
        new ResidualSimulator(
          fake(new Map([[0, [signal(store, 0, { holdMs: HOUR })]]])),
          undefined,
          funding,
        ),
        store,
      );
    expect(sim.trades[0]!.fundingBps).toBeCloseTo(
      1e4 * (-0.0003 + 1.2 * 0.0001),
    );
  });
});
