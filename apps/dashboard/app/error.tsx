'use client';
import { Brand } from '@/components/crosswake/brand';
import { Button } from '@/components/base-ui/button';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="route-state">
      <Brand />
      <p className="eyebrow">Workspace interrupted</p>
      <h1>Something needs another look.</h1>
      <p>
        The page could not finish loading. Try again to restore the workspace.
      </p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
