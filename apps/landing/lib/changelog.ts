// Public changelog. Dates come from the research record and repository history; only shipped
// changes belong here. Newest first.
export type ChangeKind = 'strategy' | 'failed' | 'product' | 'transparency';
export const changelog: { date: string; kind: ChangeKind; title: string; body: string }[] = [
  {
    date: '2026-10-09',
    kind: 'transparency',
    title: 'Performance page and execution-delay test',
    body: 'Published v005’s portfolio view on unseen data: equity curve, drawdown, capital deployed, benchmarks against holding BTC and the altcoins, and every trade as a CSV. Every trade was also re-priced at fills 1 and 4 hours late; the result barely moved.',
  },
  {
    date: '2026-10-09',
    kind: 'product',
    title: 'Signal cards and four-hour market updates on Telegram',
    body: 'Signals now arrive as short cards with entry, exit discipline and reason. Market updates on ten major coins post after every four-hour close, with facts computed by software and checked before posting.',
  },
  {
    date: '2026-10-09',
    kind: 'failed',
    title: 'v007 failed its unseen test',
    body: 'Intraday momentum on BTC, ETH and SOL futures was negative on data it had not seen. It is kept on paper for observation only and sends no signals.',
  },
  {
    date: '2026-10-09',
    kind: 'strategy',
    title: 'v006 started live paper tracking',
    body: 'The v005 rules applied to a wider universe of 36 coins, including newer listings. Judged on its live record only, alongside v005.',
  },
  {
    date: '2026-10-08',
    kind: 'strategy',
    title: 'v005 frozen and tested on unseen data',
    body: '243 trades from January 2025 to September 2026: +1.5% average per trade after costs, but a confidence interval that includes zero. Recorded as inconclusive and moved to live paper tracking, with its record counted from 1 October 2026.',
  },
  {
    date: '2026-10-08',
    kind: 'failed',
    title: 'v004 failed',
    body: 'Shorting altcoins that held up while Bitcoin fell lost money after costs. Retired.',
  },
  {
    date: '2026-10-08',
    kind: 'failed',
    title: 'v003 failed',
    body: 'Hour-scale catch-up trades on lagging altcoins lost money or traded too rarely. Retired.',
  },
  {
    date: '2026-10-08',
    kind: 'failed',
    title: 'v002 retired',
    body: 'Delayed, cost-aware entries produced no tradable signals once real costs were counted.',
  },
  {
    date: '2026-10-05',
    kind: 'failed',
    title: 'v001 retired',
    body: 'Altcoins react to Bitcoin within seconds, far too fast for a person to act on. The research moved to slower timeframes.',
  },
];
