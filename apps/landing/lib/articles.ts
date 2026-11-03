import { readRecord } from './api';

export const ARTICLE_REVALIDATE = 600;

export type ArticleStatus = 'failed' | 'live' | 'method';

export type ArticleIndexEntry = {
  slug: string;
  title: string;
  description: string;
  status: ArticleStatus;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  readMinutes: number;
};

export type Article = ArticleIndexEntry & {
  body: string;
  evidence: { label: string; value: string }[];
  sources: { label: string; href: string }[];
  generator: { model: string; factsHash: string; gate: 'model' | 'template' };
};

const isEntry = (value: unknown) =>
  !!value && typeof (value as ArticleIndexEntry).slug === 'string';

/** Null when the record could not be read; an empty array means nothing is published. */
export async function readArticleIndex(): Promise<ArticleIndexEntry[] | null> {
  const payload = await readRecord<{ articles: ArticleIndexEntry[] }>(
    '/research/index.json',
    '/articles',
    ARTICLE_REVALIDATE,
    (value) => Array.isArray((value as { articles?: unknown }).articles),
  );
  return payload ? payload.articles.filter(isEntry) : null;
}

export async function readArticle(slug: string): Promise<Article | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return readRecord<Article>(
    `/research/${slug}.json`,
    `/articles/${slug}`,
    ARTICLE_REVALIDATE,
    (value) => {
      const a = value as Article;
      return (
        isEntry(value) &&
        typeof a.body === 'string' &&
        Array.isArray(a.evidence)
      );
    },
  );
}

export const statusLabel: Record<ArticleStatus, string> = {
  failed: 'Failed',
  live: 'Live paper',
  method: 'Method',
};

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
