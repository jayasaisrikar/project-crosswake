import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recordFreshness,
  type FreshnessSnapshot,
} from '../packages/research-runtime/src/freshness.js';

const HOUR = 3_600_000;
const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const source =
  process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) ??
  join(process.env.CROSSWAKE_DATA ?? 'data', 'public', 'record.json');

const snapshot: FreshnessSnapshot | null = await (
  source.startsWith('http')
    ? fetch(source, { signal: AbortSignal.timeout(15_000) }).then((response) =>
        response.ok ? (response.json() as Promise<FreshnessSnapshot>) : null,
      )
    : readFile(source, 'utf8').then(
        (text) => JSON.parse(text) as FreshnessSnapshot,
        () => null,
      )
).catch(() => null);

const result = recordFreshness(snapshot, Date.now(), {
  maxRecordAgeMs: num(process.env.RECORD_MAX_AGE_HOURS, 2) * HOUR,
  maxCollectorIdleMs: num(process.env.FEED_MAX_IDLE_MINUTES, 30) * 60_000,
  maxEngineIdleMs: num(process.env.ENGINE_MAX_IDLE_HOURS, 26) * HOUR,
});

console.log(
  JSON.stringify(
    {
      source,
      ok: result.ok,
      problems: result.problems,
      ...result.ages,
    },
    null,
    2,
  ),
);
if (!result.ok) process.exit(1);
