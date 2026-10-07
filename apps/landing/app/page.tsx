'use client';

import { motion } from 'motion/react';
import {
  ArrowUpRight,
  Database,
  FlaskConical,
  GitBranch,
  ShieldX,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import Hero1 from '@/components/ui/hero-1';
import { Faq1 } from '@/components/ui/faq-1';
import { Cta1 } from '@/components/ui/cta-1';
import { Footer1 } from '@/components/ui/footer-1';

const REPO = 'https://github.com/jayasaisrikar/project-crosswake';

const EVIDENCE_STATS = [
  {
    value: '777,600',
    label: 'Snapshots analyzed',
    note: 'Three days of second-scale history, replayed tick by tick.',
  },
  {
    value: '1s',
    label: 'Research buckets',
    note: 'Raw journals normalize into one-second Parquet with checksums.',
  },
  {
    value: '3',
    label: 'Seed universe',
    note: 'BTC, ETH, SOL on Binance Spot. Expansion needs its own capacity proof.',
  },
  {
    value: '0',
    label: 'Orders executed',
    note: 'By design. Long-only paper validation; execution is disabled.',
  },
];

const METHOD_STEPS = [
  {
    n: '01',
    icon: Database,
    title: 'Collect everything',
    body: 'Live Binance Spot trades and BBO stream into append-only journals, then into checksummed one-second Parquet. Disconnects stay visible as gaps — never forward-filled.',
  },
  {
    n: '02',
    icon: GitBranch,
    title: 'Detect transmission',
    body: 'BTC impulses are measured against prior-only fitted relationships. Every candidate carries its feature provenance, and every rejection carries its reason.',
  },
  {
    n: '03',
    icon: FlaskConical,
    title: 'Validate chronologically',
    body: 'Frozen protocols, walk-forward selection on unseen blocks, a one-use holdout, then forward-paper reconciliation. Dates alone never count as evidence.',
  },
];

const FAQS = [
  {
    id: 'what',
    question: 'Is Crosswake a trading bot?',
    answer:
      'No. It is a research system that measures whether Bitcoin moves propagate into altcoins with a tradeable lag. There is no order execution, and passing a research gate never authorizes orders.',
  },
  {
    id: 'edge',
    question: 'Has it found an edge?',
    answer:
      'Not yet. Across live observation and 777,600 replayed historical snapshots, the engine has produced zero qualifying candidates. Empty samples report null metrics — never a fabricated estimate.',
  },
  {
    id: 'data',
    question: 'What data does it use?',
    answer:
      'Public Binance Spot trade and book-ticker streams plus Binance public trade archives, with timestamped altFINS screener snapshots as supplementary context. No premium tick feed is assumed.',
  },
  {
    id: 'live',
    question: 'Can I run it myself?',
    answer:
      'Yes. The code is public: pnpm install, pnpm typecheck, pnpm test. Public collection needs no API key. The laptop must stay awake during collection and disk usage must be monitored.',
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Hero1
        brand="crosswake"
        navLinks={[
          { label: 'Method', href: '#method', active: true },
          { label: 'Evidence', href: '#evidence' },
          { label: 'FAQ', href: '#faq' },
        ]}
        headline={
          <>
            When Bitcoin moves,
            <br />
            who follows?
          </>
        }
        ctaLabel="See the evidence"
        ctaHref="#evidence"
        description="A local-first research system measuring BTC-to-altcoin transmission on Binance Spot. Long-only paper validation. Execution disabled."
        socialLinks={[{ label: 'GitHub', href: REPO }]}
        signInLabel="Star on GitHub"
        signInHref={REPO}
      />

      <section
        id="evidence"
        className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 md:px-8"
      >
        <p className="font-mono text-[11px] tracking-[0.2em] text-primary uppercase">
          Evidence so far
        </p>
        <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight md:text-5xl">
          Numbers first. Narratives never.
        </h2>
        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {EVIDENCE_STATS.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
            >
              <Card className="h-full">
                <CardContent className="flex h-full flex-col p-6">
                  <span className="font-display text-5xl font-semibold tracking-tighter tabular-nums">
                    {s.value}
                  </span>
                  <span className="mt-3 text-sm font-semibold">{s.label}</span>
                  <span className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {s.note}
                  </span>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section
        id="method"
        className="scroll-mt-20 border-y border-border bg-card/40"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-20 md:px-8">
          <p className="font-mono text-[11px] tracking-[0.2em] text-primary uppercase">
            How it works
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight md:text-5xl">
            A pipeline with no place to hide.
          </h2>
          <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
            {METHOD_STEPS.map((s, i) => (
              <motion.div
                key={s.n}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
              >
                <Card className="h-full">
                  <CardContent className="flex h-full flex-col gap-4 p-6">
                    <div className="flex items-center justify-between">
                      <s.icon className="size-6 text-primary" aria-hidden />
                      <span className="font-mono text-xs text-muted-foreground">
                        {s.n}
                      </span>
                    </div>
                    <h3 className="font-display text-xl font-semibold tracking-tight">
                      {s.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {s.body}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <div id="faq" className="scroll-mt-20">
        <Faq1
          badge="Honest answers"
          title="Asked before you ask."
          faqs={FAQS}
        />
      </div>

      <div className="mx-auto flex w-full max-w-6xl justify-center px-4 md:px-8">
        <Cta1
          title="Evidence first. Execution disabled."
          description="The full pipeline, tests, and frozen protocols are public. Inspect every decision or run it yourself."
          buttonText="Open the repo"
          buttonLink={REPO}
          buttonIcon={<ArrowUpRight className="size-4" aria-hidden />}
        />
      </div>

      <div className="mt-8 flex items-center justify-center gap-2 pb-4 text-xs text-muted-foreground">
        <ShieldX className="size-4" aria-hidden />
        Not financial advice. No live trading. No profitability claim.
      </div>

      <Footer1
        logo={<ArrowUpRight className="size-5" aria-hidden />}
        brandName="crosswake"
        newsletterTitle="Follow the evidence"
        newsletterDescription="The repo is public. Star it to follow frozen-protocol results as October data accumulates."
        newsletterPlaceholder="you@example.com"
        newsletterButtonText="Star on GitHub"
        linkGroups={[
          {
            title: 'Research',
            links: [
              { label: 'Method', href: '#method' },
              { label: 'Evidence', href: '#evidence' },
              { label: 'FAQ', href: '#faq' },
            ],
          },
          {
            title: 'Code',
            links: [
              { label: 'Repository', href: REPO },
              {
                label: 'Implementation plan',
                href: `${REPO}/blob/main/docs/implementation-plan.md`,
              },
              { label: 'Status', href: `${REPO}/blob/main/docs/status.md` },
            ],
          },
        ]}
        copyright="© 2026 Crosswake. Local research software. Evidence first, execution disabled."
      />
    </div>
  );
}
