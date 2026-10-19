import { JsonLd, pageMeta } from '@/lib/seo';
import { siteUrl } from '@/lib/site';
import { AskConsole } from '@/components/crosswake/ask-console';
import { ScrollEffects } from '@/components/crosswake/scroll-effects';
import { SiteFooter, SiteHeader } from '@/components/crosswake/site-shell';

export const metadata = pageMeta({
  title: 'Ask the record',
  description:
    'Ask our live record a question. An agent reads the running collector, every live strategy state, the signal log and the frozen rules, then answers in plain language. Paper research only.',
  path: '/ask',
});

export default function Page() {
  return (
    <div className="cw-site cw-ask-site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'WebPage',
          name: 'Ask the record',
          url: `${siteUrl}/ask`,
          description:
            'A read-only question and answer interface over the Crosswake live research record: collector health, strategy states, signals, market snapshot and the rules frozen before testing.',
          isAccessibleForFree: true,
          about: {
            '@type': 'Dataset',
            name: 'Crosswake live paper-trading record',
            description:
              'Live paper-trading state for the Crosswake strategies, including collector health, open positions, closed trades, published signals and frozen protocol hashes.',
          },
        }}
      />
      <SiteHeader />
      <main id="main">
        <AskConsole />
      </main>
      <ScrollEffects />
      <SiteFooter />
    </div>
  );
}
