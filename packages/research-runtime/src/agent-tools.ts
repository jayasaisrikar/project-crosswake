import { createTool } from '@mastra/core/tools';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  coinFacts,
  factSheet,
  type EngineFact,
} from '../../context/src/digest.js';
import { latestContext } from '../../context/src/index.js';
import { backtestRuns } from './dataset-evidence.js';
import {
  identifier,
  listProtocols,
  readProtocol,
  type RuntimePaths,
} from './experiments.js';
import { liveEvidence } from './live-evidence.js';
import { readLedger, residualResearch } from './residual-evidence.js';

type Dict = Record<string, any>;

const count = z.number().int().min(1).max(25);
const CACHE_TTL_MS = 30_000;

async function readJson(path: string): Promise<Dict | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Dict;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function sessionDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && identifier.safeParse(e.name).success)
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const shortHash = (value: unknown) => String(value ?? '').slice(0, 12);

const SIGNAL_FIELDS = [
  'id',
  'kind',
  'symbol',
  'side',
  'decidedAt',
  'decisionTs',
  'fillAt',
  'publishedAt',
  'price',
  'referencePrice',
  'netBps',
  'targetBps',
  'reason',
  'seq',
];

/** Fields that hold epoch milliseconds. A model cannot be trusted to convert these. */
const TIME_FIELDS = [
  'decidedAt',
  'decisionTs',
  'fillAt',
  'publishedAt',
  'entryTs',
  'exitTs',
  'updatedAt',
  'forwardStart',
  'startedAt',
  'lastMessageAt',
  'lastStepTs',
  'retrievedAt',
  'availableAt',
  'expiresAt',
  'at',
  'ts',
];

const asIso = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;

const isoDates = (row: Dict) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      TIME_FIELDS.includes(key) ? asIso(value) : value,
    ]),
  );

const compactSignal = (row: Dict) =>
  isoDates(
    Object.fromEntries(
      SIGNAL_FIELDS.filter((key) => row[key] !== undefined).map((key) => [
        key,
        row[key],
      ]),
    ),
  );

async function trendRecord(dataDir: string) {
  const root = join(dataDir, 'trend', 'live'),
    engines = [];
  for (const id of await sessionDirectories(root)) {
    const state = await readJson(join(root, id, 'state.json'));
    if (!state) continue;
    engines.push({
      id,
      version: state.version,
      updatedAt: asIso(state.updatedAt),
      forwardStart: asIso(state.forwardStart),
      regime: state.regime,
      universe: Array.isArray(state.universe) ? state.universe.length : null,
      open: (state.open ?? []).slice(0, 10).map(isoDates),
      closedTrades: (state.closed ?? []).length,
      latestEvents: (state.events ?? []).slice(-3).map(isoDates),
      stats: state.stats,
      frozenBacktest: state.backtest,
      executionEnabled: state.executionEnabled,
    });
  }
  return engines;
}

async function momentumRecord(dataDir: string) {
  const root = join(dataDir, 'momentum', 'live'),
    sessions = [];
  for (const id of await sessionDirectories(root)) {
    const state = await readJson(join(root, id, 'state.json'));
    if (!state) continue;
    const book: Dict = state.decision?.book ?? {},
      ranked = Object.entries(book)
        .map(([symbol, weight]) => ({ symbol, weight: Number(weight) }))
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    sessions.push({
      id,
      version: state.version,
      updatedAt: asIso(state.updatedAt),
      forwardStart: asIso(state.forwardStart),
      universe: Array.isArray(state.universe)
        ? state.universe.length
        : state.universe,
      skipped: state.skipped,
      grossLeverage: state.grossLeverage,
      equity: state.equity,
      live: state.live,
      gate: state.gate,
      decision: state.decision && {
        decidedAt: asIso(state.decision.decidedAt),
        fillAt: asIso(state.decision.fillAt),
        positions: ranked.length,
        largestLongs: ranked.filter((p) => p.weight > 0).slice(0, 5),
        largestShorts: ranked.filter((p) => p.weight < 0).slice(0, 5),
      },
      executionEnabled: state.executionEnabled,
    });
  }
  return sessions;
}

async function residualRecord(dataDir: string) {
  const root = join(dataDir, 'residual', 'live'),
    sessions = [];
  for (const id of await sessionDirectories(root)) {
    const health = await readJson(join(root, id, 'health.json'));
    if (!health) continue;
    const state = await readJson(join(root, id, 'state.json'));
    sessions.push({
      id,
      version: health.version,
      configHash: shortHash(health.configHash),
      market: health.market,
      instrument: health.instrument,
      at: asIso(health.at),
      lastStepTs: asIso(health.lastStepTs),
      open: (health.open ?? []).map(isoDates),
      funnel: health.funnel,
      rejections: health.rejections,
      sessionTrades: health.sessionTrades,
      sessionNetExpectancyBps: health.sessionNetExpectancyBps,
      cooldownSymbols: (state?.cooldownUntil ?? []).length,
    });
  }
  return sessions;
}

/** Read-only tools over the live record. Nothing here writes, spawns a process, or opens a path the model supplies. */
export function createLiveDataTools(paths: RuntimePaths) {
  const { dataDir } = paths,
    cache = new Map<string, { at: number; value: unknown }>();
  const memo = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  return {
    liveStatus: createTool({
      id: 'liveStatus',
      description:
        'Collector health, the paper ledger counts and its most recent entries, and whether the altFINS market snapshot is currently fresh. Start here for questions about whether Crosswake is running and collecting.',
      inputSchema: z.object({ eventLimit: count.optional() }).strict(),
      execute: async ({ eventLimit }) => {
        const evidence = await liveEvidence(dataDir, eventLimit ?? 10),
          health = evidence.health as Dict | null;
        return {
          collector: health && {
            connected: health.connected,
            startedAt: asIso(health.startedAt),
            lastMessageAt: asIso(health.lastMessageAt),
            ts: asIso(health.ts),
            symbols: health.symbols,
            latenessMs: health.latenessMs,
            rejected: health.rejected,
            duplicates: health.duplicates,
            late: health.late,
            failed: health.failed,
            memoryBytes: health.memoryBytes,
            shadow: health.shadow,
          },
          paperLedger: {
            counts: evidence.counts,
            recent: evidence.events.map(isoDates),
          },
          snapshotAvailability: {
            status: evidence.context.status,
            retrievedAt: asIso(evidence.context.snapshot?.retrievedAt),
            availableAt: asIso(evidence.context.snapshot?.availableAt),
            expiresAt: asIso(evidence.context.snapshot?.expiresAt),
          },
          researchStatus: evidence.researchStatus,
          executionEnabled: evidence.executionEnabled,
        };
      },
    }),
    strategyRecord: createTool({
      id: 'strategyRecord',
      description:
        'The frozen state of every live strategy: daily trend engines (v005, v006, v007), the momentum perp book (v008) and the residual sessions (v003, v004). Carries the published statistics, the pre-registered backtest block and the open positions. Use this for any question about what a strategy is doing or how it has performed live.',
      inputSchema: z.object({}).strict(),
      execute: async () => ({
        trend: await trendRecord(dataDir),
        momentum: await momentumRecord(dataDir),
        residual: await residualRecord(dataDir),
        note: 'Every strategy is paper only. executionEnabled is false wherever orders would be placed.',
      }),
    }),
    recentSignals: createTool({
      id: 'recentSignals',
      description:
        'The most recent published signals, newest first, from the hash-chained signal logs the dashboard and the public log page read. Each entry carries symbol, side, the decision and fill timestamps, net basis points and the exit reason.',
      inputSchema: z
        .object({
          perStrategy: count.optional(),
          published: z.boolean().optional(),
        })
        .strict(),
      execute: async ({ perStrategy, published }) => {
        const take = perStrategy ?? 6,
          trending = [];
        for (const id of await sessionDirectories(
          join(dataDir, 'trend', 'live'),
        )) {
          const rows = await readLedger<Dict>(
            join(dataDir, 'trend', 'live', id, 'signal-log.jsonl'),
          );
          if (!rows.length) continue;
          trending.push({
            id,
            signals: rows.slice(-take).reverse().map(compactSignal),
          });
        }
        const residual = [];
        for (const id of await sessionDirectories(
          join(dataDir, 'residual', 'live'),
        )) {
          const rows = await readLedger<Dict>(
            join(dataDir, 'residual', 'live', id, 'signals.jsonl'),
          );
          residual.push({
            id,
            signals: rows.slice(-take).reverse().map(compactSignal),
          });
        }
        return {
          trend: trending,
          residual,
          publishedOnly: published ?? true,
          note: 'Only v005 and v006 write a public signal log; the other engines record signals internally.',
        };
      },
    }),
    marketContext: createTool({
      id: 'marketContext',
      description:
        'The current altFINS market read for the coins Crosswake tracks: price, 4-hour RSI, MACD direction and breadth, plus what our own engines hold. Every number a published market update may contain appears here. Reports staleness rather than serving an expired snapshot.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const context = await latestContext(dataDir);
        if (context.status !== 'available' || !context.snapshot)
          return { status: context.status, facts: null };
        const engines: EngineFact[] = [];
        for (const id of await sessionDirectories(
          join(dataDir, 'trend', 'live'),
        )) {
          const state = await readJson(
            join(dataDir, 'trend', 'live', id, 'state.json'),
          );
          if (!state) continue;
          engines.push({
            version: state.version,
            open: (state.open ?? []).map((o: Dict) => ({
              symbol: o.symbol,
              side: o.side,
            })),
            regimeOn: id.startsWith('htf') ? undefined : state.regime?.on,
            closedTrades: state.stats?.trades ?? 0,
          });
        }
        return {
          status: context.status,
          receipt: {
            provider: context.snapshot.provider,
            retrievedAt: asIso(context.snapshot.retrievedAt),
            availableAt: asIso(context.snapshot.availableAt),
            expiresAt: asIso(context.snapshot.expiresAt),
            payloadHash: shortHash(context.snapshot.payloadHash),
          },
          facts: {
            ...factSheet(
              coinFacts(context.snapshot.payload),
              engines,
              context.snapshot.retrievedAt,
            ),
            at: asIso(context.snapshot.retrievedAt),
          },
        };
      },
    }),
    preRegistered: createTool({
      id: 'preRegistered',
      description:
        'The strategy protocols frozen before testing: the exact rules, variants and fold timings that were locked in advance, with the hash that proves they were not adjusted afterwards. Use this for questions about what a strategy was required to do before it saw the data.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const ids = await listProtocols(paths).catch(() => [] as string[]),
          protocols: Dict[] = [],
          unverified: string[] = [];
        for (const id of ids) {
          try {
            const protocol = (await readProtocol(paths, id)) as Dict;
            protocols.push({
              id,
              createdAt: protocol.createdAt,
              planId: protocol.plan?.id,
              source: protocol.plan?.source,
              symbols: protocol.plan?.symbols,
              baseConfig: protocol.plan?.baseConfig,
              minValidationTrades: protocol.plan?.minValidationTrades,
              variants: (protocol.plan?.variants ?? []).map((v: Dict) => ({
                id: v.id,
                overrides: v.overrides,
              })),
              folds: (protocol.plan?.folds ?? []).map((f: Dict) => ({
                id: f.id,
                trainStart: f.trainStart,
                trainEnd: f.trainEnd,
                testEnd: f.testEnd,
              })),
              planHash: shortHash(protocol.planHash),
            });
          } catch {
            unverified.push(id);
          }
        }
        return {
          protocols,
          unverified,
          note: 'A protocol whose hash does not verify is listed as unverified instead of reported as a rule set.',
        };
      },
    }),
    researchEvidence: createTool({
      id: 'researchEvidence',
      description:
        'What has actually been tested: walk-forward out-of-sample results with their pass or fail gate, the latest edge study, measured round-trip execution costs, and the recorded backtest runs on disk. Use this for questions about proof, validation or out-of-sample performance.',
      inputSchema: z.object({ runLimit: count.optional() }).strict(),
      execute: async ({ runLimit }) => {
        const research = await memo('research', () =>
            residualResearch(dataDir),
          ),
          runs = await memo('backtests', () => backtestRuns(dataDir));
        return {
          residualResearch: research,
          recordedRuns: runs.runs.slice(0, runLimit ?? 10),
          runCount: runs.runs.length,
        };
      },
    }),
    publicRecord: createTool({
      id: 'publicRecord',
      description:
        'The exact text Crosswake has published publicly: four-hourly market updates and the weekly scorecard. Use this to answer what the project has told its audience, word for word.',
      inputSchema: z.object({ limit: count.optional() }).strict(),
      execute: async ({ limit }) => {
        const take = limit ?? 3,
          load = async (path: string) =>
            (await readLedger<Dict>(path))
              .slice(-take)
              .reverse()
              .map((row) => ({
                id: row.id,
                at: asIso(row.at),
                text: String(row.text ?? '').slice(0, 1200),
              }));
        return {
          marketUpdates: await load(join(dataDir, 'digest', 'posts.jsonl')),
          scorecards: await load(join(dataDir, 'status', 'posts.jsonl')),
        };
      },
    }),
  };
}

export const LIVE_AGENT_TOOLS = [
  'liveStatus',
  'strategyRecord',
  'recentSignals',
  'marketContext',
  'preRegistered',
  'researchEvidence',
  'publicRecord',
] as const;
