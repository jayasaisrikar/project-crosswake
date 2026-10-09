import { PerformanceView } from '@/components/crosswake/performance-view';
export const metadata = {
  title: 'Performance · Crosswake',
  description:
    'v005 portfolio results on unseen data: equity curve, drawdown, exposure and benchmarks, with every trade downloadable.',
};
export default function Page() {
  return <PerformanceView />;
}
