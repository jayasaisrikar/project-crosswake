import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getJson } from '../../../packages/market-data/src/klines.js';
import { deliver, sinksFromEnv } from '../../../packages/notify/src/index.js';
import { readLog } from '../../../packages/signal-log/src/node.js';
import {
  DAY,
  dailyPost,
  isFresh,
  utcDay,
  weekStart,
  weeklyPost,
  type LogHead,
  type TrendState,
} from './format.js';

const root = process.env.CROSSWAKE_DATA ?? 'data',
  liveDir = join(root, 'trend', 'live'),
  out = join(root, 'status'),
  once = process.argv.includes('--once'),
  dryRun = process.argv.includes('--dry-run'),
  // Give up on a day whose engines never caught up, rather than posting stale numbers.
  STALE_AFTER = 4 * 3_600_000;

async function load() {
  const states: TrendState[] = [],
    heads: LogHead[] = [];
  for (const id of (await readdir(liveDir).catch(() => [] as string[])).sort()) {
    try {
      const s = JSON.parse(await readFile(join(liveDir, id, 'state.json'), 'utf8'));
      if (s.kind === 'htf-rsi' || !String(s.version).startsWith('trend-daily')) continue;
      states.push(s);
      const head = (await readLog(join(liveDir, id, 'signal-log.jsonl'))).at(-1);
      if (head) heads.push({ version: s.version, seq: head.seq, hash: head.hash });
    } catch {}
  }
  return { states, heads };
}

/** BTC close-to-close change over [week, week + 7d), from Binance daily bars. */
async function btcWeek(week: number): Promise<number | null> {
  try {
    const rows = await getJson<unknown[][]>(
      fetch,
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${week - DAY}&limit=8`,
    );
    const close = (ts: number) => Number(rows.find((r) => Number(r[0]) === ts)?.[4]);
    const a = close(week - DAY),
      b = close(week + 6 * DAY);
    return a && b ? (b / a - 1) * 10_000 : null;
  } catch {
    return null;
  }
}

async function main() {
  const { sinks } = sinksFromEnv(process.env);
  await mkdir(out, { recursive: true });
  const sentPath = join(out, 'delivered.json'),
    sent = new Set<string>(existsSync(sentPath) ? JSON.parse(await readFile(sentPath, 'utf8')) : []);
  const send = async (id: string, text: string) => {
    if (dryRun) return console.log(`--- ${id}\n${text}\n`);
    const d = await deliver(sinks, { kind: 'analysis', id, at: Date.now(), text, html: true });
    await writeFile(
      join(out, 'posts.jsonl'),
      JSON.stringify({ id, at: Date.now(), text, deliveries: d }) + '\n',
      { flag: 'a' },
    );
    if (d.every((x) => x.ok)) sent.add(id);
    await writeFile(sentPath, JSON.stringify([...sent].slice(-500)));
    console.log({ id, delivered: d.map((x) => `${x.sink}:${x.ok}`) });
  };
  for (;;) {
    const now = Date.now(),
      today = utcDay(now),
      dailyId = `status-${new Date(today).toISOString().slice(0, 10)}`;
    try {
      const { states, heads } = await load();
      if (!sent.has(dailyId) || dryRun) {
        if (isFresh(states, today)) await send(dailyId, dailyPost(states, heads, today));
        else if (now - today > STALE_AFTER) {
          console.warn({ id: dailyId, skipped: 'trend engines did not report today’s close' });
          sent.add(dailyId);
        }
      }
      // The scorecard covers the week that just ended and goes out on Monday after the daily post.
      const week = weekStart(now) - 7 * DAY,
        weeklyId = `scorecard-${new Date(week).toISOString().slice(0, 10)}`;
      if (
        (sent.has(dailyId) || dryRun) &&
        (!sent.has(weeklyId) || dryRun) &&
        (dryRun || now - weekStart(now) < 2 * DAY) &&
        isFresh(states, today)
      )
        await send(weeklyId, weeklyPost(states, heads, week, await btcWeek(week)));
    } catch (error) {
      console.error(String(error));
    }
    if (once || dryRun) return;
    // Check every 10 minutes until today's posts are out, then sleep until 00:15 UTC tomorrow.
    const wait = sent.has(dailyId) ? today + DAY + 15 * 60_000 - Date.now() : 10 * 60_000;
    await new Promise((r) => setTimeout(r, Math.max(60_000, wait)));
  }
}
await main();
