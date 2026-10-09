import { docs } from '@/lib/docs';
import { ogContentType, ogImage, ogSize } from '@/lib/og';

export const size = ogSize;
export const contentType = ogContentType;
export const alt = 'Crosswake documentation';

export function generateStaticParams() {
  return docs.filter((d) => d.slug).map((d) => ({ slug: d.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = docs.find((d) => d.slug === slug);
  return ogImage({
    eyebrow: 'Documentation',
    title: doc?.title ?? 'Crosswake docs',
    subtitle: doc?.description,
  });
}
