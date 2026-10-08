import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

type Dirent = { name: string; isDirectory(): boolean };

async function list(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function listDirs(dir: string, prefix = '') {
  return (await list(dir))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name);
}
/** A missing manifest marks an unverified partition; a malformed one is integrity failure. */
async function manifest(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}
const num = (value: unknown) => (typeof value === 'number' ? value : null);

type SymbolSummary = {
  symbol: string;
  rows: number;
  files: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
  partitions: number;
  unverified: number;
};
function summarise(rows: SymbolSummary[]) {
  const span = rows.filter((r) => r.firstTs !== null && r.lastTs !== null);
  return {
    symbols: rows.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    rows: rows.reduce((n, r) => n + r.rows, 0),
    files: rows.reduce((n, r) => n + r.files, 0),
    bytes: rows.reduce((n, r) => n + r.bytes, 0),
    unverified: rows.reduce((n, r) => n + r.unverified, 0),
    firstTs: span.length ? Math.min(...span.map((r) => r.firstTs!)) : null,
    lastTs: span.length ? Math.max(...span.map((r) => r.lastTs!)) : null,
  };
}

/** One-second live research buckets, verified per symbol/day partition. */
async function liveSource(root: string) {
  const base = join(root, 'normalized', 'venue=binance');
  for (const market of await listDirs(base, 'market=')) {
    const bySymbol = new Map<string, SymbolSummary>();
    let days = 0;
    for (const date of await listDirs(join(base, market), 'date=')) {
      days += 1;
      for (const symbolDir of await listDirs(
        join(base, market, date),
        'symbol=',
      )) {
        const symbol = symbolDir.slice('symbol='.length),
          dir = join(base, market, date, symbolDir);
        const current = bySymbol.get(symbol) ?? {
          symbol,
          rows: 0,
          files: 0,
          bytes: 0,
          firstTs: null,
          lastTs: null,
          partitions: 0,
          unverified: 0,
        };
        current.partitions += 1;
        for (const file of await list(dir)) {
          if (!file.name.endsWith('.parquet')) continue;
          current.files += 1;
          current.bytes += (await stat(join(dir, file.name))).size;
          const meta = await manifest(join(dir, `${file.name}.manifest.json`));
          if (!meta) {
            current.unverified += 1;
            continue;
          }
          current.rows += num(meta.rows) ?? 0;
          const first = num(meta.firstTs),
            last = num(meta.lastTs);
          if (first !== null)
            current.firstTs =
              current.firstTs === null
                ? first
                : Math.min(current.firstTs, first);
          if (last !== null)
            current.lastTs =
              current.lastTs === null ? last : Math.max(current.lastTs, last);
        }
        bySymbol.set(symbol, current);
      }
    }
    const summary = summarise([...bySymbol.values()]);
    if (summary.files)
      return {
        id: 'live',
        market: market.slice('market='.length),
        label: 'Live one-second research data',
        detail:
          'Trades and best bid/offer captured live, one verified row per second. This is what the signal engines and the exploratory backtest read.',
        granularity: '1 second',
        quoteBacked: true,
        days,
        ...summary,
      };
  }
  return null;
}

/** One-minute klines imported from published exchange archives. */
async function barSource(root: string) {
  const base = join(root, 'bars', 'venue=binance');
  for (const market of await listDirs(base, 'market=')) {
    const rows: SymbolSummary[] = [];
    for (const symbolDir of await listDirs(
      join(base, market, 'interval=1m'),
      'symbol=',
    )) {
      const symbol = symbolDir.slice('symbol='.length),
        dir = join(base, market, 'interval=1m', symbolDir);
      const current: SymbolSummary = {
        symbol,
        rows: 0,
        files: 0,
        bytes: 0,
        firstTs: null,
        lastTs: null,
        partitions: 0,
        unverified: 0,
      };
      for (const file of await list(dir)) {
        if (!file.name.endsWith('.parquet')) continue;
        current.files += 1;
        current.partitions += 1;
        current.bytes += (await stat(join(dir, file.name))).size;
        const meta = await manifest(join(dir, `${file.name}.manifest.json`));
        if (!meta) {
          current.unverified += 1;
          continue;
        }
        current.rows += num(meta.rows) ?? 0;
        const first = num(meta.firstTs),
          last = num(meta.lastTs);
        if (first !== null)
          current.firstTs =
            current.firstTs === null ? first : Math.min(current.firstTs, first);
        if (last !== null)
          current.lastTs =
            current.lastTs === null ? last : Math.max(current.lastTs, last);
      }
      if (current.files) rows.push(current);
    }
    if (rows.length)
      return {
        id: 'bars',
        market: market.slice('market='.length),
        label: 'One-minute kline history',
        detail:
          'Klines imported from published exchange archives with checksum verification. This is what the BTC-relative residual backtests read.',
        granularity: '1 minute',
        quoteBacked: false,
        days: null,
        ...summarise(rows),
      };
  }
  return null;
}

/** Append-only collector journals: the write-ahead log behind every launch. */
async function journalSource(root: string) {
  const dir = join(root, 'raw');
  const files = (await list(dir)).filter((f) => f.name.endsWith('.jsonl'));
  if (!files.length) return null;
  let bytes = 0;
  let newest = { name: '', mtime: 0 };
  for (const file of files) {
    const info = await stat(join(dir, file.name));
    bytes += info.size;
    if (info.mtimeMs > newest.mtime)
      newest = { name: file.name, mtime: info.mtimeMs };
  }
  return {
    id: 'journals',
    label: 'Collector journals',
    detail:
      'Raw session log holding every trade and quote message. Needed for recovery and replay, and the only part of the data that grows quickly.',
    granularity: 'per message',
    quoteBacked: false,
    sessions: files.length,
    rows: null,
    files: files.length,
    bytes,
    firstTs: null,
    lastTs: null,
    symbols: [],
    unverified: 0,
    newest: { name: newest.name, at: newest.mtime || null },
  };
}

async function walkBytes(dir: string) {
  let bytes = 0,
    files = 0;
  for (const entry of await list(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkBytes(path);
      bytes += nested.bytes;
      files += nested.files;
    } else {
      bytes += (await stat(path)).size;
      files += 1;
    }
  }
  return { bytes, files };
}
/** Downloaded exchange archives, kept so imports can rerun without re-downloading. */
async function archiveSource(root: string) {
  const { bytes, files } = await walkBytes(join(root, 'archives'));
  if (!files) return null;
  return {
    id: 'archives',
    label: 'Downloaded archives',
    detail:
      'Published exchange files kept on disk so history imports can repeat without downloading again. Safe to delete; they are re-fetched on demand.',
    granularity: 'daily and monthly files',
    quoteBacked: false,
    rows: null,
    files,
    bytes,
    firstTs: null,
    lastTs: null,
    symbols: [],
    unverified: 0,
  };
}

export async function datasetInventory(root: string) {
  const candidates = await Promise.all([
    liveSource(root),
    barSource(root),
    journalSource(root),
    archiveSource(root),
  ]);
  const sources = candidates.filter((source) => source !== null);
  return {
    sources,
    totalBytes: sources.reduce((n, s) => n + s.bytes, 0),
    generatedAt: Date.now(),
  };
}

type Run = Record<string, unknown>;
function asRecord(value: unknown): Run {
  return value && typeof value === 'object' ? (value as Run) : {};
}
function trades(executable: Run) {
  const closed = num(executable.closedTrades);
  if (closed === null) return null;
  const bootstrap = asRecord(executable.eventClusterBootstrap),
    interval = bootstrap.netExpectancyBps95;
  return {
    closed,
    wins: num(executable.wins),
    losses: num(executable.losses),
    winRate: num(executable.winRate),
    expectancyBps: num(executable.netExpectancyBps),
    expectancy95: Array.isArray(interval) ? interval : null,
    profitFactor: num(executable.profitFactor),
    btcEvents: num(executable.btcEventCount),
    exitReasons: asRecord(executable.exitReasons),
  };
}
/** Exploratory catch-up run written by `pnpm backtest`. */
function exploratoryRun(id: string, report: Run, completedAt: number | null) {
  const config = asRecord(report.config),
    range =
      num(report.firstTs) !== null && num(report.lastTs) !== null
        ? { startTs: num(report.firstTs), endTs: num(report.lastTs) }
        : null;
  return {
    id,
    kind: 'exploratory',
    strategy: typeof config.version === 'string' ? config.version : id,
    completedAt,
    validationStatus: report.validationStatus ?? null,
    source: report.source ?? null,
    range,
    units: { label: 'snapshots', value: num(report.snapshots) },
    candidates: num(report.candidates),
    trades: trades(report),
    researchOnly: null,
    funnel: asRecord(asRecord(report.signalDiagnostics).funnel),
    limitations: Array.isArray(report.limitations) ? report.limitations : [],
    hashes: {
      config: report.configHash ?? null,
      dataset: report.datasetHash ?? null,
    },
  };
}
/** BTC-relative residual run written by `pnpm residual:backtest`. */
function residualRun(id: string, report: Run, completedAt: number | null) {
  const config = asRecord(report.config),
    range = asRecord(report.range);
  return {
    id,
    kind: 'residual',
    strategy: typeof config.version === 'string' ? config.version : id,
    completedAt,
    validationStatus: report.validationStatus ?? null,
    source: 'bars',
    range:
      num(range.startTs) !== null && num(range.endTs) !== null
        ? { startTs: num(range.startTs), endTs: num(range.endTs) }
        : null,
    units: { label: 'evaluations', value: num(report.signals) },
    candidates: num(report.signals),
    trades: trades(asRecord(report.executable)),
    researchOnly: trades(asRecord(report.researchOnly)),
    funnel: asRecord(report.funnel),
    limitations: Array.isArray(report.limitations) ? report.limitations : [],
    hashes: {
      config: report.configHash ?? null,
      dataset: report.datasetHash ?? null,
    },
  };
}
async function collectRuns(
  dir: string,
  build: (id: string, report: Run, completedAt: number | null) => Run,
) {
  const runs: Run[] = [];
  for (const id of await listDirs(dir)) {
    const path = join(dir, id, 'report.json');
    let report: Record<string, unknown> | null = null;
    try {
      report = await manifest(path);
    } catch {
      report = null;
    }
    if (!report) continue;
    let completedAt: number | null = null;
    try {
      completedAt = (await stat(path)).mtimeMs;
    } catch {
      completedAt = null;
    }
    runs.push(build(id, report, completedAt));
  }
  return runs;
}

export async function backtestRuns(root: string) {
  const runs = [
    ...(await collectRuns(join(root, 'backtests'), exploratoryRun)),
    ...(await collectRuns(join(root, 'residual', 'backtests'), residualRun)),
  ].sort((a, b) => Number(b.completedAt ?? 0) - Number(a.completedAt ?? 0));
  return { runs, generatedAt: Date.now() };
}
