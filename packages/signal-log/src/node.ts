import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nextEntry, parseLog, type SignalLogEntry, type SignalLogFields } from './index.js';

const run = promisify(execFile);

export async function readLog(path: string): Promise<SignalLogEntry[]> {
  return existsSync(path) ? parseLog(await readFile(path, 'utf8')) : [];
}

/** Appends one entry to the in-memory log and the file. Never rewrites earlier lines. */
export async function append(
  path: string,
  log: SignalLogEntry[],
  f: Omit<SignalLogFields, 'seq' | 'prevHash'>,
): Promise<SignalLogEntry> {
  const e = await nextEntry(log, f);
  await writeFile(path, JSON.stringify(e) + '\n', { flag: 'a' });
  log.push(e);
  return e;
}

/**
 * Copies the log into a clone of the public log repository and pushes it, so GitHub's
 * history independently timestamps every entry. Enabled by SIGNAL_LOG_REPO_DIR.
 * Failures are reported, never thrown: publishing must not stop signals going out.
 */
export async function publish(
  logPath: string,
  name: string,
  head: SignalLogEntry | undefined,
  repoDir = process.env.SIGNAL_LOG_REPO_DIR,
): Promise<string | null> {
  if (!repoDir || !head) return null;
  try {
    const git = (...args: string[]) => run('git', ['-C', repoDir, ...args]);
    await git('pull', '--ff-only', '--quiet');
    await copyFile(logPath, join(repoDir, name));
    await git('add', name);
    const { stdout } = await git('status', '--porcelain', '--', name);
    if (!stdout.trim()) return null;
    await git(
      'commit',
      '--quiet',
      '-m',
      `${name}: seq ${head.seq} ${head.kind} ${head.symbol} #${head.hash.slice(0, 12)}`,
    );
    await git('push', '--quiet');
    return head.hash;
  } catch (e) {
    console.error('signal log publish failed', e);
    return null;
  }
}
