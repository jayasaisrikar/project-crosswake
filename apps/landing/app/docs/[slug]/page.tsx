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
  return {
    title: doc ? `${doc.title} · Crosswake Docs` : 'Not found · Crosswake',
    description: doc?.description,
  };
}
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!docs.some((d) => d.slug === slug)) notFound();
  return <DocsView slug={slug} />;
}
