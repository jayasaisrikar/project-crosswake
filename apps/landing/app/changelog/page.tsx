import { SimplePage } from '@/components/crosswake/simple-page';
import { changelog, type ChangeKind } from '@/lib/changelog';

export const metadata = {
  title: 'Changelog · Crosswake',
  description: 'Every strategy version, result and product change, dated, including the failures.',
};

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
