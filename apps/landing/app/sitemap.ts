import type { MetadataRoute } from 'next';
import { docs } from '@/lib/docs';
import { siteUrl } from '@/lib/site';
import { readArticleIndex } from '@/lib/articles';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const page = (
    path: string,
    priority: number,
    changeFrequency: 'daily' | 'weekly' | 'monthly',
    lastModified: Date | string = now,
  ) => ({
    url: `${siteUrl}${path}`,
    lastModified,
    changeFrequency,
    priority,
  });
  const articles = await readArticleIndex();
  return [
    page('', 1, 'weekly'),
    page('/performance', 0.9, 'weekly'),
    page('/ask', 0.8, 'weekly'),
    page('/log', 0.8, 'daily'),
    page('/research', 0.9, 'weekly'),
    ...articles.map((article) =>
      page(`/research/${article.slug}`, 0.8, 'monthly', article.updatedAt),
    ),
    page('/commitments', 0.6, 'monthly'),
    page('/changelog', 0.6, 'weekly'),
    ...docs.map((d) =>
      page(`/docs${d.slug ? '/' + d.slug : ''}`, 0.7, 'monthly'),
    ),
  ];
}
