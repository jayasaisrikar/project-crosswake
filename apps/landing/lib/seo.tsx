import type { Metadata } from 'next';
import { siteName, siteUrl } from './site';

/** Per-page metadata: canonical URL plus matching Open Graph and Twitter fields. */
export function pageMeta({
  title,
  description,
  path,
  type = 'website',
}: {
  title: string;
  description: string;
  path: string;
  type?: 'website' | 'article';
}): Metadata {
  const full = `${title} · ${siteName}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: full, description, url: path, siteName, type, locale: 'en_GB' },
    twitter: { card: 'summary_large_image', title: full, description },
  };
}

/** Structured data for search and answer engines. */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    <script
      type="application/ld+json"
      // JSON-LD must be raw JSON; '<' is escaped so the payload can never close the tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}

export const organization = {
  '@type': 'Organization',
  '@id': `${siteUrl}/#organization`,
  name: siteName,
  url: siteUrl,
  logo: `${siteUrl}/brand/logo-mark.png`,
  description:
    'Crosswake publishes rules-based altcoin trend signals and the full research record behind them, including failed strategies.',
};
