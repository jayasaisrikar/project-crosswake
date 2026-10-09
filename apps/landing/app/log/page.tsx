import { SignalLogView } from '@/components/crosswake/signal-log-view';
export const metadata = {
  title: 'Signal log · Crosswake',
  description:
    'Every Crosswake signal in a public, hash-chained log you can verify yourself.',
};
export default function Page() {
  return <SignalLogView />;
}
