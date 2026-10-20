import { ogContentType, ogImage, ogSize } from '@/lib/og';
import { readArticleIndex } from '@/lib/articles';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake research notes on failed and live strategies';

export default async function Image() {
  const articles = await readArticleIndex();
  const count = (status: string) =>
    articles.filter((article) => article.status === status).length;
  const stats =
    articles.length > 0
      ? ([
          [String(articles.length), 'notes'],
          [String(count('failed')), 'failed'],
          [String(count('live')), 'live paper'],
        ] as [string, string][])
      : undefined;
  return ogImage({
    eyebrow: 'Research · written from the record',
    title: 'Most of these ideas did not work.',
    subtitle:
      'Why each strategy lost or is still unproven, with every figure checked against the record.',
    ...(stats ? { stats } : {}),
  });
}
