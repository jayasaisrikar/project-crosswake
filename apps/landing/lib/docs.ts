export type DocSection = {
  id: string;
  title: string;
  paragraphs: string[];
  items?: string[];
};
export const docs: {
  slug: string;
  title: string;
  description: string;
  sections: DocSection[];
}[] = [
  {
    slug: '',
    title: 'Meet Crosswake.',
    description:
      'A clear starting point for the signals, the strategies, and the evidence behind them.',
    sections: [
      {
        id: 'overview',
        title: 'Research before conviction',
        paragraphs: [
          'Crosswake studies crypto market trends and turns explicit strategy rules into paper signals. The main strategy looks for altcoin breakouts while Bitcoin is in an uptrend. Each signal has an entry rule and an exit rule.',
          'All current strategies run in paper mode: positions are recorded and evaluated, but no real orders are placed.',
        ],
      },
      {
        id: 'start',
        title: 'Where to start',
        paragraphs: [
          'Start with the daily trend rules, then learn how to read a signal and judge the research behind it.',
        ],
        items: [
          'Strategies: compare the main daily trend strategy, its wider universe, and retired research.',
          'Reading signals: understand entries, exits, and the difference between a signal and market context.',
          'Validation: see why a positive average does not automatically prove an edge.',
          'Market updates: understand the four-hour summaries and their boundaries.',
        ],
      },
      {
        id: 'status',
        title: 'Current stage',
        paragraphs: [
          'The signal dashboard, paper tracking, Telegram paper alerts, and four-hour market summaries are running. v005 began live paper tracking on 1 October 2026; v006 began on 9 October 2026.',
          'Research results are not a promise of future performance. The main strategy’s unseen-data confidence interval includes zero, so its edge remains unproven.',
        ],
      },
    ],
  },
  {
    slug: 'strategies',
    title: 'Every strategy. On record.',
    description:
      'The rules, the differences, and the outcomes—including the ideas that did not work.',
    sections: [
      {
        id: 'daily-trend',
        title: 'v005 · Daily trend breakout',
        paragraphs: [
          'The main strategy follows daily trends, with positions typically lasting days to weeks. It is long-only, uses equal position sizes, and holds at most one position per coin.',
        ],
        items: [
          'Market filter: Bitcoin’s daily close must be above its 100-day average.',
          'Entry: the coin closes above its highest close of the prior 20 days.',
          'Exit: the daily close falls below its prior 10-day low, or the Bitcoin filter turns off.',
          'Fill assumption: the next day’s open, after the daily close at 00:00 UTC.',
          'Modeled costs: 30 basis points (0.30%) per round trip.',
        ],
      },
      {
        id: 'results',
        title: 'What the test showed',
        paragraphs: [
          'The January 2025–September 2026 unseen-data test produced 243 trades, a 33.7% win rate, +1.5% average net return per trade, and a 1.32 profit factor. Average winners were about +19%; average losers about −7.3%.',
          'The 95% confidence interval for average return was −2.9% to +6.3%. It includes zero. There were only 33 independent entry-weeks, and development results leaned heavily on the 2020–2021 bull market. The result is inconclusive, not proof of a durable edge.',
        ],
      },
      {
        id: 'wider-universe',
        title: 'v006 · A wider coin universe',
        paragraphs: [
          'v006 applies the same daily rules to 36 coins, including newer listings such as HYPE, SUI, ENA, and TAO. It runs alongside v005 rather than replacing it.',
          'Many newer coins lack enough history for a meaningful backtest. This version is evaluated on live paper results from 9 October 2026. A coin requires 20 daily closes before it can become tradable.',
        ],
      },
      {
        id: 'failed-research',
        title: 'Retired and failed research',
        paragraphs: [
          'Failed strategies remain part of the record. They are not quietly retuned and presented as fresh successes.',
        ],
        items: [
          'v001: seconds-scale Bitcoin lead–lag. Responses were too fast for a person to act. Retired.',
          'v002: delayed entries and cost-aware forecasts. No tradable signals. Retired.',
          'v003: hour-scale altcoin catch-up. Variants lost money or produced insufficient trades. Failed.',
          'v004: shorting altcoins that held up while Bitcoin fell. −0.46% per trade across 349 trades. Failed.',
          'v007: 15-minute RSI rebounds in a four-hour trend on BTC, ETH, and SOL futures. The unseen test had 32 trades, −0.15R per trade, and a 0.79 profit factor. Failed; paper observation only.',
        ],
      },
    ],
  },
  {
    slug: 'signals',
    title: 'Read a signal clearly.',
    description:
      'Know what a paper signal means before interpreting its outcome.',
    sections: [
      {
        id: 'signal',
        title: 'A rule-triggered event',
        paragraphs: [
          'A signal records that a strategy’s entry or exit conditions have been met. It is not a prediction or a calibrated probability of success. For the main daily strategy, the decision uses a completed daily candle.',
          'The test assumes a fill at the next day’s open. A price seen later in an alert or dashboard is not a guarantee of that fill.',
        ],
      },
      {
        id: 'lifecycle',
        title: 'From entry to exit',
        paragraphs: [
          'Read the strategy version and coin first, then the entry condition and current paper position. The exit is determined by the frozen rules, not by a discretionary price target.',
        ],
        items: [
          'Entry: a qualifying daily breakout while the Bitcoin market filter is on.',
          'Open position: paper exposure remains until an exit condition occurs.',
          'Exit: the trailing 10-day condition or the Bitcoin filter turns off.',
          'Outcome: evaluate the closed trade after modeled trading costs.',
        ],
      },
      {
        id: 'interpretation',
        title: 'One trade is not the strategy',
        paragraphs: [
          'Trend following can lose on most trades and still have a positive average if its winners are sufficiently larger than its losers. A win rate alone does not tell you whether a strategy is useful.',
          'Compare net return, drawdown, sample size, and uncertainty across the full record. Paper fills cannot reproduce every live liquidity or execution condition.',
        ],
      },
    ],
  },
  {
    slug: 'validation',
    title: 'Evidence has a standard.',
    description:
      'How Crosswake separates an interesting result from a reliable conclusion.',
    sections: [
      {
        id: 'freeze',
        title: 'Freeze the rules first',
        paragraphs: [
          'Each version has a written hypothesis, fixed rules, and pass/fail criteria before test data is fetched. Changing a rule creates a new version rather than rewriting the old result.',
        ],
      },
      {
        id: 'unseen',
        title: 'Test on unseen data',
        paragraphs: [
          'Development uses an earlier period. Evaluation uses a later period the strategy has not seen. Chronological separation matters because market information available in the future must not influence an earlier decision.',
          'The main daily strategy developed on 2020–2024 and tested on January 2025–September 2026. These periods are historical research, not live returns.',
        ],
      },
      {
        id: 'costs',
        title: 'Count the friction',
        paragraphs: [
          'Results include modeled fees and slippage. The daily trend model uses 30 basis points per round trip. The futures research also considers funding.',
          'Actual execution can differ. A modeled cost assumption is not a promise of an attainable fill.',
        ],
      },
      {
        id: 'uncertainty',
        title: 'Report uncertainty, not just averages',
        paragraphs: [
          'A positive mean is only one part of the result. Crosswake considers sample size, profit factor, and a 95% confidence interval. The validation standard requires positive expectancy with a confidence interval above zero.',
          'v005 has a positive test average, but its confidence interval crosses zero. It has not established a proven edge. v007 failed its test and runs only for observation.',
        ],
      },
      {
        id: 'paper',
        title: 'Continue with live paper evidence',
        paragraphs: [
          'Paper tracking records new signals as market data arrives. It helps compare forward behavior with the frozen research, without placing real orders.',
          'Past performance does not guarantee future results. Paper evidence must be judged over enough independent observations, not a handful of winning trades.',
        ],
      },
    ],
  },
  {
    slug: 'market-updates',
    title: 'Context between signals.',
    description:
      'Four-hour market summaries, kept separate from strategy decisions.',
    sections: [
      {
        id: 'schedule',
        title: 'When updates arrive',
        paragraphs: [
          'Telegram market summaries are scheduled about five minutes after each four-hour candle closes: 00:05, 04:05, 08:05, 12:05, 16:05, and 20:05 UTC.',
        ],
      },
      {
        id: 'coverage',
        title: 'What they cover',
        paragraphs: [
          'Updates cover BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, and HYPE. They summarize price, four-hour RSI and MACD momentum from altFINS, market breadth, and current strategy paper positions.',
        ],
      },
      {
        id: 'generation',
        title: 'Facts first, language second',
        paragraphs: [
          'Software computes the facts. An AI model turns those facts into a readable summary. Drafts with unsupported numbers, price predictions, trade calls, or a missing disclaimer are rejected in favor of a factual fallback.',
        ],
      },
      {
        id: 'boundaries',
        title: 'Context is not a trade call',
        paragraphs: [
          'A market summary describes observed conditions. It does not create or override a strategy signal. Trade signals come only from the strategy rules.',
        ],
      },
    ],
  },
];
