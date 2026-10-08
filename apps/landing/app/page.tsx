'use client';
import { MotionConfig } from 'motion/react';
import {
  ArrowUpRight,
  ArrowRight,
  Radio,
  Clock3,
  ScanLine,
  FileCheck2,
} from 'lucide-react';
import { Brand } from '@/components/crosswake/brand';
import { Button } from '@/components/ui/button';
import { MinimalCard } from '@/components/ui/minimal-card';
import { RollingNumber } from '@/components/ui/rolling-number';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
const REPO = 'https://github.com/jayasaisrikar/project-crosswake';
const workspace =
  process.env.NEXT_PUBLIC_WORKSPACE_URL || 'http://127.0.0.1:3000';
const steps = [
  {
    icon: Radio,
    title: 'Observe the move.',
    body: 'Collect Bitcoin and altcoin trades with their own timestamps. Gaps and stale quotes remain visible in the record.',
    detail: 'Market data → timestamped journals',
  },
  {
    icon: ScanLine,
    title: 'Measure what follows.',
    body: 'Test whether a Bitcoin impulse leaves a tradable response in another asset. Relationships are fitted on prior data, with costs and entry delay included.',
    detail: 'Prior evidence → candidate or rejection',
  },
  {
    icon: FileCheck2,
    title: 'Make the evidence earn trust.',
    body: 'Freeze the protocol. Evaluate chronologically, reserve unseen data, and reconcile forward paper outcomes before drawing conclusions.',
    detail: 'Frozen protocol → reproducible result',
  },
];
const faq = [
  [
    'Does correlation mean a trade will work?',
    'No. Correlation describes co-movement. A useful signal also needs a repeatable lead–lag relationship, enough remaining response after entry delay, and positive outcomes after costs.',
  ],
  [
    'Is this a live trading service?',
    'Crosswake is a research and paper-validation workspace. Execution is disabled. Candidate scores are research measurements, not calibrated probabilities or promises of profit.',
  ],
  [
    'What can I inspect?',
    'The workspace exposes collection health, accepted and rejected candidates, frozen protocols, experiment results, and external context provenance. Raw records remain available for inspection.',
  ],
  [
    'What does a useful win rate look like?',
    'Win rate alone is incomplete. A 30–50% win rate can still lose money if losses and trading costs outweigh wins. Research must evaluate net expectancy, drawdown, sample size, and performance on unseen data together.',
  ],
];
export default function Page() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="site">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-nav">
          <Brand />
          <nav aria-label="Main navigation">
            <a href="#method">Method</a>
            <a href="#evidence">Evidence</a>
            <a href="#questions">Questions</a>
          </nav>
          <Button asChild>
            <a href={workspace}>
              Open workspace <ArrowUpRight size={15} />
            </a>
          </Button>
        </header>
        <main id="main">
          <section className="site-hero">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="status-dot" /> Independent market research
              </p>
              <h1>
                Bitcoin moves.
                <br />
                <span>What follows?</span>
              </h1>
              <p className="hero-description">
                A research desk for the space between a Bitcoin move and an
                altcoin response. Measure the delay. Inspect the evidence. Let
                the results decide.
              </p>
              <div className="hero-actions">
                <Button asChild>
                  <a href={workspace}>
                    Explore the research <ArrowRight size={16} />
                  </a>
                </Button>
                <a
                  className="text-link"
                  href={REPO}
                  target="_blank"
                  rel="noreferrer"
                >
                  View the project <ArrowUpRight size={15} />
                </a>
              </div>
              <p className="hero-note">
                Paper research only. Execution disabled.
              </p>
            </div>
            <MinimalCard className="transmission">
              <div className="diagram-top">
                <span className="eyebrow">The transmission hypothesis</span>
                <span className="diagram-tag">Illustrative</span>
              </div>
              <div className="diagram-source">
                <span className="coin-symbol">₿</span>
                <div>
                  <small>LEADING ASSET</small>
                  <h2>Bitcoin impulse</h2>
                </div>
                <Radio size={22} />
              </div>
              <svg
                className="transmission-wave"
                viewBox="0 0 420 130"
                role="img"
                aria-label="Illustration of a Bitcoin impulse followed by a delayed altcoin response"
              >
                <path
                  className="wave-grid"
                  d="M0 30H420 M0 65H420 M0 100H420"
                />
                <path
                  className="wave-btc"
                  d="M0 100L65 100L82 82L100 88L120 28L145 44L175 32L205 38L240 30L280 39L320 32L365 38L420 30"
                />
                <path
                  className="wave-alt"
                  d="M0 110L160 110L180 106L200 110L225 72L245 80L270 52L300 65L340 53L380 61L420 55"
                />
                <path className="wave-delay" d="M120 15V120 M225 15V120" />
              </svg>
              <div className="diagram-legend">
                <span>
                  <i /> Bitcoin
                </span>
                <span>
                  <i /> Altcoin
                </span>
                <span>
                  <Clock3 size={13} /> Entry delay matters
                </span>
              </div>
              <div className="diagram-bottom">
                <span>Observe</span>
                <ArrowRight size={14} />
                <span>Wait</span>
                <ArrowRight size={14} />
                <span>Evaluate</span>
              </div>
              <p>
                A delayed response is a hypothesis to test—not evidence of an
                available trade.
              </p>
            </MinimalCard>
          </section>
          <div className="research-strip">
            <div>
              <RollingNumber value={1} />
              <span>second research buckets</span>
            </div>
            <div>
              <span className="strip-value">Prior-only</span>
              <span>relationship fitting</span>
            </div>
            <div>
              <span className="strip-value">Paper</span>
              <span>validation before execution</span>
            </div>
          </div>
          <section id="method" className="method-section">
            <div className="section-intro">
              <p className="eyebrow">01 / Method</p>
              <h2>
                Follow the evidence,
                <br />
                one step at a time.
              </h2>
              <p>
                A market relationship deserves more than a correlation chart.
                Every stage leaves an inspectable record.
              </p>
            </div>
            <div className="method-list">
              {steps.map((s, i) => (
                <article key={s.title}>
                  <span className="method-number">0{i + 1}</span>
                  <div>
                    <s.icon size={22} />
                    <h3>{s.title}</h3>
                    <p>{s.body}</p>
                    <small>{s.detail}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section id="evidence" className="evidence-section">
            <div>
              <p className="eyebrow">02 / Evidence</p>
              <h2>
                The hypothesis
                <br />
                is open.
              </h2>
              <p>
                Crosswake separates what was observed from what has been
                validated. A candidate is a question. An experiment is a test.
                Neither is a guarantee.
              </p>
              <a className="text-link" href={workspace}>
                Inspect the workspace <ArrowUpRight size={16} />
              </a>
            </div>
            <div className="evidence-index">
              {[
                [
                  '01',
                  'Collection health',
                  'Check freshness, gaps, and the instruments being observed.',
                ],
                [
                  '02',
                  'Decision records',
                  'See why candidates were accepted or rejected.',
                ],
                [
                  '03',
                  'Frozen experiments',
                  'Read the protocol, net results, and validation gate.',
                ],
                [
                  '04',
                  'Context provenance',
                  'Keep external research separate from signal evidence.',
                ],
              ].map(([n, t, b]) => (
                <a href={workspace} key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{t}</h3>
                    <p>{b}</p>
                  </div>
                  <ArrowUpRight size={19} />
                </a>
              ))}
            </div>
          </section>
          <section id="questions" className="questions-section">
            <div className="section-intro">
              <p className="eyebrow">03 / Questions</p>
              <h2>
                A few things
                <br />
                worth being clear on.
              </h2>
            </div>
            <Accordion type="single" collapsible className="faq-list">
              {faq.map(([q, a], i) => (
                <AccordionItem value={String(i)} key={q}>
                  <AccordionTrigger>{q}</AccordionTrigger>
                  <AccordionContent>{a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </section>
        </main>
        <footer className="site-footer">
          <div className="footer-statement">
            <p className="eyebrow">Observe. Test. Reconcile.</p>
            <h2>
              Better questions.
              <br />
              Clearer evidence.
            </h2>
            <a href={REPO} target="_blank" rel="noreferrer">
              Explore the source <ArrowUpRight size={20} />
            </a>
          </div>
          <div className="footer-bottom">
            <Brand />
            <p>BTC-to-altcoin transmission research.</p>
            <a href="#main">Back to top ↑</a>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
