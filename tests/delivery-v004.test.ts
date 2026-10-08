import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BarStore, MINUTE } from '../packages/quant/src/residual.js';
import {
  ResidualEngine,
  residualSchema,
  type ResidualSignal,
} from '../packages/signals/src/residual.js';
import { ResidualSimulator } from '../packages/backtest/src/residual.js';
import { costStress } from '../packages/backtest/src/robustness.js';
import {
  residualPlanSchema,
  residualWalkForward,
} from '../packages/backtest/src/residual-research.js';
import {
  fetchFunding,
  fetchKlines,
  fundingArchiveUrl,
  klineArchiveUrl,
  parseFundingCsv,
} from '../packages/market-data/src/klines.js';
import {
  measureBook,
  parseBook,
  summarizeDepth,
  sweepBps,
} from '../packages/market-data/src/depth.js';
import {
  barDir,
  fundingDir,
  loadFunding,
  writeFundingPeriod,
} from '../packages/storage/src/bars.js';
import {
  TelegramSink,
  deliver,
  sinksFromEnv,
} from '../packages/notify/src/index.js';
import { createEvidenceServer } from '../packages/research-runtime/src/evidence-api.js';
import {
  readLedger,
  recordFill,
} from '../packages/research-runtime/src/residual-evidence.js';
import spot from '../configs/residual-spot-v003.json' with { type: 'json' };
import catchdown from '../configs/catchdown-perp-v004.json' with { type: 'json' };
import catchdownPlan from '../configs/catchdown-plan-v004.json' with { type: 'json' };

const start = Date.UTC(2026, 0, 1),
  HOUR = 3600000,
  DAY = 86400000;

describe('perpetual market support', () => {
  it('allows executable outright shorts only on perpetuals', () => {
    expect(residualSchema.parse(catchdown).executableSides).toEqual(['SHORT']);
    expect(() =>
      residualSchema.parse({ ...catchdown, market: undefined }),
    ).toThrow(/executable shorts/);
    expect(() =>
      residualSchema.parse({ ...catchdown, market: 'spot' }),
    ).toThrow(/executable shorts/);
    expect(
      residualSchema.parse(spot).market,
      'v003 configs keep their original shape and hash',
    ).toBeUndefined();
  });
  it('builds archive URLs and validates funding archives', () => {
    expect(klineArchiveUrl('SOLUSDT', '2026-09', 'usdm')).toBe(
      'https://data.binance.vision/data/futures/um/monthly/klines/SOLUSDT/1m/SOLUSDT-1m-2026-09.zip',
    );
    expect(klineArchiveUrl('SOLUSDT', '2026-10-07')).toContain(
      '/spot/daily/klines/',
    );
    expect(fundingArchiveUrl('SOLUSDT', '2026-09')).toContain(
      '/futures/um/monthly/fundingRate/SOLUSDT/',
    );
    const csv = `calc_time,funding_interval_hours,last_funding_rate\n${start + 5},8,0.0001\n${start + 8 * HOUR},8,-0.00005\n`;
    expect(parseFundingCsv(csv, start, start + DAY)).toEqual([
      { ts: start + 5, rate: 0.0001 },
      { ts: start + 8 * HOUR, rate: -0.00005 },
    ]);
    expect(() =>
      parseFundingCsv(`${start + DAY},8,0.0001`, start, start + DAY),
    ).toThrow(/outside/);
    expect(() => parseFundingCsv(`${start},8,0.2`, start, start + DAY)).toThrow(
      /Invalid funding/,
    );
  });
  it('pages perpetual REST klines and funding', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.includes('fundingRate'))
        return new Response(
          JSON.stringify([
            { fundingTime: start + 8 * HOUR, fundingRate: '0.0001' },
            { fundingTime: start + 16 * HOUR, fundingRate: '0.0002' },
          ]),
        );
      return new Response(
        JSON.stringify([
          [start, '1', '1', '1', '1', '1', start + MINUTE - 1, '5'],
        ]),
      );
    }) as typeof fetch;
    const bars = await fetchKlines('SOLUSDT', start, start + HOUR, {
      market: 'usdm',
      fetcher,
      now: start + DAY,
    });
    expect(bars).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/fapi\.binance\.com\/fapi\/v1\/klines/);
    expect(
      (await fetchFunding('SOLUSDT', start, start + DAY, { fetcher })).map(
        (e) => e.rate,
      ),
    ).toEqual([0.0001, 0.0002]);
  });
  it('stores verified funding and rejects tampering or overlap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funding-'));
    try {
      await writeFundingPeriod(
        root,
        'SOLUSDT',
        '2026-01',
        [
          { ts: start + 8 * HOUR, rate: 0.0001 },
          { ts: start + 16 * HOUR, rate: 0.0002 },
        ],
        { url: 'u', sha256: 's' },
      );
      const { book } = await loadFunding(root, ['SOLUSDT'], start, start + DAY);
      expect(book.get('SOLUSDT')).toHaveLength(2);
      await writeFundingPeriod(
        root,
        'SOLUSDT',
        '2026-01-01_2026-01-01',
        [{ ts: start + 16 * HOUR, rate: 0.0002 }],
        { url: 'rest', sha256: null },
      );
      await expect(
        loadFunding(root, ['SOLUSDT'], start, start + DAY),
      ).rejects.toThrow(/Overlapping/);
      await writeFile(
        join(fundingDir(root, 'SOLUSDT'), 'period=2026-01.json'),
        '[]',
      );
      await expect(
        loadFunding(root, ['SOLUSDT'], start, start + DAY),
      ).rejects.toThrow(/checksum/);
      expect(barDir(root, 'SOLUSDT', 'usdm')).toContain('market=usdm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const perp = residualSchema.parse({
  ...catchdown,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  estimationWindowMs: 2 * DAY,
  refitEveryMs: HOUR,
  lookbackMs: HOUR,
  holdMs: HOUR,
  minFitSamples: 100,
  minReversionSamples: 20,
  cooldownMs: 0,
});
function path(alt: number[], btc = alt.map(() => 100)) {
  const store = new BarStore(start, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  alt.forEach((p, i) => {
    store.set('ETHUSDT', { ts: start + i * MINUTE, close: p, quoteVolume: 1 });
    store.set('BTCUSDT', {
      ts: start + i * MINUTE,
      close: btc[i]!,
      quoteVolume: 1,
    });
  });
  return store;
}
function shortSim(store: BarStore, overrides = {}, funding = new Map()) {
  const engine = new ResidualEngine({ ...perp, ...overrides });
  engine.isEvaluationBar = (_s, i) => i === 0;
  engine.evaluate = (s, i) => [
    {
      id: 'short-1',
      eventId: 'e1',
      symbol: 'ETHUSDT',
      side: 'SHORT',
      instrument: engine.config.instrument,
      decisionTs: s.closeTimeAt(i),
      entryAtTs: s.closeTimeAt(i) + engine.config.entryDelayMs,
      referencePrice: 100,
      btcReferencePrice: 100,
      beta: 2,
      targetBps: 500,
      stopBps: 500,
      costBps: 16,
      holdMs: engine.config.holdMs,
      accepted: true,
      executable: true,
      reasons: [],
    } as unknown as ResidualSignal,
  ];
  const sim = new ResidualSimulator(engine, undefined, funding);
  for (let i = 0; i < store.length; i++) sim.step(store, i);
  return sim;
}

describe('funding accounting', () => {
  const flat = path(Array(70).fill(100)),
    funding = new Map([
      ['ETHUSDT', [{ ts: start + 30 * MINUTE, rate: 0.001 }]],
      ['BTCUSDT', [{ ts: start + 30 * MINUTE, rate: 0.0004 }]],
    ]);
  it('credits shorts with positive funding and requires a funding book', () => {
    const [t] = shortSim(flat, {}, funding).trades;
    expect(t!.exitReason).toBe('time');
    expect(t!.fundingBps).toBeCloseTo(10);
    expect(t!.netReturnBps).toBeCloseTo(-t!.feeBps - t!.slippageBps + 10);
    expect(() => new ResidualSimulator(new ResidualEngine(perp))).toThrow(
      /funding/,
    );
    const stressed = costStress([t!]).scenarios[0]!.metrics;
    expect(stressed.netExpectancyBps).toBeCloseTo(t!.netReturnBps);
  });
  it('nets the beta-sized BTC leg in pair mode', () => {
    const [t] = shortSim(
      flat,
      {
        instrument: 'hedged',
        sides: ['LONG', 'SHORT'],
        executableSides: ['SHORT'],
      },
      funding,
    ).trades;
    // Short alt receives 10 bps; long 2x BTC pays 2 x 4 bps.
    expect(t!.fundingBps).toBeCloseTo(10 - 8);
  });
  it('ignores funding settled outside the holding period', () => {
    const late = new Map([
      ['ETHUSDT', [{ ts: start + 3 * HOUR, rate: 0.001 }]],
    ]);
    expect(shortSim(flat, {}, late).trades[0]!.fundingBps).toBe(0);
  });
  it('starts unseen tests at the declared clock and needs a full selection window', () => {
    const plan = residualPlanSchema.parse({
      ...catchdownPlan,
      dataStart: new Date(start).toISOString(),
      firstTestStart: new Date(start + 6 * DAY).toISOString(),
      walkForwardEnd: new Date(start + 8 * DAY).toISOString(),
      selectionMs: 2 * DAY,
      testMs: DAY,
      holdout: {
        start: new Date(start + 8 * DAY).toISOString(),
        end: new Date(start + 9 * DAY).toISOString(),
      },
    });
    const store = path(Array((8 * DAY) / MINUTE).fill(100)),
      report = residualWalkForward(store, plan, perp, new Map());
    expect(report.folds.map((f) => f.test[0])).toEqual([
      start + 6 * DAY,
      start + 7 * DAY,
    ]);
    expect(() =>
      residualWalkForward(
        store,
        { ...plan, firstTestStart: new Date(start + 3 * DAY).toISOString() },
        perp,
        new Map(),
      ),
    ).toThrow(/selection window/);
  });
});

describe('order-book cost measurement', () => {
  const raw = {
    bids: [
      ['99.9', '10'],
      ['99.8', '100'],
    ],
    asks: [
      ['100.1', '10'],
      ['100.2', '100'],
    ],
  };
  it('validates books and sweeps visible levels', () => {
    const book = parseBook(raw);
    expect(() => parseBook({ ...raw, bids: [['100.2', '1']] })).toThrow(
      /Crossed/,
    );
    expect(() =>
      parseBook({
        ...raw,
        asks: [
          ['100.2', '1'],
          ['100.1', '1'],
        ],
      }),
    ).toThrow(/sorted/);
    expect(() => parseBook({ ...raw, asks: [] })).toThrow(/empty/);
    // 1001 USDT fills exactly the first ask level at 100.1: 10 bps above mid 100.
    expect(sweepBps(book.asks, 100, 1001, true)).toBeCloseTo(10);
    expect(sweepBps(book.asks, 100, 1e9, true)).toBeNull();
    const m = measureBook(book, [100, 2000]);
    expect(m.spreadBps).toBeCloseTo(20);
    expect(m.impact[1]!.buyBps!).toBeGreaterThan(10);
    const summary = summarizeDepth([
      { ts: 1, market: 'spot', symbol: 'X', ...m },
      { ts: 2, market: 'spot', symbol: 'X', ...m },
    ]);
    expect(summary[0]!.roundTripImpact[0]!.median).toBeCloseTo(20);
    expect(summary[0]!.samples).toBe(2);
  });
});

describe('signal delivery', () => {
  const token = '123456789:AAEexampleexampleexampleexample_xyz';
  it('keeps Telegram off unless explicitly enabled', () => {
    expect(sinksFromEnv({}).sinks).toHaveLength(0);
    expect(sinksFromEnv({}).channels.map((c) => [c.name, c.enabled])).toEqual([
      ['dashboard', true],
      ['telegram', false],
    ]);
    expect(() => sinksFromEnv({ TELEGRAM_ENABLED: 'true' })).toThrow(
      /needs TELEGRAM_BOT_TOKEN/,
    );
    expect(() => new TelegramSink('bad', '1')).toThrow(/invalid shape/);
    const enabled = sinksFromEnv({
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_CHAT_ID: '-1001234',
    });
    expect(enabled.sinks.map((s) => s.name)).toEqual(['telegram']);
    expect(JSON.stringify(enabled.channels)).not.toContain(token);
  });
  it('posts messages and never leaks the token in errors', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const ok = new TelegramSink(token, '-1001234', (async (
      url: string,
      init?: RequestInit,
    ) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch);
    await ok.send({ kind: 'signal', id: 'a', at: 0, text: 'LONG SOL' });
    expect(calls[0]!.url).toBe(
      `https://api.telegram.org/bot${token}/sendMessage`,
    );
    expect(calls[0]!.body).toMatchObject({
      chat_id: '-1001234',
      text: 'LONG SOL',
    });
    const failing = new TelegramSink(
      token,
      '-1001234',
      (async () =>
        new Response(
          JSON.stringify({ ok: false, description: 'chat not found' }),
          {
            status: 400,
          },
        )) as unknown as typeof fetch,
    );
    const offline = new TelegramSink(token, '-1001234', (async () => {
      throw new TypeError(`fetch failed for ${token}`);
    }) as unknown as typeof fetch);
    const results = await deliver(
      [ok, failing, offline],
      { kind: 'signal', id: 'b', at: 1000, text: 'x' },
      () => 1500,
    );
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results[0]!.latencyMs).toBe(500);
    expect(results[1]!.error).toContain('chat not found');
    for (const r of results) expect(r.error ?? '').not.toContain(token);
  });
});

async function liveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'signals-api-')),
    dir = join(root, 'residual', 'live', 'session-a');
  await mkdir(dir, { recursive: true });
  const published = Date.now() - 10 * 60000;
  await writeFile(
    join(dir, 'health.json'),
    JSON.stringify({
      at: Date.now(),
      version: 'residual-spot-v003',
      channels: [],
    }),
  );
  await writeFile(
    join(dir, 'signals.jsonl'),
    JSON.stringify({
      id: 'sig-1',
      symbol: 'SOLUSDT',
      side: 'LONG',
      referencePrice: 100,
      decisionTs: published - 1000,
      publishedAt: published,
      entryAtTs: published,
      holdMs: HOUR,
    }) + '\n{"id":"partial"',
  );
  await writeFile(
    join(dir, 'trades.jsonl'),
    JSON.stringify({
      signalId: 'old',
      btcImpulseId: 'e',
      netReturnBps: 12,
      executable: true,
      symbol: 'SOLUSDT',
      exitTs: 1,
    }) + '\n',
  );
  await writeFile(
    join(dir, 'deliveries.jsonl'),
    [
      { sink: 'telegram', ok: true, latencyMs: 900 },
      { sink: 'telegram', ok: false, latencyMs: 1200 },
    ]
      .map((d) => JSON.stringify(d))
      .join('\n') + '\n',
  );
  await mkdir(join(root, 'residual', 'walk-forward', 'plan-a-100', 'x'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'residual', 'walk-forward', 'plan-a-100', 'report.json'),
    JSON.stringify({
      planId: 'plan-a',
      outOfSample: {
        executable: { closedTrades: 3, winRate: 0.33, netExpectancyBps: -4 },
      },
      gate: {
        passed: false,
        reasons: ['insufficient_closed_trades'],
        metrics: {},
      },
      folds: [],
      variantsInSample: [],
    }),
  );
  return { root, dir, published };
}

describe('signal evidence API', () => {
  it('serves live sessions and research summaries', async () => {
    const f = await liveFixture(),
      server = createEvidenceServer({ dataDir: f.root, protocolDir: f.root });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const signals = await (await fetch(base + '/signals')).json();
      expect(signals.executionEnabled).toBe(false);
      const [session] = signals.sessions;
      expect(session.id).toBe('session-a');
      expect(session.signals.map((s: { id: string }) => s.id)).toEqual([
        'sig-1',
      ]);
      expect(session.paper.closedTrades).toBe(1);
      expect(session.deliveries.telegram).toEqual({
        ok: 1,
        failed: 1,
        medianLatencyMs: 900,
      });
      const research = await (await fetch(base + '/research')).json();
      expect(research.walkForward[0]).toMatchObject({
        planId: 'plan-a',
        gate: { passed: false },
        outOfSample: { closedTrades: 3 },
      });
      expect(research.study).toBeNull();
    } finally {
      await new Promise((r) => server.close(r));
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('records one validated user fill per signal and nothing else', async () => {
    const f = await liveFixture(),
      server = createEvidenceServer({ dataDir: f.root, protocolDir: f.root });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      post = (path: string, body: unknown, type = 'application/json') =>
        fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': type },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
    try {
      const fill = {
        signalId: 'sig-1',
        price: 100.5,
        filledAt: f.published + 90000,
      };
      const created = await post('/signals/session-a/fills', fill);
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        reactionMs: 90000,
        slippageBps: expect.closeTo(50, 6),
      });
      expect((await post('/signals/session-a/fills', fill)).status).toBe(409);
      expect(
        (await post('/signals/session-a/fills', { ...fill, signalId: 'nope' }))
          .status,
      ).toBe(404);
      expect(
        (
          await post('/signals/session-a/fills', {
            ...fill,
            signalId: 'sig-1',
            filledAt: f.published - 1,
          })
        ).status,
      ).toBe(400);
      expect(
        (await post('/signals/session-a/fills', { ...fill, extra: 1 })).status,
      ).toBe(400);
      expect(
        (await post('/signals/session-a/fills', fill, 'text/plain')).status,
      ).toBe(415);
      expect(
        (await post('/signals/session-a/fills', 'x'.repeat(5000))).status,
      ).toBe(413);
      expect((await post('/signals/..%2F..%2Fetc/fills', fill)).status).toBe(
        400,
      );
      expect((await post('/signals/missing/fills', fill)).status).toBe(404);
      expect((await post('/health', {})).status).toBe(405);
      expect(
        (await fetch(base + '/signals', { method: 'DELETE' })).status,
      ).toBe(405);
      const rows = await readLedger(join(f.dir, 'fills.jsonl'));
      expect(rows).toHaveLength(1);
      const summary = (await (await fetch(base + '/signals')).json())
        .sessions[0].fills;
      expect(summary).toMatchObject({ count: 1, medianReactionMs: 90000 });
    } finally {
      await new Promise((r) => server.close(r));
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('rejects interior ledger corruption', async () => {
    const f = await liveFixture();
    try {
      await writeFile(
        join(f.dir, 'signals.jsonl'),
        '{"id":1}\n{bad\n{"id":2}\n',
      );
      await expect(readLedger(join(f.dir, 'signals.jsonl'))).rejects.toThrow(
        /integrity/,
      );
      await expect(
        recordFill(f.root, 'session-a', {
          signalId: 'x',
          price: 1,
          filledAt: 1,
        }),
      ).rejects.toThrow();
      expect(await readFile(join(f.dir, 'health.json'), 'utf8')).toContain(
        'residual-spot-v003',
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('exchange rate limits', () => {
  it('waits for Retry-After on 429, backs off on 5xx, and fails fast on other 4xx', async () => {
    const { getJson } = await import('../packages/market-data/src/klines.js');
    const waits: number[] = [],
      sleep = async (ms: number) => void waits.push(ms);
    const sequence = [
      new Response('', { status: 429, headers: { 'Retry-After': '7' } }),
      new Response('', { status: 503 }),
      new Response(JSON.stringify({ ok: 1 })),
    ];
    const fetcher = (async () => sequence.shift()!) as unknown as typeof fetch;
    expect(await getJson(fetcher, 'u', sleep)).toEqual({ ok: 1 });
    expect(waits).toEqual([7000, 2000]);
    let calls = 0;
    const denied = (async () => {
      calls++;
      return new Response('', { status: 400 });
    }) as unknown as typeof fetch;
    await expect(getJson(denied, 'u', sleep)).rejects.toThrow(
      /Permanent HTTP 400/,
    );
    expect(calls).toBe(1);
    const limited = (async () =>
      new Response('', { status: 429 })) as unknown as typeof fetch;
    waits.length = 0;
    await expect(getJson(limited, 'u', sleep, 3)).rejects.toThrow(
      /Transient HTTP 429/,
    );
    expect(waits).toEqual([10000, 10000]);
  });
});
