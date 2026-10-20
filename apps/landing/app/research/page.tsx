import { JsonLd, organization, pageMeta } from '@/lib/seo';
import { siteUrl, telegramUrl } from '@/lib/site';
import { ArrowDown, ArrowUpRight } from 'lucide-react';
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

const groupNote: Record<ArticleIndexEntry['status'], string> = {
  failed: 'Tested, lost, retired. Kept on the record.',
  live: 'Passed the frozen test. Now judged on paper, in public.',
  method: 'How a strategy is judged before it earns a place.',
};

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
  const count = (status: ArticleIndexEntry['status']) =>
    articles.filter((a) => a.status === status).length;
  const failed = count('failed'),
    live = count('live');
  const featured = [...articles].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  )[0];
  const cta = telegramUrl ?? '/#signals';
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
          <span className="rs-eyebrow">
            <i aria-hidden="true" /> Open research · written from the record
          </span>
          <h1>
            We publish the strategies
            <br />
            <span>that lost money.</span>
          </h1>
          <p className="rs-lead">
            Most trading products show you the winners. We show you the whole
            record: every idea we tested, the rules it ran on, what the frozen
            test said, and why it failed or earned a place. If a strategy
            survives this page, you can see exactly how hard it was tried.
          </p>
          <div className="rs-hero-actions">
            <a className="rs-btn is-primary" href={failed ? '#failed' : '#notes'}>
              Read the failures <ArrowDown size={16} aria-hidden="true" />
            </a>
            <Link className="rs-btn" href={cta}>
              {telegramUrl ? 'Get new notes on Telegram' : 'Get the signals'}
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <dl className="rs-stats">
            <div>
              <dt>Notes published</dt>
              <dd>{articles.length}</dd>
            </div>
            <div>
              <dt>Ideas retired</dt>
              <dd className="is-failed">{failed}</dd>
            </div>
            <div>
              <dt>Live on paper</dt>
              <dd className="is-live">
                {snapshot ? snapshot.engines.length : live}
              </dd>
            </div>
            <div>
              <dt>Real orders placed</dt>
              <dd>0</dd>
            </div>
          </dl>
        </header>

        {featured && (
          <Link
            href={`/research/${featured.slug}`}
            className="rs-featured"
            data-reveal
          >
            <span className="rs-featured-kicker">
              Latest note
              <span className={`rs-status is-${featured.status}`}>
                {statusLabel[featured.status]}
              </span>
            </span>
            <h2>{featured.title}</h2>
            <p>{featured.description}</p>
            <span className="rs-featured-foot">
              <span className="rs-card-meta">
                {formatDate(featured.publishedAt)} · {featured.readMinutes} min
                read
              </span>
              <span className="rs-featured-go">
                Read the note <ArrowUpRight size={16} aria-hidden="true" />
              </span>
            </span>
          </Link>
        )}

        <section className="rs-why" aria-label="Why we publish this" data-reveal>
          <article>
            <b>01</b>
            <h3>Failures first</h3>
            <p>
              A retired idea gets the same write-up as a live one. You see the
              losses before you see anything else.
            </p>
          </article>
          <article>
            <b>02</b>
            <h3>Frozen before tested</h3>
            <p>
              Rules are fixed before the unseen data is opened. A failed test is
              not retuned until it passes.
            </p>
          </article>
          <article>
            <b>03</b>
            <h3>Every number checkable</h3>
            <p>
              Figures come from the test outputs and the{' '}
              <Link href="/log">tamper-evident signal log</Link>, not from a
              marketing deck.
            </p>
          </article>
        </section>

        <LiveRecord snapshot={snapshot} />

        <div id="notes" className="rs-notes-head" data-reveal>
          <h2>The notes</h2>
          {grouped.length > 1 && (
            <nav className="rs-chips" aria-label="Jump to a group">
              {grouped.map((group) => (
                <a key={group.status} href={`#${group.status}`}>
                  <span className={`rs-dot is-${group.status}`} />
                  {statusLabel[group.status]}
                  <em>{group.items.length}</em>
                </a>
              ))}
            </nav>
          )}
        </div>

        {grouped.length === 0 ? (
          <section className="rs-empty" data-reveal>
            <h2>Notes are being written</h2>
            <p>
              The research writer has not published its first notes yet. The{' '}
              <Link href="/changelog">changelog</Link> and the{' '}
              <Link href="/docs/strategies">strategy catalog</Link> already
              cover every version.
            </p>
          </section>
        ) : (
          grouped.map((group) => (
            <section
              key={group.status}
              id={group.status}
              className={`rs-group is-${group.status}`}
              aria-label={`${statusLabel[group.status]} strategies`}
              data-reveal
            >
              <h2>
                {statusLabel[group.status]}
                <em>{group.items.length}</em>
                <small>{groupNote[group.status]}</small>
              </h2>
              <div className="rs-cards">
                {group.items.map((article, index) => (
                  <article key={article.slug} className="rs-card">
                    <Link href={`/research/${article.slug}`}>
                      <span className="rs-card-top">
                        <span className={`rs-status is-${article.status}`}>
                          {statusLabel[article.status]}
                        </span>
                        <span className="rs-card-index">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                      </span>
                      <h3>{article.title}</h3>
                      <p>{article.description}</p>
                      <span className="rs-card-tags">
                        {article.tags.slice(0, 4).map((tag) => (
                          <em key={tag}>{tag}</em>
                        ))}
                      </span>
                      <span className="rs-card-foot">
                        <span className="rs-card-meta">
                          {formatDate(article.publishedAt)} ·{' '}
                          {article.readMinutes} min read
                        </span>
                        <ArrowUpRight size={16} aria-hidden="true" />
                      </span>
                    </Link>
                  </article>
                ))}
              </div>
            </section>
          ))
        )}

        <section className="rs-cta" data-reveal>
          <div>
            <h2>
              Watch the next idea
              <br />
              <span>pass or fail in public.</span>
            </h2>
            <p>
              New notes land when a test finishes, whichever way it goes. Live
              paper signals post to the channel as they happen.
            </p>
          </div>
          <div className="rs-cta-actions">
            <Link className="rs-btn is-primary" href={cta}>
              {telegramUrl ? 'Join the Telegram channel' : 'Get the signals'}
              <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
            <Link className="rs-btn" href="/performance">
              See the performance record
            </Link>
          </div>
        </section>

        <section className="rs-standing" data-reveal>
          <h2>What this page is not</h2>
          <p>
            These notes explain research. They are not signals, advice or
            forecasts. Crosswake publishes paper signals only: no order is ever
            placed. A positive test result is not a promise, and the record&apos;s
            own standard says so — the main strategy&apos;s unseen-data
            confidence interval includes zero. Every version is in the{' '}
            <Link href="/changelog">changelog</Link>.
          </p>
        </section>
      </main>
      <SiteFooter />
      <ScrollEffects />
    </div>
  );
}
