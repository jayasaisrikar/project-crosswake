import { execFile } from 'node:child_process';
import { readFile, readdir, stat, statfs, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { plan, type JournalFile } from './policy.js';

const run = promisify(execFile),
  root = process.env.DATA_DIR ?? 'data',
  raw = join(root, 'raw'),
  HOUR = 3_600_000,
  policy = {
    closedAfterMs: Number(process.env.RAW_CLOSED_AFTER_HOURS ?? 2) * HOUR,
    keepMs: Number(process.env.RAW_KEEP_DAYS ?? 7) * 24 * HOUR,
    minFreeBytes: Number(process.env.MIN_FREE_GB ?? 15) * 1e9,
  },
  watch = process.argv.includes('--watch'),
  dryRun = process.argv.includes('--dry-run');

async function protectedJournals() {
  const names = new Set<string>();
  try {
    const active = JSON.parse(await readFile(join(root, 'paper', 'active.json'), 'utf8'));
    for (const s of active.sessions ?? []) names.add(basename(s.journal));
  } catch {}
  return names;
}

async function once() {
  const files: JournalFile[] = [];
  for (const name of await readdir(raw).catch(() => [] as string[])) {
    const info = await stat(join(raw, name));
    if (info.isFile()) files.push({ name, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  const fs = await statfs(root),
    free = fs.bavail * fs.bsize,
    guarded = await protectedJournals(),
    { compress, remove } = plan(files, policy, free, guarded);
  let saved = 0;
  for (const f of compress) {
    const src = join(raw, f.name);
    if (dryRun) { console.log({ wouldCompress: f.name }); continue; }
    await run('nice', ['-n', '19', 'zstd', '-q', '-T0', '-6', '--rm', '-f', src]);
    await run('zstd', ['-q', '-t', src + '.zst']);
    saved += f.bytes - (await stat(src + '.zst')).size;
  }
  for (const f of remove) {
    if (dryRun) { console.log({ wouldDelete: f.name }); continue; }
    await unlink(join(raw, f.name));
    saved += f.bytes;
  }
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    compressed: compress.length,
    deleted: remove.length,
    protected: guarded.size,
    freedGB: +(saved / 1e9).toFixed(2),
    freeGB: +(((await statfs(root)).bavail * fs.bsize) / 1e9).toFixed(1),
  }));
}

for (;;) {
  await once();
  if (!watch) break;
  await new Promise((r) => setTimeout(r, HOUR));
}
