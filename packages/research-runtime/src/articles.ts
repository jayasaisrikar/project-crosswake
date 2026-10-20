import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const slug = z
  .string()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const articleStatus = z.enum(['failed', 'live', 'method']);

export const articleSchema = z.object({
  slug,
  title: z.string().min(8).max(120),
  description: z.string().min(40).max(300),
  status: articleStatus,
  tags: z.array(z.string().min(1).max(32)).min(1).max(8),
  publishedAt: z.string().min(10),
  updatedAt: z.string().min(10),
  body: z.string().min(200),
  evidence: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        value: z.string().min(1).max(240),
      }),
    )
    .min(1)
    .max(40),
  sources: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        href: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(8),
  generator: z.object({
    model: z.string().min(1).max(120),
    factsHash: z.string().min(8).max(64),
    gate: z.enum(['model', 'template']),
    modelAttempts: z.number().int().min(0).max(50).default(0),
  }),
});

export type Article = z.infer<typeof articleSchema>;

export type ArticleIndexEntry = {
  slug: string;
  title: string;
  description: string;
  status: Article['status'];
  tags: string[];
  publishedAt: string;
  updatedAt: string;
  readMinutes: number;
};

export const articleRoot = (dataDir: string) =>
  join(dataDir, 'public', 'research');

const indexPath = (dataDir: string) => join(articleRoot(dataDir), 'index.json');

export function readMinutes(body: string) {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

export const toIndexEntry = (article: Article): ArticleIndexEntry => ({
  slug: article.slug,
  title: article.title,
  description: article.description,
  status: article.status,
  tags: article.tags,
  publishedAt: article.publishedAt,
  updatedAt: article.updatedAt,
  readMinutes: readMinutes(article.body),
});

/**
 * Replaces or appends one entry in place. A pass reads the index once and writes several articles,
 * so writing the freshly built article's entry alongside a stale copy of the index would drop every
 * article written earlier in the same pass.
 */
export function upsertIndexEntry(
  index: ArticleIndexEntry[],
  article: Article,
): ArticleIndexEntry[] {
  const entry = toIndexEntry(article),
    at = index.findIndex((existing) => existing.slug === article.slug);
  if (at >= 0) index[at] = entry;
  else index.push(entry);
  return index;
}

export async function writeArticle(
  dataDir: string,
  candidate: Article,
  index: ArticleIndexEntry[],
): Promise<void> {
  const article = articleSchema.parse(candidate);
  const root = articleRoot(dataDir);
  await mkdir(root, { recursive: true });
  const target = join(root, `${article.slug}.json`),
    staged = `${target}.tmp`;
  await writeFile(staged, `${JSON.stringify(article, null, 2)}\n`);
  await rename(staged, target);
  const sorted = [...index].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
  const stagedIndex = `${indexPath(dataDir)}.tmp`;
  await writeFile(stagedIndex, `${JSON.stringify(sorted, null, 2)}\n`);
  await rename(stagedIndex, indexPath(dataDir));
}

export async function readArticleIndex(
  dataDir: string,
): Promise<ArticleIndexEntry[]> {
  try {
    const parsed = JSON.parse(
      await readFile(indexPath(dataDir), 'utf8'),
    ) as unknown;
    return Array.isArray(parsed) ? (parsed as ArticleIndexEntry[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function readArticle(
  dataDir: string,
  value: string,
): Promise<Article | null> {
  const parsed = slug.safeParse(value);
  if (!parsed.success) return null;
  try {
    const article = articleSchema.parse(
      JSON.parse(
        await readFile(
          join(articleRoot(dataDir), `${parsed.data}.json`),
          'utf8',
        ),
      ),
    );
    return article;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return null;
    throw error;
  }
}

export async function articleSlugs(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(articleRoot(dataDir)))
      .filter((name) => name.endsWith('.json') && name !== 'index.json')
      .map((name) => name.slice(0, -'.json'.length))
      .filter((name) => slug.safeParse(name).success)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
