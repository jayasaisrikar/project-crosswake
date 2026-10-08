import { Brand } from '@/components/crosswake/brand';
import { Skeleton } from '@/components/base-ui/skeleton';
export default function Loading() {
  return (
    <main className="route-state" role="status" aria-label="Loading Crosswake">
      <Brand />
      <p className="eyebrow">Opening the research</p>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-48 w-full" />
    </main>
  );
}
