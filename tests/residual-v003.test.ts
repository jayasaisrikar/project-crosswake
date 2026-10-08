import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BarStore,
  MINUTE,
  fitResidual,
} from '../packages/quant/src/residual.js';
import {
  ResidualEngine,
  residualSchema,
  type ResidualConfig,
  type ResidualSignal,
} from '../packages/signals/src/residual.js';
import {
  ResidualSimulator,
  residualReport,
  runResidual,
} from '../packages/backtest/src/residual.js';
import {
  residualHoldout,
  residualPlanSchema,
  residualVariants,
  residualWalkForward,
} from '../packages/backtest/src/residual-research.js';
import {
  fetchKlines,
  monthRange,
  parseKline,
  parseKlineCsv,
  periodBounds,
} from '../packages/market-data/src/klines.js';
import {
  barDir,
  loadBarStore,
  writeBarPeriod,
} from '../packages/storage/src/bars.js';
import { describeSignal } from '../apps/residual/src/format.js';
import spot from '../configs/residual-spot-v003.json' with { type: 'json' };
import hedged from '../configs/residual-hedged-v003.json' with { type: 'json' };
import spotPlan from '../configs/residual-plan-spot-v003.json' with { type: 'json' };

const start = Date.UTC(2026, 0, 1),
  HOUR = 3600000,
  DAY = 86400000;
const config = residualSchema.parse({
  ...spot,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  estimationWindowMs: 2 * DAY,
  refitEveryMs: HOUR,
  sampleIntervalMs: 15 * MINUTE,
  lookbackMs: HOUR,
  holdMs: HOUR,
  minFitSamples: 100,
  minReversionSamples: 20,
  btcDirection: 'any',
  minReversionT: 1,
  feeBpsPerSide: 1,
  slippageBpsPerSide: 0,
  spreadBps: 0,
  minQuoteVolume24h: 0,
  minRewardRisk: 0,
  cooldownMs: 0,
});
function random(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}
/** BTC random walk; alts = beta x BTC plus a residual that mean-reverts (theta > 0) or wanders (theta = 0). */
function synthetic(
  days: number,
  { theta = Math.LN2 / 60, seed = 7, from = start } = {},
) {
  const u = random(seed),
    normal = () =>
      Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()),
    store = new BarStore(from, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
    betas = { ETHUSDT: 1.2, SOLUSDT: 1.6 } as const,
    residual = { ETHUSDT: 0, SOLUSDT: 0 };
  let btc = 0;
  for (let i = 0; i < (days * DAY) / MINUTE; i++) {
    const ts = from + i * MINUTE,
      step = 0.0007 * normal();
    btc += step;
    store.set('BTCUSDT', {
      ts,
      close: 50000 * Math.exp(btc),
      quoteVolume: 1e6,
    });
    for (const symbol of ['ETHUSDT', 'SOLUSDT'] as const) {
      residual[symbol] = residual[symbol] * (1 - theta) + 0.0008 * normal();
      store.set(symbol, {
        ts,
        close: 100 * Math.exp(betas[symbol] * btc + residual[symbol]),
        quoteVolume: 1e6,
      });
    }
  }
  return store;
}
function copy(store: BarStore, until: number, from = 0) {
  const out = new BarStore(store.tsAt(from), store.symbols);
  for (let i = from; i <= until; i++)
    for (const s of store.symbols)
      if (Number.isFinite(store.close(s, i)))
        out.set(s, {
          ts: store.tsAt(i),
          close: store.close(s, i),
          quoteVolume: 1e6,
        });
  return out;
}

describe('residual v003 bar store and fit', () => {
  it('aligns bars on one clock and never fills gaps', () => {
    const store = new BarStore(start, ['BTCUSDT', 'ETHUSDT'], 2);
    store.set('BTCUSDT', { ts: start, close: 100, quoteVolume: 5 });
    store.set('BTCUSDT', {
      ts: start + 3 * MINUTE,
      close: 110,
      quoteVolume: 5,
    });
    expect(store.length).toBe(4);
    expect(store.closeTimeAt(0)).toBe(start + MINUTE);
    expect(store.indexClosingAt(start + 4 * MINUTE)).toBe(3);
    expect(store.logReturn('BTCUSDT', 3, 3)).toBeCloseTo(Math.log(1.1));
    expect(store.logReturn('BTCUSDT', 3, 1)).toBeNull();
    expect(store.logReturn('ETHUSDT', 3, 3)).toBeNull();
    expect(store.activity('BTCUSDT', 3, 4)).toEqual({ volume: 10, missing: 2 });
    expect(() =>
      store.set('BTCUSDT', { ts: start + 1, close: 1, quoteVolume: 0 }),
    ).toThrow();
    expect(() => new BarStore(start, ['ETHUSDT'])).toThrow();
  });
  it('recovers beta and distinguishes catch-up from a wandering residual', () => {
    const long = { ...config, estimationWindowMs: 10 * DAY },
      reverting = synthetic(11),
      wandering = synthetic(11, { theta: 0 }),
      i = reverting.length - 1,
      fitA = fitResidual(reverting, 'SOLUSDT', i, long)!,
      fitB = fitResidual(wandering, 'SOLUSDT', i, long)!;
    expect(fitA.beta).toBeGreaterThan(1.3);
    expect(fitA.beta).toBeLessThan(1.9);
    expect(fitA.correlation).toBeGreaterThan(0.5);
    // Theory for a 60-minute half-life with 1h lookback and hold: slope 0.25.
    expect(fitA.reversion).toBeGreaterThan(0.12);
    expect(fitA.reversion).toBeLessThan(0.4);
    expect(fitA.reversionSamples).toBeGreaterThan(200);
    expect(fitA.reversionT).toBeGreaterThan(2);
    expect(Math.abs(fitB.reversionT)).toBeLessThan(2);
    expect(fitA.asOf).toBe(reverting.closeTimeAt(i));
  });
  it('anchors fits to absolute time and ignores later bars', () => {
    const full = synthetic(4),
      i = full.indexClosingAt(start + 3 * DAY),
      shifted = copy(full, i, 37),
      truncated = copy(full, i);
    const a = fitResidual(full, 'ETHUSDT', i, config),
      b = fitResidual(
        shifted,
        'ETHUSDT',
        shifted.indexClosingAt(start + 3 * DAY),
        config,
      ),
      c = fitResidual(truncated, 'ETHUSDT', i, config);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('residual v003 signals', () => {
  it('evaluates causally: changing future bars cannot change a decision', () => {
    const store = synthetic(5),
      other = synthetic(5, { seed: 99 }),
      engineA = new ResidualEngine(config),
      engineB = new ResidualEngine(config);
    let compared = 0;
    for (let i = engineA.warmupBars - 1; i < store.length; i += 60) {
      if (!engineA.isEvaluationBar(store, i)) continue;
      const mixed = copy(store, i);
      for (let j = i + 1; j < store.length; j++)
        for (const s of store.symbols)
          mixed.set(s, {
            ts: store.tsAt(j),
            close: other.close(s, j),
            quoteVolume: 1e6,
          });
      expect(engineB.evaluate(mixed, i)).toEqual(engineA.evaluate(store, i));
      compared++;
    }
    expect(compared).toBeGreaterThan(20);
  });
  it('signals the lagging side with consistent target, stop and price limits', () => {
    const store = synthetic(6),
      strict = residualSchema.parse({ ...config, btcDirection: 'with' }),
      engine = new ResidualEngine(strict),
      signals: ResidualSignal[] = [];
    for (let i = engine.warmupBars; i < store.length; i++)
      if (engine.isEvaluationBar(store, i))
        signals.push(...engine.evaluate(store, i));
    const longs = signals.filter((s) => s.side === 'LONG');
    expect(longs.length).toBeGreaterThan(5);
    for (const s of signals) {
      const d = s.side === 'LONG' ? 1 : -1;
      expect(Math.abs(s.residualZ)).toBeGreaterThanOrEqual(strict.entryZ);
      expect(s.lagBps).toBeCloseTo(-d * s.residualBps);
      expect(s.targetPrice!).toBeCloseTo(
        s.referencePrice * Math.exp((d * s.targetBps) / 1e4),
      );
      expect(s.stopPrice!).toBeCloseTo(
        s.referencePrice * Math.exp((-d * s.stopBps) / 1e4),
      );
      expect(s.executable).toBe(s.accepted && s.side === 'LONG');
      if (s.accepted) expect(d * s.btcMoveBps).toBeGreaterThan(0);
      else if (d * s.btcMoveBps <= 0)
        expect(s.reasons).toContain('btc_move_not_confirming');
      expect(describeSignal(s, strict)).toContain(s.symbol.replace('USDT', ''));
    }
  });
  it('rejects unsafe or inconsistent configurations', () => {
    expect(() =>
      residualSchema.parse({ ...spot, executableSides: ['LONG', 'SHORT'] }),
    ).toThrow(/executable shorts/);
    expect(() =>
      residualSchema.parse({ ...spot, lookbackMs: 600000 }),
    ).toThrow();
    expect(() =>
      residualSchema.parse({ ...spot, estimationWindowMs: DAY }),
    ).toThrow();
    expect(residualSchema.parse(hedged).executableSides).toEqual([
      'LONG',
      'SHORT',
    ]);
  });
});

function stubSimulator(
  store: BarStore,
  signal: Partial<ResidualSignal>,
  at: number[],
  overrides: Partial<ResidualConfig> = {},
) {
  const engine = new ResidualEngine({ ...config, ...overrides });
  engine.isEvaluationBar = (_s, i) => at.includes(i);
  engine.evaluate = (s, i) => [
    {
      ...(baseSignal as ResidualSignal),
      ...signal,
      id: `sig-${i}`,
      decisionTs: s.closeTimeAt(i),
      entryAtTs: s.closeTimeAt(i) + engine.config.entryDelayMs,
    },
  ];
  return new ResidualSimulator(engine);
}
const baseSignal: Partial<ResidualSignal> = {
  eventId: 'e1',
  symbol: 'ETHUSDT',
  side: 'LONG',
  instrument: 'outright',
  referencePrice: 100,
  btcReferencePrice: 100,
  beta: 1,
  targetBps: 100,
  stopBps: 50,
  costBps: 2,
  holdMs: HOUR,
  accepted: true,
  executable: true,
  reasons: [],
};
function path(alt: number[], btc = alt.map(() => 100)) {
  const store = new BarStore(start, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  alt.forEach((p, i) => {
    if (Number.isFinite(p))
      store.set('ETHUSDT', {
        ts: start + i * MINUTE,
        close: p,
        quoteVolume: 1,
      });
    store.set('BTCUSDT', {
      ts: start + i * MINUTE,
      close: btc[i]!,
      quoteVolume: 1,
    });
  });
  return store;
}
function drive(sim: ResidualSimulator, store: BarStore) {
  for (let i = 0; i < store.length; i++) sim.step(store, i);
  return sim;
}

describe('residual v003 paper simulator', () => {
  it('fills targets at the target and stops at the observed close, net of costs', () => {
    const win = drive(
      stubSimulator(path([100, 100, 100.4, 101.5, 101.5]), {}, [0]),
      path([100, 100, 100.4, 101.5, 101.5]),
    );
    const [t] = win.trades;
    expect(t!.exitReason).toBe('target');
    expect(t!.entryTs).toBe(start + 2 * MINUTE);
    expect(t!.grossReturnBps).toBeCloseTo(Math.expm1(0.01) * 1e4);
    expect(t!.netReturnBps).toBeCloseTo(t!.grossReturnBps - 2);
    const lossPath = path([100, 100, 100, 99, 98]),
      loss = drive(stubSimulator(lossPath, {}, [0]), lossPath).trades[0]!;
    expect(loss.exitReason).toBe('stop');
    expect(loss.exitPrice).toBe(99);
    expect(loss.grossReturnBps).toBeCloseTo(-100);
  });
  it('exits on time, rejects drifted or missing entries, and keeps gaps visible', () => {
    const flat = path(Array(70).fill(100)),
      timed = drive(stubSimulator(flat, {}, [0]), flat).trades[0]!;
    expect(timed.exitReason).toBe('time');
    expect(timed.exitTs - timed.entryTs).toBe(HOUR);
    const ran = path([100, 100.5, 100.5, 100.5]),
      drift = drive(stubSimulator(ran, {}, [0]), ran);
    expect(drift.trades).toHaveLength(0);
    expect(drift.rejections.entry_drift).toBe(1);
    const hole = path([100, NaN, 100, 100]),
      missing = drive(stubSimulator(hole, {}, [0]), hole);
    expect(missing.rejections.missing_entry_bar).toBe(1);
    const gappy = path([100, 100, 100, NaN, NaN, 101.2]),
      gap = drive(stubSimulator(gappy, {}, [0]), gappy).trades[0]!;
    expect(gap.observedGapMs).toBe(2 * MINUTE);
  });
  it('hedges BTC exposure in pair mode and enforces one position per symbol', () => {
    const alt = [100, 100, 100, 101, 102],
      btc = [100, 100, 100, 101, 102],
      store = path(alt, btc),
      sim = drive(
        stubSimulator(store, { instrument: 'hedged' }, [0, 1], {
          instrument: 'hedged',
          executableSides: ['LONG', 'SHORT'],
        }),
        store,
      );
    expect(sim.rejections.symbol_busy).toBe(1);
    expect(sim.unfinished.openPositions).toBe(1);
    expect(sim.trades).toHaveLength(0);
  });
  it('restores live state only for the same configuration', () => {
    const store = path(Array(10).fill(100)),
      sim = stubSimulator(store, {}, [0]);
    for (let i = 0; i < 5; i++) sim.step(store, i);
    const again = stubSimulator(store, {}, [0]);
    again.restore(sim.state);
    for (let i = 5; i < 10; i++) again.step(store, i);
    expect(() => again.step(store, 9)).toThrow(/chronological/);
    const other = stubSimulator(store, {}, [0], { entryZ: 3 });
    expect(() => other.restore(sim.state)).toThrow(/another configuration/);
  });
});

describe('residual v003 research', () => {
  const plan = residualPlanSchema.parse({
    ...spotPlan,
    grid: { entryZ: [1.5, 2] },
    dataStart: new Date(start).toISOString(),
    walkForwardEnd: new Date(start + 12 * DAY).toISOString(),
    selectionMs: 2 * DAY,
    testMs: DAY,
    minSelectionTrades: 5,
    holdout: {
      start: new Date(start + 12 * DAY).toISOString(),
      end: new Date(start + 14 * DAY).toISOString(),
    },
    acceptance: {
      ...spotPlan.acceptance,
      minClosedTrades: 1,
      minEvents: 1,
      minAssets: 2,
      maxDrawdownBps: 1e6,
      maxAssetPnlShare: 1,
    },
  });
  it('selects on trailing windows, scores unseen tests, and purges boundaries', () => {
    const all = synthetic(14),
      store = copy(all, all.indexClosingAt(start + 12 * DAY)),
      report = residualWalkForward(store, plan, config);
    expect(residualVariants(plan, config)).toHaveLength(2);
    expect(report.folds.length).toBeGreaterThanOrEqual(6);
    for (const fold of report.folds) {
      expect(fold.selection[1]).toBe(fold.test[0]);
      if (fold.chosen)
        expect(fold.selectionMetrics!.closedTrades).toBeGreaterThanOrEqual(5);
    }
    const oos = report.outOfSample.executable;
    expect(oos.closedTrades).toBeGreaterThan(20);
    expect(oos.netExpectancyBps!).toBeGreaterThan(0);
    expect(report.finalSelection).not.toBeNull();
    expect(() => residualWalkForward(all, plan, config)).toThrow(
      /after walkForwardEnd/,
    );
  });
  it('consumes the holdout once and only after passing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'residual-holdout-')),
      store = synthetic(14),
      wf = residualWalkForward(
        copy(store, store.indexClosingAt(start + 12 * DAY)),
        plan,
        config,
      );
    try {
      await expect(
        residualHoldout(root, store, plan, config, {
          ...wf,
          gate: { ...wf.gate, passed: false },
        }),
      ).rejects.toThrow(/stays sealed/);
      const forced = { ...wf, gate: { ...wf.gate, passed: true } },
        first = await residualHoldout(root, store, plan, config, forced);
      expect(first.report.executable.closedTrades).toBeGreaterThan(0);
      await expect(
        residualHoldout(root, store, plan, config, forced),
      ).rejects.toThrow(/already reserved/);
      await expect(
        residualHoldout(root, store, plan, { ...config, entryZ: 9 }, forced),
      ).rejects.toThrow(/another plan/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('reports executable longs apart from research shorts', () => {
    const run = runResidual(synthetic(6), config, {
        startTs: start + 3 * DAY,
        endTs: start + 6 * DAY,
      }),
      report = residualReport(run.trades);
    expect(report.executable.closedTrades).toBe(
      run.trades.filter((t) => t.side === 'LONG').length,
    );
    expect(report.researchOnly.closedTrades).toBe(
      run.trades.filter((t) => t.side === 'SHORT').length,
    );
    expect(
      run.trades.every(
        (t) =>
          t.decisionTs + config.entryDelayMs + config.holdMs <= start + 6 * DAY,
      ),
    ).toBe(true);
  });
});

describe('residual v003 market data', () => {
  const row = (ts: number, close = '100') => [
    ts,
    '100',
    '101',
    '99',
    close,
    '1',
    ts + MINUTE - 1,
    '1000',
    5,
    '0',
    '0',
    '0',
  ];
  it('parses millisecond and microsecond klines and rejects bad archives', () => {
    expect(parseKline(row(start)).ts).toBe(start);
    expect(
      parseKline([
        start * 1000,
        '100',
        '101',
        '99',
        '100',
        '1',
        (start + MINUTE) * 1000 - 1,
        '1000',
      ]).ts,
    ).toBe(start);
    expect(() => parseKline(row(start + 1))).toThrow();
    expect(() => parseKline(row(start, '102'))).toThrow();
    const csv = [
      'open_time,open',
      row(start).join(','),
      row(start + MINUTE).join(','),
    ].join('\n');
    expect(parseKlineCsv(csv, start, start + DAY)).toHaveLength(2);
    expect(() =>
      parseKlineCsv(
        [row(start + MINUTE), row(start)].map((r) => r.join(',')).join('\n'),
        start,
        start + DAY,
      ),
    ).toThrow(/order/);
    expect(() =>
      parseKlineCsv(row(start + DAY).join(','), start, start + DAY),
    ).toThrow(/outside/);
    expect(monthRange('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(periodBounds('2026-02')).toEqual({
      start: Date.UTC(2026, 1, 1),
      end: Date.UTC(2026, 2, 1),
    });
    expect(
      periodBounds('2026-02-03').end - periodBounds('2026-02-03').start,
    ).toBe(DAY);
  });
  it('pages REST klines and drops bars that have not closed', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      const from = Number(new URL(url).searchParams.get('startTime'));
      const rows = Array.from({ length: from === start ? 1000 : 3 }, (_, k) =>
        row(from + k * MINUTE),
      );
      return new Response(JSON.stringify(rows));
    }) as typeof fetch;
    const bars = await fetchKlines('ETHUSDT', start, start + 2000 * MINUTE, {
      fetcher,
      now: start + 1002 * MINUTE + 30000,
    });
    expect(urls).toHaveLength(2);
    expect(bars).toHaveLength(1002);
    expect(bars.at(-1)!.ts).toBe(start + 1001 * MINUTE);
  });
  it('round-trips verified Parquet bars and rejects tampering or overlap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'residual-bars-'));
    try {
      const bars = (n: number, from: number) =>
        Array.from({ length: n }, (_, k) => ({
          ts: from + k * MINUTE,
          open: 1,
          high: 2,
          low: 1,
          close: 1.5,
          quoteVolume: 3,
        }));
      for (const symbol of ['BTCUSDT', 'ETHUSDT'])
        await writeBarPeriod(root, symbol, '2026-01-01', bars(1440, start), {
          url: 'u',
          sha256: 's',
        });
      const { store, provenance } = await loadBarStore(
        root,
        ['BTCUSDT', 'ETHUSDT'],
        start,
        start + HOUR,
      );
      expect(store.length).toBe(60);
      expect(store.close('ETHUSDT', 59)).toBe(1.5);
      expect(provenance).toHaveLength(2);
      await writeBarPeriod(
        root,
        'ETHUSDT',
        '2026-01',
        bars(10, start + 10 * MINUTE),
        { url: 'u', sha256: 's' },
      );
      await expect(
        loadBarStore(root, ['BTCUSDT', 'ETHUSDT'], start, start + HOUR),
      ).rejects.toThrow(/Overlapping/);
      await rm(join(barDir(root, 'ETHUSDT'), 'period=2026-01.parquet'));
      const [file] = (await readdir(barDir(root, 'BTCUSDT'))).filter((n) =>
        n.endsWith('.parquet'),
      );
      await writeFile(join(barDir(root, 'BTCUSDT'), file!), 'tampered');
      await expect(
        loadBarStore(root, ['BTCUSDT', 'ETHUSDT'], start, start + HOUR),
      ).rejects.toThrow(/checksum/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
