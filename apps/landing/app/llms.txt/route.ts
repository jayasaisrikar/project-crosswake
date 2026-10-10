import { siteUrl } from '@/lib/site';

export const dynamic = 'force-static';

const body = `
# Crosswake

> Crosswake publishes free, rules-based altcoin trend signals on Telegram and the full research record behind them: rules frozen before testing, results on unseen data after fees, a live paper record, and every failed strategy. All signals are paper signals; Crosswake does not place trades and nothing it publishes is financial advice.

## What Crosswake does
- Scans 36 major coins after every daily close (00:00 UTC).
- Trades only when Bitcoin's long-term trend is up; otherwise it stays in cash.
- Sends a signal when an altcoin breaks out of its recent range: the coin, the entry, and the exit discipline (a trailing exit; no fixed price targets).
- Trades are long-only spot, typically held days to weeks.
- Posts a short market update for 10 major coins every four hours.

## Key results (v005, frozen rules, unseen data Jan 2025 to Sep 2026)
- 243 trades, 33.7% win rate, +1.5% average net return per trade after 0.3% round-trip costs, profit factor 1.32.
- 95% confidence interval for the average trade: −2.9% to +6.3%. It includes zero, so the edge is unproven.
- Portfolio view (29 equal slots, no leverage): +12.8% total return, −16.9% maximum drawdown. Holding BTC over the same period: −11.6%, −53.0% drawdown.
- One coin (ZEC, up 24.7x) drives much of the result; without it v005 was roughly flat while holding the other coins lost about 46%.
- Re-pricing every trade 1 or 4 hours after the daily open barely changes the result.
- Live paper tracking started 1 October 2026 (v005) and 9 October 2026 (v006, 36 coins).
- First live signal: ATOM entry at 2.066 on 10 October 2026, open and about 6.7% below entry that day.

## Hyperliquid data
- Crosswake reads Hyperliquid's public API (no key, no payment) for perp prices, funding, open interest and order-book depth.
- Order-book depth and market impact are therefore measured in-house rather than bought, and are labelled as a cross-venue proxy because Hyperliquid's book is for perpetuals, not spot.
- Prices and funding are cross-checked against Binance daily closes.

## Research agent (simulation only)
- Crosswake works out which facts its own research is missing, checks whether a paid source is worth the money, and can buy one through x402.
- Purchases run against local fixtures in simulation. No real money has moved and no on-chain payment has been made.
- A language model may request a purchase; it cannot sign, pay, change a cap or approve its own request. Caps, allowlists and an emergency stop are enforced in code.
- Paid evidence never changes signal confidence on its own, and it is recorded separately from Crosswake's own measurements.

## Research record
- Seven strategy versions so far; five failed or were retired (v001–v004, v007). All remain public.
- Only v005 and v006 send signals. v003, v004 and v007 run on paper for observation and send nothing.
- v004 posted 10 short alerts to the channel between 8 and 10 October 2026 while listed as failed; this was disclosed in the changelog and its delivery was turned off.

## Pages
- [Home](${siteUrl}/): what Crosswake is and how signals work
- [Performance](${siteUrl}/performance): equity curve, drawdown, benchmarks, execution-delay test
- [All v005 test trades (CSV)](${siteUrl}/data/trend-daily-v005-test-trades.csv)
- [Signal log](${siteUrl}/log): every live signal in a hash-chained, verifiable log
- [Commitments](${siteUrl}/commitments): promises and how to check them
- [Changelog](${siteUrl}/changelog): every version and result, dated
- [Strategies](${siteUrl}/docs/strategies)
- [Reading a signal](${siteUrl}/docs/signals)
- [Validation standard](${siteUrl}/docs/validation)
- [Market updates](${siteUrl}/docs/market-updates)
- [Research agent](${siteUrl}/docs/research-agent)
`;

export function GET() {
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
