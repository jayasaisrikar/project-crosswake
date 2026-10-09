import type { MetadataRoute } from 'next';
import { docs } from '@/lib/docs';
import { siteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (path: string, priority: number, changeFrequency: 'daily' | 'weekly' | 'monthly') => ({
    url: `${siteUrl}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });
  return [
    page('', 1, 'weekly'),
    page('/performance', 0.9, 'weekly'),
    page('/log', 0.8, 'daily'),
    page('/commitments', 0.6, 'monthly'),
    page('/changelog', 0.6, 'weekly'),
    ...docs.map((d) => page(`/docs${d.slug ? '/' + d.slug : ''}`, 0.7, 'monthly')),
  ];
}
