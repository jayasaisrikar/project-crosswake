import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import {
  restoreShadow,
  sessionRefSchema,
} from '../../../packages/backtest/src/recovery.js';
import { strategySchema } from '../../../packages/signals/src/index.js';
import WebSocket from 'ws';
import pino from 'pino';
import {
  appendFile,
  mkdir,
  writeFile,
  rename,
  readFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  parseTrade,
  parseQuote,
  symbolSchema,
} from '../../../packages/domain/src/index.js';
import { IngestionPipeline } from '../../../packages/market-data/src/pipeline.js';
import { ParquetWriter } from '../../../packages/storage/src/index.js';
const log = pino(),
  root = process.env.DATA_DIR ?? './data';
const symbols = [
  ...new Set(
    (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
      .split(',')
      .map((s) => symbolSchema.parse(s)),
  ),
];
if (!symbols.includes('BTCUSDT') || symbols.length > 100)
  throw new Error('Universe requires BTCUSDT and at most 100 symbols');
const timing = z
  .object({
    lateness: z.coerce.number().int().min(0).max(30000),
    quoteAge: z.coerce.number().int().min(0).max(60000),
    duration: z.coerce.number().int().nonnegative(),
  })
  .parse({
    lateness: process.env.LATENESS_MS ?? 7000,
    quoteAge: process.env.QUOTE_MAX_AGE_MS ?? 5000,
    duration: process.env.COLLECT_SECONDS ?? 0,
  });
await mkdir(join(root, 'raw'), { recursive: true });
const lockPath = join(root, 'collector.lock');
await mkdir(lockPath).catch(() => {
  throw new Error(
    `Collector locked: inspect ${lockPath}/owner.json and the owning process before removing a stale lock`,
  );
});
await writeFile(
  join(lockPath, 'owner.json'),
  JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
);
await writeFile(join(root, 'collector.pid'), String(process.pid) + '\n');

const sessionId = randomUUID(),
  segmentPath = (ts: number) =>
    join(root, 'raw', `${new Date(ts).toISOString().slice(0, 10)}-${sessionId}.jsonl`);
const journalPath = segmentPath(Date.now());
let segment = journalPath;
const paperMode = z
  .enum(['shadow', 'off'])
  .parse(process.env.PAPER_MODE ?? 'shadow');
const config = strategySchema.parse(
  JSON.parse(
    await readFile(
      process.env.STRATEGY_CONFIG ?? 'configs/catch-up-v001.json',
      'utf8',
    ),
  ),
);
await mkdir(join(root, 'paper'), { recursive: true });
const paperPath = join(root, 'paper', journalPath.split('/').at(-1)!);
const activePath = join(root, 'paper', 'active.json');
let previousSessions: import('../../../packages/backtest/src/recovery.js').SessionRef[] =
  [];
if (paperMode === 'shadow') {
  try {
    previousSessions = z
      .array(sessionRefSchema)
      .parse(JSON.parse(await readFile(activePath, 'utf8')).sessions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const restored =
  paperMode === 'shadow'
    ? await restoreShadow(
        config,
        (events) =>
          appendFile(
            paperPath,
            events.map((e) => JSON.stringify(e)).join('\n') + '\n',
          ),
        root,
        previousSessions,
      )
    : undefined;
const shadow = restored?.runtime;
if (shadow) {
  await appendFile(
    paperPath,
    JSON.stringify({
      kind: 'session',
      formatVersion: 2,
      marketJournal: journalPath,
      previousSessions,
      config,
      configHash: shadow.engine.configHash,
      mode: 'ADAPTIVE_EXPLORATORY_SHADOW',
      executionEnabled: false,
    }) + '\n',
  );
  const temp = activePath + '.' + randomUUID() + '.tmp';
  await writeFile(
    temp,
    JSON.stringify(
      {
        sessions: [
          ...previousSessions,
          { journal: journalPath, ledger: paperPath },
        ],
      },
      null,
      2,
    ),
  );
  await rename(temp, activePath);
}
const writer = await ParquetWriter.create(root);
const pipeline = new IngestionPipeline(
  (records) =>
    appendFile(
      segment,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    ),
  (rows) => writer.write(rows),
  undefined,
  undefined,
  async (rows) => {
    await shadow?.rows(rows);
  },
);
let connected = false,
  stopping = false,
  ws: WebSocket | undefined,
  retry = 0,
  rejected = 0,
  lastMessageAt = 0;
let reconnectTimer: NodeJS.Timeout | undefined,
  rotation: NodeJS.Timeout | undefined,
  durationTimer: NodeJS.Timeout | undefined;
const startedAt = Date.now();
const segmentTimer =
  paperMode === 'off'
    ? setInterval(() => {
        const next = segmentPath(Date.now());
        if (next !== segment) {
          log.info({ from: segment, to: next }, 'Journal segment rotated');
          segment = next;
        }
      }, 30_000)
    : undefined;
pipeline.push({
  kind: 'session',
  ts: startedAt,
  symbols,
  quoteMaxAge: timing.quoteAge,
  latenessMs: timing.lateness,
});
function push(record: Parameters<IngestionPipeline['push']>[0]) {
  try {
    pipeline.push(record);
  } catch (error) {
    log.error({ error: String(error) }, 'Ingestion failed');
    process.exitCode = 1;
    void stop();
  }
}
function connect() {
  if (stopping) return;
  const streams = symbols
    .flatMap((s) => [
      `${s.toLowerCase()}@trade`,
      `${s.toLowerCase()}@bookTicker`,
    ])
    .join('/');
  ws = new WebSocket(
    `${process.env.BINANCE_SPOT_WS_BASE ?? 'wss://stream.binance.com:9443'}/stream?streams=${streams}`,
    { handshakeTimeout: 15000 },
  );
  ws.on('open', () => {
    connected = true;
    retry = 0;
    lastMessageAt = Date.now();
    push({ kind: 'connection', ts: Date.now(), connected: true });
    log.info({ symbols, journalPath }, 'Spot stream connected');
    rotation = setTimeout(() => ws?.close(), 23 * 60 * 60 * 1000);
  });
  ws.on('message', (data) => {
    lastMessageAt = Date.now();
    try {
      const payload = JSON.parse(data.toString()).data;
      if (payload.e === 'serverShutdown') {
        ws?.close();
        return;
      }
      push(
        payload.e === 'trade'
          ? parseTrade(payload, lastMessageAt)
          : parseQuote(payload, lastMessageAt),
      );
    } catch (error) {
      rejected++;
      log.warn({ error: String(error) }, 'Rejected market payload');
    }
  });
  ws.on('error', (error) => log.warn({ error: error.message }, 'Stream error'));
  ws.on('close', () => {
    connected = false;
    if (rotation) clearTimeout(rotation);
    if (!stopping) {
      push({ kind: 'connection', ts: Date.now(), connected: false });
      log.warn('Disconnected; reconnecting');
      reconnectTimer = setTimeout(
        connect,
        Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)) + Math.random() * 500,
      );
    }
  });
}
let lastHealthJournal = 0;
async function health() {
  const state = {
    pid: process.pid,
    startedAt,
    ts: Date.now(),
    connected,
    symbols,
    lastMessageAt,
    rejected,
    journalPath,
    paperPath: shadow ? paperPath : null,
    shadow: shadow?.diagnostics ?? null,
    recoveredPaperSteps: restored?.recoveredSteps ?? 0,
    latenessMs: timing.lateness,
    ...pipeline.diagnostics,
    memoryBytes: process.memoryUsage().rss,
  };
  if (!stopping && state.ts - lastHealthJournal >= 30000) {
    lastHealthJournal = state.ts;
    push({
      kind: 'health',
      ts: state.ts,
      memoryBytes: state.memoryBytes,
      late: state.late,
      rejected: state.rejected,
      pending: state.pending,
    });
  }
  const path = join(root, 'collector-health.json');
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2));
  await rename(temp, path);
  if (state.failed) throw new Error('Storage pipeline failed');
}
let ticking = false;
const timer = setInterval(() => {
  if (ticking || stopping) return;
  ticking = true;
  void (async () => {
    const now = Date.now();
    push({
      kind: 'flush',
      ts: now,
      watermark: now - timing.lateness,
      connected,
    });
    if (connected && now - lastMessageAt > 30000) ws?.terminate();
    await pipeline.idle();
    await health();
  })()
    .catch((error) => {
      log.error({ error: String(error) }, 'Collector unhealthy');
      process.exitCode = 1;
      void stop();
    })
    .finally(() => {
      ticking = false;
    });
}, 1000);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (segmentTimer) clearInterval(segmentTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (rotation) clearTimeout(rotation);
  if (durationTimer) clearTimeout(durationTimer);
  ws?.terminate();
  connected = false;
  try {
    pipeline.push({ kind: 'connection', ts: Date.now(), connected: false });
    pipeline.push({
      kind: 'flush',
      ts: Date.now(),
      watermark: Date.now(),
      connected: false,
    });
    await pipeline.close();
    await shadow?.close();
  } catch (error) {
    process.exitCode = 1;
    log.error(
      { error: String(error) },
      'Shutdown has uncommitted data; retain journal',
    );
  } finally {
    writer.close();
    await health().catch(() => {});
    await rm(lockPath, { recursive: true, force: true });
    log.info('Collector stopped');
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
if (timing.duration > 0)
  durationTimer = setTimeout(() => void stop(), timing.duration * 1000);
connect();
