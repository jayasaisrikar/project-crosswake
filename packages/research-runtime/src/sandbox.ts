/**
 * Exploratory backtests of the daily trend rules with user-chosen parameters.
 *
 * Every run is labelled EXPLORATORY and stored apart from frozen experiments:
 * trying parameters until a curve looks good is curve fitting, so nothing here
 * can count as evidence. A finding must be frozen as a new plan and tested on
 * unseen data before it means anything.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  regimeByDay,
  runTrend,
  trendStats,
  type DailyBar,
  type TrendTrade,
} from '../../backtest/src/trend.js';
import { epochMs } from '../../domain/src/index.js';

const DAY = 86_400_000;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const sandboxInput = z
  .object({
    breakoutDays: z.number().int().min(5).max(120),
    breakdownDays: z.number().int().min(3).max(60),
    regimeSmaDays: z.number().int().min(20).max(300),
    costBpsRoundTrip: z.number().min(0).max(200),
    from: isoDay,
    to: isoDay,
    symbols: z.array(z.string().regex(/^[A-Z0-9]{2,20}USDT$/)).max(60).optional(),
  })
  .strict()
  .refine((x) => x.from < x.to, 'from must be before to');
export type SandboxInput = z.infer<typeof sandboxInput>;

/** The frozen v005 values, shown next to every sandbox result. */
export const V005_RULES = {
  breakoutDays: 20,
  breakdownDays: 10,
  regimeSmaDays: 100,
  costBpsRoundTrip: 30,
};
const REGIME = 'BTCUSDT';

async function loadDaily(dataDir: string, symbol: string): Promise<DailyBar[]> {
  const dir = join(dataDir, 'daily', symbol),
    bars: DailyBar[] = [];
  for (const f of (await readdir(dir)).sort())
    for (const line of (await readFile(join(dir, f), 'utf8')).split(/\r?\n/)) {
      if (!/^\d/.test(line)) continue;
      const c = line.split(',');
      const b = {
        ts: epochMs(Number(c[0])),
        open: +c[1]!,
        high: +c[2]!,
        low: +c[3]!,
        close: +c[4]!,
      };
      if (b.open > 0 && b.close > 0 && (!bars.length || b.ts > bars.at(-1)!.ts))
        bars.push(b);
    }
  return bars;
}

export async function sandboxSymbols(dataDir: string) {
  return (await readdir(join(dataDir, 'daily')).catch(() => [] as string[]))
    .filter((s) => /^[A-Z0-9]{2,20}USDT$/.test(s))
    .sort();
}

export async function runSandbox(dataDir: string, raw: unknown) {
  const input = sandboxInput.parse(raw);
  const available = await sandboxSymbols(dataDir);
  if (!available.includes(REGIME)) throw new Error('BTCUSDT daily data missing');
  const symbols = (input.symbols?.length ? input.symbols : available).filter((s) =>
    available.includes(s),
  );
  const from = Date.parse(input.from + 'T00:00:00Z'),
    to = Date.parse(input.to + 'T00:00:00Z');
  const regime = regimeByDay(await loadDaily(dataDir, REGIME), input.regimeSmaDays);
  const trades: TrendTrade[] = [];
  for (const symbol of symbols)
    trades.push(
      ...runTrend(symbol, await loadDaily(dataDir, symbol), regime, input).filter(
        (t) => t.entryTs >= from && t.exitTs < to,
      ),
    );
  trades.sort((a, b) => a.exitTs - b.exitTs);
  // Running sum of per-trade net returns by exit day (equal size, no compounding).
  const equity: { ts: number; cumBps: number }[] = [];
  let cum = 0;
  for (const t of trades) {
    cum += t.netBps;
    if (equity.at(-1)?.ts === t.exitTs) equity.at(-1)!.cumBps = cum;
    else equity.push({ ts: t.exitTs, cumBps: cum });
  }
  const groups = new Map<string, { trades: number; netBps: number }>();
  for (const t of trades) {
    const g = groups.get(t.symbol) ?? { trades: 0, netBps: 0 };
    g.trades++;
    g.netBps += t.netBps;
    groups.set(t.symbol, g);
  }
  const bySymbol = [...groups].map(([symbol, g]) => ({ symbol, ...g }));
  const id = `sandbox-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const run = {
    id,
    label: 'EXPLORATORY' as const,
    note: 'Parameters chosen by hand on seen data. Not evidence; freeze a plan and test it on unseen data first.',
    ranAt: Date.now(),
    input: { ...input, symbols },
    differsFromV005: Object.entries(V005_RULES)
      .filter(([k, v]) => input[k as keyof typeof V005_RULES] !== v)
      .map(([k]) => k),
    stats: trendStats(trades, 2000),
    equity,
    bySymbol: bySymbol.sort((a, b) => b.netBps - a.netBps),
    trades: trades.slice(-200).reverse(),
  };
  const dir = join(dataDir, 'sandbox');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(run), { flag: 'wx' });
  return run;
}

export async function listSandboxRuns(dataDir: string, limit = 30) {
  const dir = join(dataDir, 'sandbox');
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^sandbox-[\w-]+\.json$/.test(f))
    .sort()
    .reverse()
    .slice(0, limit);
  const runs = [];
  for (const f of files) {
    const r = JSON.parse(await readFile(join(dir, f), 'utf8'));
    runs.push({
      id: r.id,
      ranAt: r.ranAt,
      input: { ...r.input, symbols: r.input.symbols.length },
      differsFromV005: r.differsFromV005,
      stats: r.stats,
    });
  }
  return { runs: runs.sort((a, b) => b.ranAt - a.ranAt), v005: V005_RULES };
}
