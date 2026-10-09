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
  ['30', 'coins watched'],
  ['0', 'hidden failures'],
  ['PAPER', 'tracked live'],
];
export default function Page() {
  return (
    <div className="cw-site cw-landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <ScrollEffects />
      <main id="main">
        <section className="cw-hero kinetic-hero">
          <HeroParallax>
            <div className="kinetic-hero-copy">
              <div className="hero-edition hero-rise">
                <span className="cw-status-dot" /> ALTCOIN TREND SIGNALS · TELEGRAM
                + DASHBOARD
              </div>
              <h1 className="hero-rise">
                Ride the
                <br />
                trend<span className="hero-period">.</span>
              </h1>
              <div className="hero-subline hero-rise">
                <span className="hero-line" />
                <span>Signals with the receipts.</span>
              </div>
              <p className="hero-rise">
                Crosswake tells you which altcoin to buy, when to enter and
                when to exit, only while Bitcoin is in an uptrend. Every rule
                is public, every result includes fees, and every signal is
                tracked live on paper.
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
                  <strong>30</strong> coins watched
                </li>
                <li>
                  <strong>Days–weeks</strong> per trade
                </li>
                <li>
                  <strong>Fees</strong> in every result
                </li>
              </ul>
            </div>
            <MarketScene />
          </HeroParallax>
          <div className="kinetic-hero-bottom">
            <span>MARKETS MOVE. EVIDENCE COMPOUNDS.</span>
            <a href="#product-preview">
              <span className="scroll-cue" /> Scroll to explore
            </a>
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
                role="img"
                aria-label="Illustrative breakout above a prior high, followed by a trend and exit"
              >
                <path
                  className="cw-chart-grid"
                  d="M0 60H620M0 120H620M0 180H620M0 240H620M80 0V265M200 0V265M320 0V265M440 0V265M560 0V265"
                />
                <path className="cw-chart-threshold" d="M0 170H620" />
                <path
                  className="cw-chart-line"
                  d="M0 226L24 220L45 236L70 208L92 218L118 187L140 202L162 179L186 191L210 146L235 157L260 119L282 131L305 88L331 107L355 70L380 80L404 44L429 62L452 36L477 67L500 52L525 91L551 82L575 123L598 111L620 145"
                />
                <circle cx="210" cy="146" r="6" className="cw-chart-point" />
                <circle cx="575" cy="123" r="6" className="cw-chart-point" />
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
              <Link
                href="/docs/validation"
                aria-label="Read validation methodology"
              >
                <ArrowUpRight />
              </Link>
            </div>
          </div>
          <div className="cw-research-links">
            <Link href="/docs/strategies">
              <span className="cw-version">v005 / v006</span>
              <h3>Tracking the daily trend.</h3>
              <p>
                The original strategy and a wider coin universe, each with its
                own paper record.
              </p>
              <span>
                Explore strategies <ArrowUpRight size={17} />
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
