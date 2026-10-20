import { open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SNAPSHOT_VERSION = 1;

const EVENT_LIMIT = 12;
const WATCH_LIMIT = 3;
const round = (value: unknown, digits = 2): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
const iso = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;

export type SnapshotPosition = {
  symbol: string;
  side: string | null;
  since: string | null;
  markBps: number | null;
  targetBps: number | null;
  stopBps: number | null;
  exitBy: string | null;
};

export type SnapshotEngine = {
  id: string;
  version: string;
  kind: string;
  market: string | null;
  instrument: string | null;
  liveSince: string | null;
  regimeOn: boolean | null;
  positions: SnapshotPosition[];
  stats: {
    trades: number | null;
    winRate: number | null;
    netExpectancyBps: number | null;
    profitFactor: number | null;
    medianBps: number | null;
  } | null;
  watch: { symbol: string; toHighBps: number | null }[];
  lastEventAt: string | null;
  telegram: boolean;
  executionEnabled: boolean;
};

export type SnapshotEvent = {
  id: string;
  at: string;
  engine: string;
  kind: 'entry' | 'exit' | 'signal';
  symbol: string;
  market: string | null;
  side: string | null;
  price: number | null;
  netBps: number | null;
  reason: string | null;
};

export type PublicSnapshot = {
  version: number;
  generatedAt: string;
  executionEnabled: false;
  collector: {
    connected: boolean;
    lastMessageAt: string | null;
    symbols: string[];
  };
  engines: SnapshotEngine[];
  events: SnapshotEvent[];
  digestLastPostAt: string | null;
};

async function json(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function tailLedger(
  path: string,
  limit: number,
  maxBytes = 262_144,
): Promise<Record<string, any>[]> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const size = (await handle.stat()).size,
      start = Math.max(0, size - maxBytes),
      buffer = Buffer.alloc(size - start);
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const rows: Record<string, any>[] = [];
    lines.forEach((line, index) => {
      const text = line.trim();
      if (!text) return;
      try {
        rows.push(JSON.parse(text));
      } catch (error) {
        if (index !== lines.length - 1) throw error;
      }
    });
    return rows.slice(-limit);
  } finally {
    await handle.close();
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const telegramEnabled = (channels: unknown): boolean =>
  Array.isArray(channels) &&
  channels.some((c) => c?.name === 'telegram' && c?.enabled === true);

function trendEngine(id: string, state: Record<string, any>): SnapshotEngine {
  const kind = typeof state.kind === 'string' ? state.kind : 'trend-daily',
    events = Array.isArray(state.events) ? state.events : [],
    latest = events.reduce<number>(
      (max: number, e: Record<string, any>) =>
        Math.max(max, Number(e.fillAt ?? e.decidedAt ?? 0) || 0),
      0,
    );
  return {
    id,
    version: String(state.version ?? id),
    kind,
    market: 'spot',
    instrument: 'outright',
    liveSince: iso(state.forwardStart),
    regimeOn: typeof state.regime?.on === 'boolean' ? state.regime.on : null,
    positions: (Array.isArray(state.open) ? state.open : []).map(
      (o: Record<string, any>): SnapshotPosition => ({
        symbol: String(o.symbol),
        side: typeof o.side === 'string' ? o.side : null,
        since: iso(o.entryTs ?? o.ts),
        markBps: round(o.markBps ?? o.realizedR),
        targetBps: null,
        stopBps: null,
        exitBy: null,
      }),
    ),
    stats: state.stats
      ? {
          trades: round(state.stats.trades, 0),
          winRate: round(state.stats.winRate, 3),
          netExpectancyBps: round(state.stats.netExpectancyBps),
          profitFactor: round(state.stats.profitFactor, 3),
          medianBps: round(state.stats.medianBps),
        }
      : null,
    watch: (Array.isArray(state.watch) ? state.watch : [])
      .slice(0, WATCH_LIMIT)
      .map((w: Record<string, any>) => ({
        symbol: String(w.symbol),
        toHighBps: round(w.toHighBps),
      })),
    lastEventAt: iso(latest),
    telegram: telegramEnabled(state.channels),
    executionEnabled: state.executionEnabled === true,
  };
}

function residualEngine(
  id: string,
  health: Record<string, any>,
): SnapshotEngine {
  return {
    id,
    version: String(health.version ?? id),
    kind: 'residual',
    market: typeof health.market === 'string' ? health.market : null,
    instrument:
      typeof health.instrument === 'string' ? health.instrument : null,
    liveSince: null,
    regimeOn: null,
    positions: (Array.isArray(health.open) ? health.open : []).map(
      (o: Record<string, any>): SnapshotPosition => ({
        symbol: String(o.symbol),
        side: typeof o.side === 'string' ? o.side : null,
        since: iso(o.entryTs),
        markBps: null,
        targetBps: round(o.targetBps),
        stopBps: round(o.stopBps),
        exitBy: iso(o.exitByTs),
      }),
    ),
    stats: {
      trades: round(health.sessionTrades, 0),
      winRate: null,
      netExpectancyBps: round(health.sessionNetExpectancyBps),
      profitFactor: null,
      medianBps: null,
    },
    watch: [],
    lastEventAt: iso(health.lastStepTs),
    telegram: telegramEnabled(health.channels),
    executionEnabled: false,
  };
}

function momentumEngine(
  id: string,
  state: Record<string, any>,
): SnapshotEngine {
  const book = state.decision?.book ?? null;
  return {
    id,
    version: String(state.version ?? id),
    kind: 'momentum',
    market: 'usdm',
    instrument: 'outright',
    liveSince: iso(state.forwardStart),
    regimeOn: null,
    positions: book
      ? Object.entries(book as Record<string, any>)
          .filter(([, weight]) => Number(weight) !== 0)
          .slice(0, 12)
          .map(([symbol, weight]) => ({
            symbol,
            side: Number(weight) > 0 ? 'long' : 'short',
            since: iso(state.decision?.fillAt),
            markBps: round(Number(weight) * 1e4),
            targetBps: null,
            stopBps: null,
            exitBy: null,
          }))
      : [],
    stats: null,
    watch: [],
    lastEventAt: iso(state.updatedAt),
    telegram: false,
    executionEnabled: state.executionEnabled === true,
  };
}

async function trendEngines(root: string): Promise<{
  engines: SnapshotEngine[];
  events: SnapshotEvent[];
}> {
  const engines: SnapshotEngine[] = [],
    events: SnapshotEvent[] = [];
  for (const id of await directories(join(root, 'trend', 'live'))) {
    const state = await json(join(root, 'trend', 'live', id, 'state.json'));
    if (!state) continue;
    engines.push(trendEngine(id, state));
    for (const e of Array.isArray(state.events) ? state.events : []) {
      const at = iso(e.fillAt ?? e.decidedAt);
      if (!at) continue;
      events.push({
        id: String(e.id ?? `${id}-${at}`),
        at,
        engine: id,
        kind: e.kind === 'entry' ? 'entry' : 'exit',
        symbol: String(e.symbol ?? ''),
        market: String(state.kind === 'htf-rsi' ? 'usdm' : 'spot'),
        side: 'long',
        price: round(e.price, 6),
        netBps: round(e.netBps),
        reason: typeof e.reason === 'string' ? e.reason : null,
      });
    }
  }
  return { engines, events };
}

async function residualEngines(root: string): Promise<{
  engines: SnapshotEngine[];
  events: SnapshotEvent[];
}> {
  const engines: SnapshotEngine[] = [],
    events: SnapshotEvent[] = [];
  for (const id of await directories(join(root, 'residual', 'live'))) {
    const dir = join(root, 'residual', 'live', id),
      health = await json(join(dir, 'health.json'));
    if (!health) continue;
    engines.push(residualEngine(id, health));
    for (const s of await tailLedger(join(dir, 'signals.jsonl'), 8)) {
      if (s.accepted !== true) continue;
      const at = iso(s.publishedAt ?? s.decisionTs);
      if (!at) continue;
      events.push({
        id: String(s.id),
        at,
        engine: id,
        kind: 'signal',
        symbol: String(s.symbol),
        market: typeof health.market === 'string' ? health.market : null,
        side: typeof s.side === 'string' ? s.side.toLowerCase() : null,
        price: round(s.referencePrice, 6),
        netBps: round(s.expectedNetBps),
        reason: null,
      });
    }
    for (const t of await tailLedger(join(dir, 'trades.jsonl'), 8)) {
      const at = iso(t.exitTs);
      if (!at) continue;
      events.push({
        id: `${t.signalId}-exit`,
        at,
        engine: id,
        kind: 'exit',
        symbol: String(t.symbol),
        market: typeof health.market === 'string' ? health.market : null,
        side: typeof t.side === 'string' ? t.side.toLowerCase() : null,
        price: round(t.exitPrice, 6),
        netBps: round(t.netReturnBps),
        reason: typeof t.exitReason === 'string' ? t.exitReason : null,
      });
    }
  }
  return { engines, events };
}

async function momentumEngines(root: string): Promise<SnapshotEngine[]> {
  const engines: SnapshotEngine[] = [];
  for (const id of await directories(join(root, 'momentum', 'live'))) {
    const state = await json(join(root, 'momentum', 'live', id, 'state.json'));
    if (state) engines.push(momentumEngine(id, state));
  }
  return engines;
}

async function digestLastPostAt(root: string): Promise<string | null> {
  const rows = await tailLedger(join(root, 'digest', 'posts.jsonl'), 1);
  return rows.length ? iso(rows[0]!.at) : null;
}

/** One compact, read-only payload describing what the engines are doing right now. */
export async function publicSnapshot(dataDir: string): Promise<PublicSnapshot> {
  const [health, trend, residual, momentum, digest] = await Promise.all([
    json(join(dataDir, 'collector-health.json')),
    trendEngines(dataDir),
    residualEngines(dataDir),
    momentumEngines(dataDir),
    digestLastPostAt(dataDir),
  ]);
  const events = [...trend.events, ...residual.events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, EVENT_LIMIT);
  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    executionEnabled: false,
    collector: {
      connected: health?.connected === true,
      lastMessageAt: iso(health?.lastMessageAt),
      symbols: Array.isArray(health?.symbols) ? health.symbols.map(String) : [],
    },
    engines: [...trend.engines, ...residual.engines, ...momentum],
    events,
    digestLastPostAt: digest,
  };
}
