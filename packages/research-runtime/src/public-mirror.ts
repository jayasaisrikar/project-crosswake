import { execFile } from 'node:child_process';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readArticle, readArticleIndex } from './articles.js';
import { publicSnapshot } from './public-snapshot.js';

const run = promisify(execFile);

export const MIRROR_DIR = 'research';

export type MirrorResult = {
  notes: number;
  written: number;
  committed: boolean;
};

/** `generatedAt` moves on every read, so it must not decide whether the record changed. */
const withoutClock = (text: string) =>
  text.replace(/"generatedAt":\s*"[^"]*",?/, '');

async function differs(path: string, body: string) {
  try {
    return withoutClock(await readFile(path, 'utf8')) !== withoutClock(body);
  } catch {
    return true;
  }
}

/**
 * Mirrors the published record — the notes index, every note, and the live snapshot — into the
 * public signal-log repository, which the site reads over a CDN. The evidence API stays the
 * authoritative read; this is the copy that survives a tunnel having a bad day.
 * Failures are reported, never thrown: publishing must not stop the writer.
 */
export async function publishPublicRecord(
  dataDir: string,
  repoDir = process.env.SIGNAL_LOG_REPO_DIR,
): Promise<MirrorResult | null> {
  if (!repoDir) return null;
  try {
    const index = await readArticleIndex(dataDir);
    const dir = join(repoDir, MIRROR_DIR);
    await mkdir(dir, { recursive: true });
    let written = 0;

    const indexBody = `${JSON.stringify({ articles: index }, null, 1)}\n`;
    if (await differs(join(dir, 'index.json'), indexBody)) {
      await writeFile(join(dir, 'index.json'), indexBody);
      written += 1;
    }

    for (const entry of index) {
      const article = await readArticle(dataDir, entry.slug);
      if (!article) continue;
      const body = `${JSON.stringify(article, null, 1)}\n`;
      const path = join(dir, `${entry.slug}.json`);
      if (!(await differs(path, body))) continue;
      await writeFile(path, body);
      written += 1;
    }

    const keep = new Set([
      ...index.map((entry) => `${entry.slug}.json`),
      'index.json',
      'record.json',
    ]);
    for (const file of await readdir(dir)) {
      if (keep.has(file) || !file.endsWith('.json')) continue;
      await rm(join(dir, file));
      written += 1;
    }

    const snapshot = await publicSnapshot(dataDir);
    const recordBody = `${JSON.stringify(snapshot, null, 1)}\n`;
    if (await differs(join(dir, 'record.json'), recordBody)) {
      await writeFile(join(dir, 'record.json'), recordBody);
      written += 1;
    }

    if (!written) return { notes: index.length, written, committed: false };

    const git = (...args: string[]) => run('git', ['-C', repoDir, ...args]);
    // A clone that is behind should not block the publish; the push reports it if it matters.
    await git('pull', '--ff-only', '--quiet').catch(() => undefined);
    await git('add', MIRROR_DIR);
    const { stdout } = await git('status', '--porcelain', '--', MIRROR_DIR);
    if (!stdout.trim())
      return { notes: index.length, written, committed: false };
    await git(
      'commit',
      '--quiet',
      '-m',
      `research: ${index.length} notes, record ${snapshot.generatedAt}`,
    );
    await git('push', '--quiet');
    return { notes: index.length, written, committed: true };
  } catch (error) {
    console.error('public record publish failed', error);
    return null;
  }
}
