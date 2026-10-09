import { JsonLd, organization } from '@/lib/seo';
import { siteDescription, siteUrl } from '@/lib/site';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  ShieldCheck,
  MoveUpRight,
} from 'lucide-react';
import { SiteHeader, SiteFooter } from '@/components/crosswake/site-shell';
import { ScrollEffects } from '@/components/crosswake/scroll-effects';
import { MarketScene } from '@/components/crosswake/market-scene';
import { TelegramFeed } from '@/components/crosswake/telegram-feed';
import { HyperliquidBanner } from '@/components/crosswake/hyperliquid-banner';
import { HowItWorks } from '@/components/crosswake/how-it-works';
import {
  HeroParallax,
  ProductEntrance,
  ProductExperience,
} from '@/components/crosswake/product-experience';
const questions = [
  [
    'Does Crosswake place trades?',
    'No. Every strategy currently runs in paper mode. Signals are recorded and tracked, but Crosswake does not place real orders.',
  ],
  [
    'How long does a signal last?',
    'The main daily trend strategy is designed for moves lasting days to weeks. Entries and exits follow daily candle rules, rather than second-by-second price changes.',
  ],
  [
    'Has the strategy proven an edge?',
    'Not yet. The main strategy was profitable on average in its unseen-data test, but its confidence interval includes zero. Live paper tracking is gathering more evidence.',
  ],
  [
    'What are the market updates?',
    'Market summaries cover ten major coins every four hours. They describe observed momentum and paper positions. They are separate from strategy-generated trade signals.',
  ],
];
const tickerItems = [
  ['BTC', 'sets the direction'],
  ['100D', 'market filter'],
  ['20D', 'breakout entry'],
  ['10D', 'low exit'],
  ['4H', 'market updates'],
  ['36', 'coins scanned daily'],
  ['0', 'hidden failures'],
  ['PAPER', 'tracked live'],
];
export default function Page() {
  return (
    <div className="cw-site cw-landing">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@graph': [
            organization,
            {
              '@type': 'WebSite',
              '@id': `${siteUrl}/#website`,
              url: siteUrl,
              name: 'Crosswake',
              description: siteDescription,
              publisher: { '@id': `${siteUrl}/#organization` },
              inLanguage: 'en',
            },
            {
              '@type': 'FAQPage',
              mainEntity: questions.map(([q, a]) => ({
                '@type': 'Question',
                name: q,
                acceptedAnswer: { '@type': 'Answer', text: a },
              })),
            },
          ],
        }}
      />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <ScrollEffects />
      <main id="main">
        <section className="cw-hero kinetic-hero">
          <HeroParallax>
            <div className="kinetic-hero-copy">
              <HyperliquidBanner className="hero-rise" />
              <div className="hero-edition hero-rise">
                <span className="cw-status-dot" /> ALTCOIN TREND SIGNALS · FREE ON
                TELEGRAM
              </div>
              <h1 className="hero-rise">
                Signals you
                <br />
                can verify<span className="hero-period">.</span>
              </h1>
              <div className="hero-subline hero-rise">
                <span>Know what to buy, and when to get out.</span>
              </div>
              <p className="hero-rise">
                Crosswake scans 36 major coins after every daily close. When an
                altcoin breaks out while Bitcoin is in an uptrend, you get the
                coin, the entry and the exit rule on Telegram. Every result is
                published after fees, losses included.
              </p>
              <div className="cw-actions hero-rise">
                <Link className="cw-button" href="#signals">
                  Get free signals <ArrowUpRight size={18} />
                </Link>
                <Link className="cw-text-button" href="#how">
                  How it works <ArrowRight size={16} />
                </Link>
              </div>
              <ul className="hero-facts hero-rise" aria-label="At a glance">
                <li>
                  <strong>36</strong> coins scanned daily
                </li>
                <li>
                  <strong>Days–weeks</strong> per trade
                </li>
                <li>
                  <strong>Every</strong> result published
                </li>
              </ul>
            </div>
            <MarketScene />
          </HeroParallax>
          <div className="kinetic-hero-bottom">
            <span>MARKETS MOVE. EVIDENCE COMPOUNDS.</span>
            <span>RESEARCH FIRST. ALWAYS.</span>
          </div>
        </section>
        <div className="cw-ticker" aria-hidden="true">
          <div>
            {[0, 1].map((k) =>
              tickerItems.map(([sym, note]) => (
                <span key={k + sym}>
                  <b>{sym}</b> {note}
                </span>
              )),
            )}
          </div>
        </div>
        <HowItWorks />
        <TelegramFeed />
        <div id="product-preview">
          <ProductEntrance />
        </div>
        <section className="kinetic-statement" data-reveal>
          <p>
            Most signal groups post calls.
            <br />
            Few show what happened next.
          </p>
          <h2>
            Every signal has a rule.
            <br />
            <span>Every result stays on the record.</span>
          </h2>
          <Link className="cw-text-button" href="/docs/validation">
            This is how we research <ArrowUpRight size={17} />
          </Link>
        </section>
        <ProductExperience />
        <section id="approach" className="cw-section cw-approach" data-reveal>
          <div className="cw-section-heading">
            <h2>
              A trend is a pattern.
              <br />
              <span>A strategy has rules.</span>
            </h2>
            <p>
              Markets move together. Opportunities don’t.
              <br />
              Crosswake looks for strength in altcoins while Bitcoin sets the
              direction.
            </p>
          </div>
          <div className="cw-strategy">
            <div className="cw-strategy-visual">
              <div className="cw-visual-heading">
                <span>DAILY TREND / v005</span>
                <span>Rule illustration</span>
              </div>
              <svg
                viewBox="0 0 620 265"
                className="rule-chart"
                role="img"
                aria-label="Illustrative breakout above a prior high, followed by a trend and exit"
              >
                <defs>
                  <linearGradient id="rule-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#7ac74f" stopOpacity=".28" />
                    <stop offset="1" stopColor="#7ac74f" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  className="cw-chart-grid"
                  d="M0 60H620M0 120H620M0 180H620M0 240H620M80 0V265M200 0V265M320 0V265M440 0V265M560 0V265"
                />
                <rect className="rule-hold" x="210" y="0" width="365" height="265" />
                <path className="cw-chart-threshold" d="M0 170H620" />
                <text className="rule-label" x="8" y="162">20-day high</text>
                <path
                  className="rule-area"
                  d="M210 146L235 157L260 119L282 131L305 88L331 107L355 70L380 80L404 44L429 62L452 36L477 67L500 52L525 91L551 82L575 123V265H210Z"
                />
                <path
                  className="cw-chart-line"
                  pathLength={1}
                  d="M0 226L24 220L45 236L70 208L92 218L118 187L140 202L162 179L186 191L210 146L235 157L260 119L282 131L305 88L331 107L355 70L380 80L404 44L429 62L452 36L477 67L500 52L525 91L551 82L575 123L598 111L620 145"
                />
                <g className="rule-marker rule-entry">
                  <circle cx="210" cy="146" r="14" className="rule-pulse" />
                  <circle cx="210" cy="146" r="6" className="cw-chart-point" />
                  <text x="210" y="126" textAnchor="middle">BUY</text>
                </g>
                <g className="rule-marker rule-exit">
                  <circle cx="575" cy="123" r="14" className="rule-pulse" />
                  <circle cx="575" cy="123" r="6" className="cw-chart-point is-exit" />
                  <text x="575" y="103" textAnchor="middle">SELL</text>
                </g>
              </svg>
              <div className="cw-chart-caption">
                <span>20-day breakout ↗</span>
                <span>Follow strength</span>
                <span>10-day exit ↘</span>
              </div>
              <p>
                Illustrative price path. Not a historical result or active
                signal.
              </p>
            </div>
            <div className="cw-rules" data-stagger>
              {[
                [
                  'Market filter',
                  'Start with Bitcoin.',
                  'Look for entries only when Bitcoin closes above its 100-day average.',
                ],
                [
                  'Entry rule',
                  'Follow a new high.',
                  'Enter after a coin closes above its highest close of the prior 20 days.',
                ],
                [
                  'Exit discipline',
                  'Know when to leave.',
                  'Exit on a 10-day low or when the Bitcoin market filter turns off.',
                ],
              ].map(([label, title, body]) => (
                <div key={label}>
                  <small>{label}</small>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </div>
          <Link className="cw-text-button" href="/docs/strategies">
            Read the full rules <ArrowRight size={16} />
          </Link>
        </section>
        <section id="research" className="cw-section cw-research" data-reveal>
          <div className="cw-section-heading">
            <h2>
              Show the work.
              <br />
              <span>All of it.</span>
            </h2>
            <p>
              No cherry-picked wins. No hidden failures.
              <br />A strategy earns trust through testing, then through time.
            </p>
          </div>
          <div className="cw-results">
            <div className="cw-result-title">
              <span>v005 · Unseen-data test</span>
              <span>JAN 2025 — SEP 2026</span>
            </div>
            <div className="cw-metrics">
              <div>
                <strong data-count="243">243</strong>
                <span>Completed trades</span>
              </div>
              <div>
                <strong>
                  <span data-count="33.7">33.7</span><span>%</span>
                </strong>
                <span>Win rate</span>
              </div>
              <div>
                <strong>
                  <span data-count="1.5" data-prefix="+">+1.5</span><span>%</span>
                </strong>
                <span>Average net return / trade</span>
              </div>
              <div>
                <strong data-count="1.32">1.32</strong>
                <span>Profit factor</span>
              </div>
            </div>
            <div className="cw-result-note">
              <ShieldCheck size={20} />
              <p>
                Positive average. <strong>Not a proven edge.</strong> The 95%
                confidence interval is −2.9% to +6.3%, which includes zero.
                Results include modeled fees and slippage; live paper tracking
                continues.
              </p>
              <Link href="/performance" aria-label="See the full performance">
                <ArrowUpRight />
              </Link>
            </div>
          </div>
          <div className="cw-research-links">
            <Link href="/performance">
              <span className="cw-version">v005 · Portfolio view</span>
              <h3>A third of the drawdown.</h3>
              <p>
                −17% at worst, against −53% for holding Bitcoin. See the equity
                curve, the benchmarks and every trade.
              </p>
              <span>
                See the performance <ArrowUpRight size={17} />
              </span>
            </Link>
            <Link href="/docs/validation">
              <span className="cw-version">v001 — v004 / v007</span>
              <h3>Failed ideas stay visible.</h3>
              <p>
                Faster signals did not hold up. Keeping those results is part of
                the research.
              </p>
              <span>
                Understand the process <ArrowUpRight size={17} />
              </span>
            </Link>
          </div>
        </section>
        <section className="cw-section cw-docs-callout" data-reveal>
          <div className="cw-docs-symbol" aria-hidden="true">
            <MoveUpRight />
          </div>
          <div>
            <h2>Understand every signal.</h2>
            <p>
              From the first market filter to the final exit.
              <br />
              Clear documentation, without the black box.
            </p>
          </div>
          <Link className="cw-button" href="/docs">
            Open the docs <ArrowUpRight size={17} />
          </Link>
        </section>
        <section className="cw-section cw-faq" data-reveal>
          <h2>Before you dive in.</h2>
          <div>
            {questions.map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <span>+</span>
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
        <div className="cw-disclaimer">
          Research software. Signals are not financial advice. Past performance
          does not guarantee future results.
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
