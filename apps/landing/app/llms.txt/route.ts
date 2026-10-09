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

## Research record
- Seven strategy versions so far; five failed or were retired (v001–v004, v007). All remain public.

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
`;

export function GET() {
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
