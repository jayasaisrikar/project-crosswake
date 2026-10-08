import { Brand } from '@/components/crosswake/brand';
import { Button } from '@/components/base-ui/button';
export default function NotFound() {
  return (
    <main className="route-state">
      <Brand />
      <p className="eyebrow">404 / Page unavailable</p>
      <h1>This page is outside the record.</h1>
      <p>Return home to continue exploring Crosswake.</p>
      <Button asChild>
        <a href="/">Return home</a>
      </Button>
    </main>
  );
}
