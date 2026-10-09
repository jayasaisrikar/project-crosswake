import { pageMeta } from '@/lib/seo';
import { SimplePage } from '@/components/crosswake/simple-page';
import { changelog, type ChangeKind } from '@/lib/changelog';

export const metadata = pageMeta({
  title: 'Changelog',
  description:
    'Every Crosswake strategy version, result and product change, dated. Five of seven strategies so far failed, and all stay on the record.',
  path: '/changelog',
});

const label: Record<ChangeKind, string> = {
  strategy: 'Strategy',
  failed: 'Failed',
  product: 'Product',
  transparency: 'Transparency',
};
const date = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default function Page() {
  return (
    <SimplePage
      eyebrow="Public record"
      title="Changelog."
      jsonLd={{
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Crosswake changelog',
        itemListOrder: 'https://schema.org/ItemListOrderDescending',
        itemListElement: changelog.map((c, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: { '@type': 'CreativeWork', name: c.title, description: c.body, datePublished: c.date },
        })),
      }}
      lead="Every strategy version, every result and every product change, dated. Failures included."
    >
      <ol className="cl-list">
        {changelog.map((c) => (
          <li key={c.date + c.title}>
            <time dateTime={c.date}>{date(c.date)}</time>
            <div>
              <span className={`cl-kind is-${c.kind}`}>{label[c.kind]}</span>
              <h2>{c.title}</h2>
              <p>{c.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </SimplePage>
  );
}
