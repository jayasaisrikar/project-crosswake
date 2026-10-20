import { apiBase } from './live';

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

async function read<T>(path: string, shape: (value: unknown) => boolean) {
  const base = apiBase(),
    token = process.env.RESEARCH_API_TOKEN;
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      next: { revalidate: ARTICLE_REVALIDATE },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return shape(payload) ? (payload as T) : null;
  } catch {
    return null;
  }
}

const isEntry = (value: unknown) =>
  !!value && typeof (value as ArticleIndexEntry).slug === 'string';

export async function readArticleIndex(): Promise<ArticleIndexEntry[]> {
  const payload = await read<{ articles: ArticleIndexEntry[] }>(
    '/articles',
    (value) => Array.isArray((value as { articles?: unknown }).articles),
  );
  return (payload?.articles ?? []).filter(isEntry);
}

export async function readArticle(slug: string): Promise<Article | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return read<Article>(`/articles/${slug}`, (value) => {
    const a = value as Article;
    return (
      isEntry(value) && typeof a.body === 'string' && Array.isArray(a.evidence)
    );
  });
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
