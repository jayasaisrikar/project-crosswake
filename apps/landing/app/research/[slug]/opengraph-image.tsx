import { ogContentType, ogImage, ogSize } from '@/lib/og';
import { readArticle, statusLabel } from '@/lib/articles';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'A Crosswake research note';

const short = (value: string) => value.length <= 16 && /^[^ ]+$/.test(value);

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = await readArticle(slug);
  if (!article)
    return ogImage({
      eyebrow: 'Research',
      title: 'Research notes',
      subtitle: 'Why each strategy worked, or did not.',
    });
  const stats = article.evidence
    .filter((item) => short(item.value))
    .slice(0, 3)
    .map((item) => [item.value, item.label] as [string, string]);
  return ogImage({
    eyebrow: `Research · ${statusLabel[article.status]}`,
    title: article.title,
    subtitle: article.description,
    ...(stats.length ? { stats } : {}),
  });
}
