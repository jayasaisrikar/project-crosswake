#!/usr/bin/env node
// Crosswake signal log verifier. No dependencies: Node 20+ only.
// Usage: node verify.mjs trend-daily-v005.jsonl
// Re-computes every SHA-256 fingerprint and checks each entry links to the one before it.
import { readFileSync } from 'node:fs';

const ORDER = ['seq', 'version', 'id', 'kind', 'symbol', 'decidedAt', 'fillAt', 'price',
  'netBps', 'reason', 'publishedAt', 'backfill', 'prevHash'];
const canonical = (e) => {
  const o = {};
  for (const k of ORDER) if (e[k] !== undefined) o[k] = e[k];
  return JSON.stringify(o);
};
const sha256 = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

const file = process.argv[2];
if (!file) { console.error('Usage: node verify.mjs <file.jsonl>'); process.exit(2); }
const log = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
let prev = '0'.repeat(64);
for (const [i, e] of log.entries()) {
  const bad = (why) => { console.error(`BROKEN at seq ${e.seq ?? i + 1}: ${why}`); process.exit(1); };
  if (e.seq !== i + 1) bad(`expected seq ${i + 1}`);
  if (e.prevHash !== prev) bad('prevHash does not match the previous entry');
  if ((await sha256(canonical(e))) !== e.hash) bad('entry contents do not match its hash');
  prev = e.hash;
  const side = e.kind === 'entry' ? 'BUY ' : 'SELL';
  console.log(`${String(e.seq).padStart(4)}  #${e.hash.slice(0, 12)}  ${new Date(e.publishedAt).toISOString()}  ${side} ${e.symbol}${e.backfill ? '  (backfill)' : ''}`);
}
console.log(`OK · ${log.length} entries · head #${prev.slice(0, 12)}`);
