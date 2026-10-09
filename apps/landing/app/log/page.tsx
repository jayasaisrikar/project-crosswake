import { pageMeta } from '@/lib/seo';
import { SignalLogView } from '@/components/crosswake/signal-log-view';
export const metadata = pageMeta({
  title: 'Signal log',
  description:
    'Every Crosswake signal in a public, hash-chained log. Re-check every fingerprint in your browser.',
  path: '/log',
});
export default function Page() {
  return <SignalLogView />;
}
