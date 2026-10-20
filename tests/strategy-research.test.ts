import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  articleSchema,
  articleSlugs,
  readArticle,
  readArticleIndex,
  toIndexEntry,
  upsertIndexEntry,
  writeArticle,
  type Article,
  type ArticleIndexEntry,
} from '../packages/research-runtime/src/articles.js';
import {
  checkArticle,
  factSheet,
  factsHash,
  liveLines,
  needsRewrite,
  numbersIn,
  TEMPLATE_RETRIES,
  planSchema,
  templateBody,
  type Topic,
} from '../packages/research-runtime/src/article-draft.js';
import { publicSnapshot } from '../packages/research-runtime/src/public-snapshot.js';

const topicsPath = new URL('../configs/research-topics.json', import.meta.url),
  corpus = planSchema.parse(JSON.parse(await readFile(topicsPath, 'utf8')));

const live = [
  'trend-daily-v005: the Bitcoin market filter is on.',
  'trend-daily-v005 open: NEARUSDT since 2026-10-12, marked -16.07% against entry.',
];
const sheet = (topic: Topic) => factSheet(topic, live);

describe('research corpus', () => {
  it('parses every topic against the frozen schema', () => {
    expect(corpus.topics.length).toBeGreaterThan(0);
    for (const topic of corpus.topics) {
      expect(topic.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(topic.facts.length).toBeGreaterThan(0);
    }
  });

  it('fits every topic into the article schema, evidence included', () => {
    for (const topic of corpus.topics) {
      const article = {
        slug: topic.slug,
        title: topic.title,
        description: topic.description,
        status: topic.status,
        tags: topic.tags,
        publishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        body: templateBody(topic, live),
        evidence: topic.facts.map((f) => ({ label: f.label, value: f.value })),
        sources: [{ label: 'Changelog', href: '/changelog' }],
        generator: {
          model: 'test',
          factsHash: 'abcdef0123456789',
          gate: 'template',
        },
      };
      expect(articleSchema.safeParse(article).success).toBe(true);
    }
  });

  it('gives every slug a unique article', () => {
    const slugs = corpus.topics.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('takes article sources from configuration, never from code', () => {
    const shared = corpus.defaults?.sources?.length ?? 0;
    expect(shared > 0 || corpus.topics.every((t) => t.sources?.length)).toBe(
      true,
    );
    for (const topic of corpus.topics)
      for (const source of topic.sources ?? corpus.defaults?.sources ?? [])
        expect(source.href).toMatch(/^\//);
  });
});

describe('the deterministic fallback', () => {
  it('always passes its own gate, with live lines and without them', () => {
    for (const topic of corpus.topics) {
      for (const lines of [live, []])
        expect(
          checkArticle(templateBody(topic, lines), factSheet(topic, lines)),
        ).toEqual({
          ok: true,
        });
    }
  });

  it('quotes every curated figure into the fact sheet', () => {
    for (const topic of corpus.topics) {
      const text = sheet(topic);
      for (const fact of topic.facts)
        expect(text).toContain(`${fact.label}: ${fact.value}`);
    }
  });
});

describe('the draft gate', () => {
  const topic = corpus.topics[0]!,
    sheetText = sheet(topic),
    body =
      `${topic.description}\n\n## One\n\nA paragraph with no figures, long enough to clear the floor for this test.`.repeat(
        6,
      );

  it('rejects a number the record does not hold', () => {
    expect(
      checkArticle(`${body}\n\nRevenue rose 123.4% last year.`, sheetText),
    ).toEqual({
      ok: false,
      reason: 'unsourced_numbers:123.4',
    });
  });

  it('allows a number that came from the facts', () => {
    const allowed = numbersIn(sheetText)[0]!;
    expect(numbersIn(`the figure is ${allowed}`)).toContain(allowed);
    expect(
      checkArticle(`${body}\n\nIt measured ${allowed} in the test.`, sheetText),
    ).toEqual({
      ok: true,
    });
  });

  it('rejects advice language', () => {
    expect(
      checkArticle(`${body}\n\nYou should buy this coin now.`, sheetText),
    ).toEqual({
      ok: false,
      reason: 'advice_language',
    });
  });

  it('rejects a body that is too short or has too few sections', () => {
    expect(checkArticle('## One\n\ntoo short', sheetText)).toEqual({
      ok: false,
      reason: 'too_short',
    });
    expect(
      checkArticle(`${'A paragraph with no numbers. '.repeat(80)}`, sheetText),
    ).toEqual({
      ok: false,
      reason: 'missing_sections',
    });
  });

  it('normalises thousands separators before comparing', () => {
    expect(numbersIn('168,000 fits')).toEqual(['168000']);
  });
});

describe('whether a topic still needs writing', () => {
  const done = (
    over: Partial<{ factsHash: string; model: string; gate: string }> = {},
  ) => ({
    generator: {
      factsHash: 'aaa',
      model: 'free-model',
      gate: 'model',
      ...over,
    } as {
      factsHash: string;
      model: string;
      gate: 'model' | 'template';
    },
  });

  it('skips a model-written article whose facts and model are unchanged', () => {
    expect(needsRewrite(done(), 'aaa', 'free-model')).toBe(false);
  });

  it('retries a templated article rather than treating it as finished', () => {
    expect(needsRewrite(done({ gate: 'template' }), 'aaa', 'free-model')).toBe(
      true,
    );
  });

  it('does not retry a template when no model is configured at all', () => {
    const templated = {
      generator: {
        factsHash: 'aaa',
        model: 'template',
        gate: 'template' as const,
      },
    };
    expect(needsRewrite(templated, 'aaa', '')).toBe(false);
  });

  it('rewrites when the facts or the configured model changed', () => {
    expect(needsRewrite(done(), 'bbb', 'free-model')).toBe(true);
    expect(needsRewrite(done(), 'aaa', 'another-model')).toBe(true);
    expect(needsRewrite(null, 'aaa', 'free-model')).toBe(true);
  });

  it('gives up on a topic the model keeps failing, so it stops costing calls', () => {
    const stubborn = (modelAttempts: number) =>
      done({ gate: 'template', modelAttempts } as never);
    expect(needsRewrite(stubborn(1), 'aaa', 'free-model')).toBe(true);
    expect(needsRewrite(stubborn(TEMPLATE_RETRIES), 'aaa', 'free-model')).toBe(
      false,
    );
  });
});

describe('fact sheet hashing', () => {
  it('is stable and changes when the facts change', () => {
    const topic = corpus.topics[0]!,
      a = factsHash(sheet(topic));
    expect(factsHash(sheet(topic))).toBe(a);
    expect(factsHash(factSheet(topic, [...live, 'one more line']))).not.toBe(a);
  });
});

describe('live lines', () => {
  const snapshot = {
    version: 1,
    generatedAt: '2026-10-20T17:00:00.000Z',
    executionEnabled: false as const,
    collector: {
      connected: true,
      lastMessageAt: '2026-10-20T17:00:00.000Z',
      symbols: ['BTCUSDT'],
    },
    engines: [
      {
        id: 'trend-daily-v005',
        version: 'trend-daily-v005',
        kind: 'trend-daily',
        market: 'spot',
        instrument: 'outright',
        liveSince: '2026-10-01T00:00:00.000Z',
        regimeOn: true,
        positions: [
          {
            symbol: 'NEARUSDT',
            side: null,
            since: '2026-10-12T00:00:00.000Z',
            markBps: -1607.34,
            targetBps: null,
            stopBps: null,
            exitBy: null,
          },
        ],
        stats: {
          trades: 1,
          winRate: 0,
          netExpectancyBps: -1787.02,
          profitFactor: 0,
          medianBps: null,
        },
        watch: [{ symbol: 'TRXUSDT', toHighBps: -154.12 }],
        lastEventAt: '2026-10-18T00:00:00.000Z',
        telegram: true,
        executionEnabled: false,
      },
    ],
    events: [
      {
        id: 'e1',
        at: '2026-10-18T00:00:00.000Z',
        engine: 'trend-daily-v005',
        kind: 'exit' as const,
        symbol: 'ATOMUSDT',
        market: 'spot',
        side: 'long',
        price: 1.703,
        netBps: -1787.02,
        reason: 'breakdown',
      },
    ],
    digestLastPostAt: null,
  };

  it('never hands out an epoch millisecond', () => {
    const lines = liveLines(snapshot, ['trend-daily-v005']);
    expect(lines.some((l) => l.includes('2026-10-12'))).toBe(true);
    expect(lines.join(' ')).not.toMatch(/\b17\d{11}\b/);
  });

  it('reads the open position, the watch list and the latest event', () => {
    const text = liveLines(snapshot, ['trend-daily-v005']).join('\n');
    expect(text).toContain('NEARUSDT');
    expect(text).toContain('TRXUSDT');
    expect(text).toContain('ATOMUSDT');
    expect(text).toContain('on');
  });

  it('skips engines the topic did not ask for', () => {
    expect(liveLines(snapshot, ['htf-rsi-v007'])).toEqual([]);
  });

  it('leaves a running mark out, so a drifting price cannot cost a model call', () => {
    const moved = structuredClone(snapshot);
    moved.engines[0]!.positions[0]!.markBps = -9999.99;
    const topic = corpus.topics.find((t) => t.engines?.length)!,
      a = factSheet(topic, liveLines(snapshot, topic.engines!)),
      b = factSheet(topic, liveLines(moved, topic.engines!));
    expect(a).toBe(b);
    expect(factsHash(a)).toBe(factsHash(b));
    expect(a).not.toMatch(/marked/);
  });
});

describe('the article store', () => {
  let dir = '';
  const article: Article = {
    slug: 'a-note',
    title: 'A note about a test',
    description:
      'A description long enough to satisfy the schema for this round trip test.',
    status: 'failed',
    tags: ['v001'],
    publishedAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    body: `## One\n\n${'Body text that clears the schema floor. '.repeat(8)}`,
    evidence: [{ label: 'Costs', value: '16 bps' }],
    sources: [{ label: 'Changelog', href: '/changelog' }],
    generator: {
      model: 'test',
      factsHash: 'abcdef0123456789',
      gate: 'template',
      modelAttempts: 0,
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crosswake-articles-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips an article and its index', async () => {
    await writeArticle(dir, article, [toIndexEntry(article)]);
    expect(await readArticle(dir, 'a-note')).toEqual(article);
    expect((await readArticleIndex(dir)).map((e) => e.slug)).toEqual([
      'a-note',
    ]);
    expect(await articleSlugs(dir)).toEqual(['a-note']);
  });

  it('keeps every article when one pass writes several against one read of the index', async () => {
    const index: ArticleIndexEntry[] = [];
    for (const slug of ['a-note', 'b-note', 'c-note']) {
      const one = { ...article, slug, title: `A note about ${slug}` };
      await writeArticle(dir, one, upsertIndexEntry(index, one));
    }
    expect((await readArticleIndex(dir)).map((e) => e.slug).sort()).toEqual([
      'a-note',
      'b-note',
      'c-note',
    ]);
    expect(await articleSlugs(dir)).toHaveLength(3);
  });

  it('rewrites a topic in place rather than duplicating it', async () => {
    const index: ArticleIndexEntry[] = [];
    await writeArticle(dir, article, upsertIndexEntry(index, article));
    const revised = { ...article, title: 'A renamed note about a test' };
    await writeArticle(dir, revised, upsertIndexEntry(index, revised));
    const entries = await readArticleIndex(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('A renamed note about a test');
  });

  it('returns null rather than throwing on a malformed or missing article', async () => {
    await mkdir(join(dir, 'public', 'research'), { recursive: true });
    await writeFile(
      join(dir, 'public', 'research', 'broken.json'),
      '{"slug":"broken"}',
    );
    await writeFile(join(dir, 'public', 'research', 'index.json'), 'not json');
    expect(await readArticle(dir, 'broken')).toBeNull();
    expect(await readArticle(dir, 'absent')).toBeNull();
    expect(await readArticleIndex(dir)).toEqual([]);
  });

  it('refuses a slug that is not a slug', async () => {
    expect(await readArticle(dir, '../secrets')).toBeNull();
    expect(await readArticle(dir, 'Not A Slug')).toBeNull();
  });
});

describe('public snapshot', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crosswake-snapshot-'));
    await mkdir(join(dir, 'trend', 'live', 'trend-daily-v005'), {
      recursive: true,
    });
    await writeFile(
      join(dir, 'trend', 'live', 'trend-daily-v005', 'state.json'),
      JSON.stringify({
        version: 'trend-daily-v005',
        forwardStart: 1790812800000,
        regime: { on: true },
        channels: [
          { name: 'dashboard', enabled: true },
          { name: 'telegram', enabled: true },
        ],
        open: [
          { symbol: 'NEARUSDT', entryTs: 1791763200000, markBps: -1607.3405 },
        ],
        watch: [{ symbol: 'TRXUSDT', toHighBps: -154.1197 }],
        stats: {
          trades: 1,
          winRate: 0,
          netExpectancyBps: -1787.0183,
          profitFactor: 0,
        },
        events: [
          {
            id: 'ATOMUSDT-1791590400000-entry',
            kind: 'entry',
            symbol: 'ATOMUSDT',
            decidedAt: 1791504000000,
            fillAt: 1791590400000,
            price: 2.066,
          },
        ],
        executionEnabled: false,
      }),
    );
    await mkdir(join(dir, 'residual', 'live', 'catchdown-perp-v004'), {
      recursive: true,
    });
    await writeFile(
      join(dir, 'residual', 'live', 'catchdown-perp-v004', 'health.json'),
      JSON.stringify({
        at: 1792515843885,
        version: 'catchdown-perp-v004',
        market: 'usdm',
        channels: [{ name: 'telegram', enabled: false }],
        lastStepTs: 1792515840000,
        open: [],
        sessionTrades: 6,
        sessionNetExpectancyBps: 2.745,
      }),
    );
    await writeFile(
      join(dir, 'residual', 'live', 'catchdown-perp-v004', 'signals.jsonl'),
      `${JSON.stringify({
        id: 'res-1',
        symbol: 'SUIUSDT',
        side: 'SHORT',
        publishedAt: 1792456504134,
        referencePrice: 0.9939,
        expectedNetBps: -10.05,
        accepted: true,
      })}\n{"id":"partial","accepted":tr`,
    );
    await writeFile(
      join(dir, 'collector-health.json'),
      JSON.stringify({
        connected: true,
        lastMessageAt: 1792515890924,
        symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('projects the engines, the events and the collector as ISO strings', async () => {
    const snapshot = await publicSnapshot(dir);
    const trend = snapshot.engines.find((e) => e.id === 'trend-daily-v005')!;
    expect(snapshot.collector).toEqual({
      connected: true,
      lastMessageAt: '2026-10-20T17:04:50.924Z',
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    });
    expect(trend.regimeOn).toBe(true);
    expect(trend.telegram).toBe(true);
    expect(trend.positions[0]).toMatchObject({
      symbol: 'NEARUSDT',
      markBps: -1607.34,
    });
    expect(trend.lastEventAt).toBe('2026-10-10T00:00:00.000Z');
    expect(
      snapshot.engines.find((e) => e.id === 'catchdown-perp-v004')!.telegram,
    ).toBe(false);
    expect(snapshot.executionEnabled).toBe(false);
  });

  it('keeps a stalled final append out of the ledger read', async () => {
    const snapshot = await publicSnapshot(dir);
    expect(snapshot.events.map((e) => e.id)).toEqual([
      'res-1',
      'ATOMUSDT-1791590400000-entry',
    ]);
    expect(snapshot.events[0]).toMatchObject({
      kind: 'signal',
      symbol: 'SUIUSDT',
      at: '2026-10-20T00:35:04.134Z',
      price: 0.9939,
    });
  });

  it('reports an empty record without inventing an engine', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'crosswake-empty-'));
    try {
      const snapshot = await publicSnapshot(empty);
      expect(snapshot.engines).toEqual([]);
      expect(snapshot.events).toEqual([]);
      expect(snapshot.collector).toEqual({
        connected: false,
        lastMessageAt: null,
        symbols: [],
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
