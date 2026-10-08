import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { identifier } from './experiments.js';
import { metrics } from '../../backtest/src/index.js';
import type { ResidualTrade } from '../../backtest/src/residual.js';

const liveRoot = (dataDir: string) => join(dataDir, 'residual', 'live');

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
/** Parses a JSONL ledger, tolerating only an incomplete trailing append. */
export async function readLedger<T = Record<string, unknown>>(path: string) {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as T[];
    throw error;
  }
  const lines = text.split('\n'),
    rows: T[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A line without its newline is an append still in progress; anything else is corruption.
      if (i !== lines.length - 1)
        throw new Error(`Ledger integrity failure: ${path}`);
    }
  });
  return rows;
}
async function directories(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && identifier.safeParse(e.name).success)
      .map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
const median = (values: number[]) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Live residual sessions with recent signals, paper outcomes, deliveries and reported user fills. */
export async function residualSignals(dataDir: string, limit = 50) {
  const sessions = [];
  for (const id of await directories(liveRoot(dataDir))) {
    const dir = join(liveRoot(dataDir), id),
      health = await readJson(join(dir, 'health.json'));
    if (!health) continue;
    const signals = await readLedger<Record<string, unknown>>(
        join(dir, 'signals.jsonl'),
      ),
      trades = await readLedger<ResidualTrade>(join(dir, 'trades.jsonl')),
      deliveries = await readLedger<{
        sink: string;
        ok: boolean;
        latencyMs: number;
      }>(join(dir, 'deliveries.jsonl')),
      fills = await readLedger<UserFill>(join(dir, 'fills.jsonl'));
    const bySink = new Map<
      string,
      { ok: number; failed: number; latency: number[] }
    >();
    for (const d of deliveries) {
      const row = bySink.get(d.sink) ?? { ok: 0, failed: 0, latency: [] };
      if (d.ok) {
        row.ok++;
        row.latency.push(d.latencyMs);
      } else row.failed++;
      bySink.set(d.sink, row);
    }
    sessions.push({
      id,
      health,
      signals: signals.slice(-limit).reverse(),
      trades: trades.slice(-limit).reverse(),
      paper: metrics(trades.filter((t) => t.executable)),
      deliveries: Object.fromEntries(
        [...bySink].map(([sink, r]) => [
          sink,
          { ok: r.ok, failed: r.failed, medianLatencyMs: median(r.latency) },
        ]),
      ),
      fills: {
        count: fills.length,
        medianReactionMs: median(fills.map((f) => f.reactionMs)),
        medianSlippageBps: median(fills.map((f) => f.slippageBps)),
        recent: fills.slice(-limit).reverse(),
      },
    });
  }
  sessions.sort((a, b) => Number(b.health.at ?? 0) - Number(a.health.at ?? 0));
  return {
    sessions: sessions.slice(0, 10),
    researchStatus: 'UNVALIDATED',
    executionEnabled: false,
  };
}

export const fillInput = z
  .object({
    signalId: z.string().min(1).max(200),
    price: z.number().positive().finite(),
    filledAt: z.number().int().positive(),
  })
  .strict();
export interface UserFill {
  signalId: string;
  symbol: string;
  side: string;
  price: number;
  filledAt: number;
  reportedAt: number;
  /** From signal publication to the user's reported fill. */
  reactionMs: number;
  /** Fill versus the signal reference price, adverse positive. */
  slippageBps: number;
}
/** Records a user's self-reported entry for a published signal. Validates against the session ledger. */
export async function recordFill(
  dataDir: string,
  sessionId: string,
  input: unknown,
  now = Date.now(),
): Promise<UserFill> {
  const id = identifier.parse(sessionId),
    fill = fillInput.parse(input),
    dir = join(liveRoot(dataDir), id);
  if (!(await stat(dir)).isDirectory()) throw new Error('not a session');
  const signal = (
    await readLedger<Record<string, unknown>>(join(dir, 'signals.jsonl'))
  ).find((s) => s.id === fill.signalId);
  if (!signal)
    throw Object.assign(new Error('unknown signal'), { code: 'ENOENT' });
  const published = Number(signal.publishedAt ?? signal.decisionTs),
    reference = Number(signal.referencePrice),
    direction = signal.side === 'SHORT' ? -1 : 1;
  if (
    fill.filledAt < published ||
    fill.filledAt > published + 86400000 ||
    fill.filledAt > now + 60000
  )
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['filledAt'],
        message: 'Fill time must follow publication within a day',
        input: fill.filledAt,
      },
    ]);
  const prior = await readLedger<UserFill>(join(dir, 'fills.jsonl'));
  if (prior.some((f) => f.signalId === fill.signalId))
    throw Object.assign(new Error('fill already recorded'), { code: 'EEXIST' });
  const row: UserFill = {
    signalId: fill.signalId,
    symbol: String(signal.symbol),
    side: String(signal.side),
    price: fill.price,
    filledAt: fill.filledAt,
    reportedAt: now,
    reactionMs: fill.filledAt - published,
    slippageBps: direction * (fill.price / reference - 1) * 1e4,
  };
  await appendFile(join(dir, 'fills.jsonl'), JSON.stringify(row) + '\n');
  return row;
}

async function latestReport(dir: string, prefix?: string) {
  const names = (await directories(dir))
    .filter((n) => !prefix || n.startsWith(prefix))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  for (const name of names) {
    const report = await readJson(join(dir, name, 'report.json'));
    if (report) return { id: name, report };
  }
  return null;
}
type Dict = Record<string, any>;
const compactMetrics = (m: Dict | undefined) =>
  m && {
    closedTrades: m.closedTrades,
    winRate: m.winRate,
    breakevenWinRate: m.breakevenWinRate,
    netExpectancyBps: m.netExpectancyBps,
    expectancy95: m.eventClusterBootstrap?.netExpectancyBps95 ?? null,
    netPayoffRatio: m.netPayoffRatio,
    profitFactor: m.profitFactor,
  };

/** Latest walk-forward per plan, latest edge study and measured execution costs, reduced to summaries. */
export async function residualResearch(dataDir: string) {
  const base = join(dataDir, 'residual'),
    plans = new Set(
      (await directories(join(base, 'walk-forward'))).map((n) =>
        n.replace(/-\d+$/, ''),
      ),
    ),
    walkForward = [];
  for (const plan of [...plans].sort()) {
    const latest = await latestReport(join(base, 'walk-forward'), plan + '-');
    if (!latest) continue;
    const r = latest.report as Dict;
    walkForward.push({
      id: latest.id,
      planId: r.planId,
      outOfSample: compactMetrics(r.outOfSample?.executable),
      gate: r.gate && { passed: r.gate.passed, reasons: r.gate.reasons },
      folds: (r.folds ?? []).map((f: Dict) => ({
        test: f.test,
        chosen: f.chosen,
        trades: f.testMetrics?.closedTrades,
        netExpectancyBps: f.testMetrics?.netExpectancyBps,
      })),
      variantsInSample: (r.variantsInSample ?? []).map((v: Dict) => ({
        id: v.id,
        closedTrades: v.closedTrades,
        winRate: v.winRate,
        netExpectancyBps: v.netExpectancyBps,
      })),
    });
  }
  const study = await latestReport(join(base, 'studies'));
  const costs = await readJson(join(dataDir, 'costs', 'summary.json'));
  return {
    walkForward,
    study: study && {
      id: study.id,
      range: (study.report as Dict).range,
      results: (study.report as Dict).results,
    },
    costs,
    researchStatus: 'UNVALIDATED',
    executionEnabled: false,
  };
}
