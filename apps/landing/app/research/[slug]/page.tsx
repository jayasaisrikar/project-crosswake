import { JsonLd, organization, pageMeta } from '@/lib/seo';
import { siteUrl } from '@/lib/site';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteFooter, SiteHeader } from '@/components/crosswake/site-shell';
import { ScrollEffects } from '@/components/crosswake/scroll-effects';
import {
  ArticleBody,
  headings,
  slugifyHeading,
} from '@/components/crosswake/article-body';
import { LiveRecord } from '@/components/crosswake/live-record';
import { readSnapshot } from '@/lib/live';
import {
  formatDate,
  readArticle,
  readArticleIndex,
  statusLabel,
} from '@/lib/articles';

export const revalidate = 600;

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = await readArticle(slug);
  if (!article) return { title: 'Note not found' };
  return pageMeta({
    title: article.title,
    description: article.description,
    path: `/research/${article.slug}`,
    type: 'article',
  });
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const article = await readArticle(slug);
  if (!article) notFound();
  const words = article.body.trim().split(/\s+/).filter(Boolean).length;
  const [snapshot, index] = await Promise.all([
    article.status === 'live' ? readSnapshot() : Promise.resolve(null),
    readArticleIndex(),
  ]);
  const related = index
    .filter((entry) => entry.slug !== article.slug)
    .slice(0, 3);
  const contents = headings(article.body);
  const url = `${siteUrl}/research/${article.slug}`;
  return (
    <div className="cw-site cw-docs-site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@graph': [
            organization,
            {
              '@type': 'Article',
              '@id': `${url}#article`,
              headline: article.title,
              description: article.description,
              url,
              mainEntityOfPage: { '@id': url },
              datePublished: article.publishedAt,
              dateModified: article.updatedAt,
              author: { '@id': `${siteUrl}/#organization` },
              publisher: { '@id': `${siteUrl}/#organization` },
              inLanguage: 'en',
              isAccessibleForFree: true,
              wordCount: words,
              keywords: article.tags.join(', '),
              articleSection: statusLabel[article.status],
              about: article.evidence.slice(0, 6).map((item) => ({
                '@type': 'Thing',
                name: item.label,
                description: item.value,
              })),
            },
            {
              '@type': 'BreadcrumbList',
              itemListElement: [
                {
                  '@type': 'ListItem',
                  position: 1,
                  name: 'Home',
                  item: siteUrl,
                },
                {
                  '@type': 'ListItem',
                  position: 2,
                  name: 'Research',
                  item: `${siteUrl}/research`,
                },
                {
                  '@type': 'ListItem',
                  position: 3,
                  name: article.title,
                  item: url,
                },
              ],
            },
          ],
        }}
      />
      <SiteHeader />
      <main id="main" className="rs-page rs-article">
        <nav className="rs-crumbs" aria-label="Breadcrumb">
          <Link href="/research">Research</Link>
          <span aria-hidden="true">/</span>
          <span>{statusLabel[article.status]}</span>
        </nav>
        <header className="rs-article-head" data-reveal>
          <span className={`rs-status is-${article.status}`}>
            {statusLabel[article.status]}
          </span>
          <h1>{article.title}</h1>
          <p className="rs-lead">{article.description}</p>
          <p className="rs-article-meta">
            <time dateTime={article.publishedAt}>
              {formatDate(article.publishedAt)}
            </time>
            {' · '}
            {Math.max(1, Math.round(words / 220))} min read · {words} words
            {article.updatedAt !== article.publishedAt && (
              <>
                {' · updated '}
                <time dateTime={article.updatedAt}>
                  {formatDate(article.updatedAt)}
                </time>
              </>
            )}
          </p>
        </header>

        <div className="rs-article-grid">
          <article className="rs-article-main">
            {contents.length > 1 && (
              <nav className="rs-toc" aria-label="In this note">
                <span>In this note</span>
                <ol>
                  {contents.map((heading) => (
                    <li key={heading}>
                      <a href={`#${slugifyHeading(heading)}`}>{heading}</a>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <ArticleBody body={article.body} lede={article.description} />
          </article>

          <aside className="rs-aside">
            <section className="rs-panel rs-panel-evidence" data-reveal>
              <h2>Evidence behind this note</h2>
              <dl>
                {article.evidence.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="rs-panel" data-reveal>
              <h2>Where it lives in the record</h2>
              <ul className="rs-sources">
                {article.sources.map((source) => (
                  <li key={source.href}>
                    <Link href={source.href}>{source.label}</Link>
                  </li>
                ))}
              </ul>
            </section>
            {related.length > 0 && (
              <section className="rs-panel" data-reveal>
                <h2>More notes</h2>
                <ul className="rs-related">
                  {related.map((entry) => (
                    <li key={entry.slug}>
                      <Link href={`/research/${entry.slug}`}>
                        {entry.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>

        {snapshot && <LiveRecord snapshot={snapshot} />}

        <section className="rs-standing" data-reveal>
          <h2>How this note was written</h2>
          <p>
            It is generated from a fixed fact sheet built from the frozen test
            outputs and the live paper record, then checked so that every figure
            in the text appears in that sheet. Fact sheet{' '}
            <code>{article.generator.factsHash}</code>.
          </p>
          <p>
            Paper research only. Not investment advice, and not a signal. Read
            the <Link href="/commitments">commitments</Link> for what stays
            public and the <Link href="/log">signal log</Link> for every signal
            as it was published.
          </p>
        </section>
      </main>
      <SiteFooter />
      <ScrollEffects />
    </div>
  );
}
