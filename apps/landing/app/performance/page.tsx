import { JsonLd, organization, pageMeta } from '@/lib/seo';
import { siteUrl } from '@/lib/site';
import { PerformanceView } from '@/components/crosswake/performance-view';
export const metadata = pageMeta({
  title: 'Performance',
  description:
    'v005 on unseen data: +12.8% with a −16.9% maximum drawdown; holding the same coins made +40.5% with a −54.2% drawdown. Without ZEC, v005 is about flat. All 243 trades.',
  path: '/performance',
});
export default function Page() {
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'Dataset',
          name: 'Crosswake v005 daily trend strategy: unseen-data test trades',
          description:
            'All 243 trades from the frozen v005 rules on January 2025 to September 2026 Binance spot data, with entry, exit and net return after 0.3% round-trip costs.',
          url: `${siteUrl}/performance`,
          creator: organization,
          temporalCoverage: '2025-01-01/2026-10-01',
          isAccessibleForFree: true,
          variableMeasured: ['entry price', 'exit price', 'net return after costs', 'exit reason'],
          distribution: [
            { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: `${siteUrl}/data/trend-daily-v005-test-trades.csv` },
            { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${siteUrl}/data/trend-daily-v005-performance.json` },
          ],
        }}
      />
      <PerformanceView />
    </>
  );
}
