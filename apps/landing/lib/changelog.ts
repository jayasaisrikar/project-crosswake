// Public changelog. Dates come from the research record and repository history; only shipped
// changes belong here. Newest first.
export type ChangeKind = 'strategy' | 'failed' | 'product' | 'transparency';
export const changelog: {
  date: string;
  kind: ChangeKind;
  title: string;
  body: string;
}[] = [
  {
    date: '2026-10-19',
    kind: 'product',
    title: 'Ask the record: an assistant over the live data',
    body: 'A floating assistant on every page, and a page of its own at /ask, lets anyone question the live record in plain language. It reads the same files the dashboard and the signal log are built from, as they are at the moment you ask: collector health, every live strategy state, published signals, the market snapshot, the rule hashes frozen before testing, and what we have posted publicly. It has no write path at all, so it cannot trade, edit a file or change a strategy. When a question is about our data it answers from what it read and lists it; it never invents a Crosswake figure, date or position. Anything else it answers from general knowledge, without pretending the record shows it. It is rate limited, and it reports paper results as paper.',
  },
  {
    date: '2026-10-17',
    kind: 'strategy',
    title: 'v008 frozen: a slower, hedged momentum book on futures',
    body: 'Half the book follows each coin’s own trend over 20, 60 and 120 days, long or short. The other half buys the strongest third of 37 futures over the last month and shorts the weakest third, rebalanced weekly. These rules were already studied on all past data elsewhere, so no clean backtest is left: v008 is judged on its live paper record only, from 18 October 2026. The bar is set now: after 90 days, a Sharpe above 0.5, both halves positive, a drawdown under 25%, and better risk-adjusted returns than holding the same coins. It sends no signals yet.',
  },
  {
    date: '2026-10-10',
    kind: 'failed',
    title: 'v004 posted short alerts while listed as failed. Now silenced.',
    body: 'Between 8 and 10 October the channel received 10 short alerts from v004, a strategy this record already lists as failed. That should not have happened. Its live paper result agrees with the test: 8 closed trades, 2 winners, −0.84% average per trade after costs. v003 and v004 now run on paper for observation only and send nothing, the same as v007.',
  },
  {
    date: '2026-10-10',
    kind: 'strategy',
    title: 'First live signal: ATOM',
    body: 'v005 and v006 sent their first live paper signal, an ATOM entry at 2.066 after the 10 October daily close. It was about 6.7% under water later that day. That is ordinary for this strategy: in testing roughly two trades in three lost, and the winners paid for them. The trade stays open until the frozen exit rule closes it, and the result will be published either way.',
  },
  {
    date: '2026-10-10',
    kind: 'product',
    title: 'Hyperliquid order-book depth, and the research agent behind it',
    body: 'Research now reads Hyperliquid’s public order book, so depth and market impact are measured in-house instead of listed as facts we lack. That is a cross-venue proxy for spot liquidity, and it is recorded as one. The buying side of the same pipeline, which decides whether a missing fact is worth paying for, is documented and runs in simulation only: no real money has moved and no on-chain payment has been made.',
  },
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
    body: 'Shorting altcoins that held up while Bitcoin fell lost money after costs. Failed.',
  },
  {
    date: '2026-10-08',
    kind: 'failed',
    title: 'v003 failed',
    body: 'Hour-scale catch-up trades on lagging altcoins lost money or traded too rarely. Failed.',
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
