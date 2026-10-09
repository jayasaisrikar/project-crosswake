import { JsonLd, organization, pageMeta } from '@/lib/seo';
import { siteUrl } from '@/lib/site';
import { notFound } from 'next/navigation';
import { docs } from '@/lib/docs';
import { DocsView } from '@/components/crosswake/docs-view';
export function generateStaticParams() {
  return docs.filter((d) => d.slug).map((d) => ({ slug: d.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = docs.find((d) => d.slug === slug);
  if (!doc) return { title: 'Not found' };
  return pageMeta({
    title: `${doc.title.replace(/\.$/, '')} · Docs`,
    description: doc.description,
    path: `/docs/${slug}`,
    type: 'article',
  });
}
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!docs.some((d) => d.slug === slug)) notFound();
  const doc = docs.find((d) => d.slug === slug)!;
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: doc.title,
          description: doc.description,
          url: `${siteUrl}/docs/${slug}`,
          dateModified: '2026-10-09',
          author: organization,
          publisher: organization,
          inLanguage: 'en',
        }}
      />
      <DocsView slug={slug} />
    </>
  );
}
