import { JsonLd, organization, pageMeta } from '@/lib/seo';
import { siteUrl } from '@/lib/site';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/crosswake/site-shell';
import { ScrollEffects } from '@/components/crosswake/scroll-effects';
import { LiveRecord } from '@/components/crosswake/live-record';
import { readSnapshot } from '@/lib/live';
import {
  formatDate,
  readArticleIndex,
  statusLabel,
  type ArticleIndexEntry,
} from '@/lib/articles';

export const revalidate = 600;

export const metadata = pageMeta({
  title: 'Research',
  description:
    'Research notes on the Crosswake strategies: why the failed versions lost money, what a positive average can and cannot prove, and how live paper strategies are judged.',
  path: '/research',
});

const order: ArticleIndexEntry['status'][] = ['failed', 'live', 'method'];

export default async function Page() {
  const [articles, snapshot] = await Promise.all([
    readArticleIndex(),
    readSnapshot(),
  ]);
  const grouped = order
    .map((status) => ({
      status,
      items: articles.filter((a) => a.status === status),
    }))
    .filter((group) => group.items.length);
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
              '@type': 'CollectionPage',
              '@id': `${siteUrl}/research#page`,
              url: `${siteUrl}/research`,
              name: 'Crosswake research notes',
              description:
                'Explanatory research on failed and live Crosswake strategies, written from the published record.',
              isPartOf: { '@id': `${siteUrl}/#website` },
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
              ],
            },
            {
              '@type': 'ItemList',
              itemListElement: articles.map((article, index) => ({
                '@type': 'ListItem',
                position: index + 1,
                url: `${siteUrl}/research/${article.slug}`,
                name: article.title,
              })),
            },
          ],
        }}
      />
      <SiteHeader />
      <main id="main" className="rs-page">
        <header className="rs-hero" data-reveal>
          <span className="rs-eyebrow">Research · written from the record</span>
          <h1>
            Most of these ideas
            <br />
            <span>did not work.</span>
          </h1>
          <p className="rs-lead">
            Each note below takes one strategy, or one idea we retired, and
            explains what the rules were, what the measurement showed, and why
            it turned out that way. Every figure is taken from the frozen test
            outputs and the live paper record. Nothing here is a recommendation,
            and every strategy in the record runs on paper only.
          </p>
          <p className="rs-hero-meta">
            {articles.length} notes · read the{' '}
            <Link href="/changelog">changelog</Link> for every version and{' '}
            <Link href="/docs/strategies">the strategy catalog</Link> for the
            rules.
          </p>
        </header>

        <LiveRecord snapshot={snapshot} />

        {grouped.length === 0 ? (
          <section className="rs-empty" data-reveal>
            <h2>Notes are being written</h2>
            <p>
              The research writer has not published its first notes yet. The
              changelog and the strategy catalog already cover every version.
            </p>
          </section>
        ) : (
          grouped.map((group) => (
            <section
              key={group.status}
              className="rs-group"
              aria-label={`${statusLabel[group.status]} strategies`}
              data-reveal
            >
              <h2>
                {statusLabel[group.status]}
                <em>{group.items.length}</em>
              </h2>
              <div className="rs-cards">
                {group.items.map((article) => (
                  <article key={article.slug} className="rs-card">
                    <Link href={`/research/${article.slug}`}>
                      <span className={`rs-status is-${article.status}`}>
                        {statusLabel[article.status]}
                      </span>
                      <h3>{article.title}</h3>
                      <p>{article.description}</p>
                      <span className="rs-card-meta">
                        {formatDate(article.publishedAt)} ·{' '}
                        {article.readMinutes} min read
                      </span>
                      <span className="rs-card-tags">
                        {article.tags.slice(0, 4).map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          ))
        )}

        <section className="rs-standing" data-reveal>
          <h2>What this page is not</h2>
          <p>
            These notes explain research. They are not signals, advice or
            forecasts. Crosswake publishes paper signals only: no order is ever
            placed. A positive test result is not a promise, and the record's
            own standard says so — the main strategy&apos;s unseen-data
            confidence interval includes zero.
          </p>
        </section>
      </main>
      <SiteFooter />
      <ScrollEffects />
    </div>
  );
}
