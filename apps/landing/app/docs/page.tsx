import { pageMeta } from '@/lib/seo';
import { DocsView } from '@/components/crosswake/docs-view';
export const metadata = pageMeta({
  title: 'Docs',
  description:
    'How Crosswake works: the daily trend strategy, how to read a signal, how strategies are validated, and the four-hour market updates.',
  path: '/docs',
});
export default function Page() {
  return <DocsView />;
}
