// Usage: pnpm log:verify <path-or-url-to-signal-log.jsonl>
// Re-computes every hash in the chain and reports the first broken entry, if any.
import { readFile } from 'node:fs/promises';
import { fingerprint, parseLog, verify } from '../packages/signal-log/src/index.js';

const src = process.argv[2];
if (!src) {
  console.error('Usage: pnpm log:verify <path-or-url>');
  process.exit(2);
}
const text = /^https?:\/\//.test(src)
  ? await (await fetch(src)).text()
  : await readFile(src, 'utf8');
const log = parseLog(text);
const result = await verify(log);
if (result.ok) {
  console.log(`OK · ${result.count} entries · head #${fingerprint(result.head)}`);
  for (const e of log)
    console.log(
      `${String(e.seq).padStart(4)}  #${fingerprint(e.hash)}  ${new Date(e.publishedAt).toISOString()}  ${e.kind === 'entry' ? 'BUY ' : 'SELL'} ${e.symbol}${e.backfill ? '  (backfill)' : ''}`,
    );
} else {
  console.error(`BROKEN at seq ${result.brokenAt}: ${result.problem}`);
  process.exit(1);
}
