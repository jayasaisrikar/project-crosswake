import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readArticleIndex,
  upsertIndexEntry,
  writeArticle,
  type Article,
} from '../packages/research-runtime/src/articles.js';
import { publishPublicRecord } from '../packages/research-runtime/src/public-mirror.js';

const run = promisify(execFile);
const git = (dir: string, ...args: string[]) =>
  run('git', ['-C', dir, ...args]);

const long = (text: string) =>
  `${text} ${'Detail for the schema floor. '.repeat(8)}`;

const article = (slug: string, body: string): Article => ({
  slug,
  title: `A note about ${slug}`,
  description:
    'A description long enough for the schema to accept it as a real research note.',
  status: 'failed',
  tags: ['v005'],
  publishedAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  body: long(body),
  evidence: [{ label: 'Trades', value: '243' }],
  sources: [{ label: 'Changelog', href: '/changelog' }],
  generator: {
    model: 'test',
    factsHash: 'abcdef1234567890',
    gate: 'template',
    modelAttempts: 0,
  },
});

describe('publishPublicRecord', () => {
  let dataDir: string;
  let repoDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cw-data-'));
    const origin = await mkdtemp(join(tmpdir(), 'cw-origin-'));
    await run('git', ['init', '--quiet', '--bare', origin]);
    repoDir = await mkdtemp(join(tmpdir(), 'cw-repo-'));
    await run('git', ['init', '--quiet', repoDir]);
    await git(repoDir, 'config', 'user.email', 'test@crosswake.local');
    await git(repoDir, 'config', 'user.name', 'Crosswake Test');
    await git(repoDir, 'remote', 'add', 'origin', origin);
    await writeFile(join(repoDir, 'trend-daily-v005.jsonl'), '');
    await git(repoDir, 'add', '.');
    await git(repoDir, 'commit', '--quiet', '-m', 'init');
    await git(repoDir, 'push', '--quiet', '-u', 'origin', 'HEAD');

    const index = upsertIndexEntry(
      [],
      article(
        'first-note',
        'The first note body, long enough to be a real note.',
      ),
    );
    await writeArticle(
      dataDir,
      article(
        'first-note',
        'The first note body, long enough to be a real note.',
      ),
      index,
    );
  });

  afterEach(async () => {
    await run('rm', ['-rf', dataDir, repoDir]);
  });

  it('writes the index, the notes and the record, then commits them', async () => {
    const result = await publishPublicRecord(dataDir, repoDir);
    expect(result).toMatchObject({ notes: 1, committed: true });
    const dir = join(repoDir, 'research');
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(index.articles).toHaveLength(1);
    expect(index.articles[0].slug).toBe('first-note');
    const note = JSON.parse(
      await readFile(join(dir, 'first-note.json'), 'utf8'),
    );
    expect(note.body).toContain('The first note body');
    const record = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8'));
    expect(record.executionEnabled).toBe(false);
    const { stdout } = await git(repoDir, 'log', '--oneline', '-1');
    expect(stdout).toContain('research: 1 notes');
  });

  it('commits nothing when the record has not changed', async () => {
    await publishPublicRecord(dataDir, repoDir);
    const second = await publishPublicRecord(dataDir, repoDir);
    expect(second).toMatchObject({ notes: 1, written: 0, committed: false });
    const { stdout } = await git(repoDir, 'rev-list', '--count', 'HEAD');
    expect(stdout.trim()).toBe('2');
  });

  it('republishes when a note body changes', async () => {
    await publishPublicRecord(dataDir, repoDir);
    const index = await readArticleIndex(dataDir);
    await writeArticle(
      dataDir,
      article(
        'first-note',
        'A rewritten body, still long enough to pass the schema gate.',
      ),
      upsertIndexEntry(index, {
        ...article(
          'first-note',
          'A rewritten body, still long enough to pass the schema gate.',
        ),
        updatedAt: '2026-10-22T00:00:00.000Z',
      }),
    );
    const result = await publishPublicRecord(dataDir, repoDir);
    expect(result).toMatchObject({ committed: true });
    const note = JSON.parse(
      await readFile(join(repoDir, 'research', 'first-note.json'), 'utf8'),
    );
    expect(note.body).toContain('A rewritten body');
  });

  it('drops a note that left the index', async () => {
    await publishPublicRecord(dataDir, repoDir);
    const index = await readArticleIndex(dataDir);
    await writeArticle(
      dataDir,
      article('second-note', 'A second note body, long enough.'),
      [
        ...index,
        {
          slug: 'second-note',
          title: 'A note about second-note',
          description: 'A description long enough for the schema to accept it.',
          status: 'failed',
          tags: ['v005'],
          publishedAt: '2026-10-21T00:00:00.000Z',
          updatedAt: '2026-10-21T00:00:00.000Z',
          readMinutes: 1,
        },
      ],
    );
    await publishPublicRecord(dataDir, repoDir);
    expect(await readdir(join(repoDir, 'research'))).toContain(
      'second-note.json',
    );

    await writeFile(
      join(dataDir, 'public', 'research', 'index.json'),
      JSON.stringify(
        { articles: (await readArticleIndex(dataDir))!.slice(0, 1) },
        null,
        1,
      ),
    );
    const result = await publishPublicRecord(dataDir, repoDir);
    expect(result).toMatchObject({ committed: true });
    expect(await readdir(join(repoDir, 'research'))).not.toContain(
      'second-note.json',
    );
  });
});
