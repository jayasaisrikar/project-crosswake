'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  BellRing,
  Microscope,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/base-ui/button';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/base-ui/alert';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/base-ui/alert-dialog';
import { CodeBlock } from '@/components/base-ui/code-block';
import { cn } from '@/lib/utils';
import { StrategyLab, TradeSignals } from '../residual-views';
import { TrendBoard } from '../trend-views';

type Dict = Record<string, any>;
const VIEWS = [
  { id: 'daily', label: 'Daily signals', icon: TrendingUp },
  { id: 'signals', label: 'Intraday (v003)', icon: BellRing },
  { id: 'lab', label: 'Strategy lab', icon: Microscope },
] as const;
async function read(path: string) {
  const r = await fetch(`/api/evidence/${path}`, { cache: 'no-store' });
  if (!r.ok)
    throw new Error(
      r.status === 503
        ? 'The evidence service is offline. Start it with pnpm research:api or pnpm services:install.'
        : 'This evidence is incomplete or failed its integrity check.',
    );
  return r.json();
}

export default function SignalsPage() {
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('daily'),
    [signals, setSignals] = useState<Dict | null>(null),
    [research, setResearch] = useState<Dict | null>(null),
    [trend, setTrend] = useState<Dict | null>(null),
    [detail, setDetail] = useState<unknown>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refreshed, setRefreshed] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, t] = await Promise.all([
        read('signals'),
        read('research'),
        read('trend').catch(() => null),
      ]);
      setTrend(t);
      setSignals(s);
      setResearch(r);
      setError('');
      setRefreshed(Date.now());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:px-10">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/" aria-label="Back to the research workbench">
              <ArrowLeft aria-hidden /> Workbench
            </Link>
          </Button>
          <nav
            aria-label="Signal views"
            className="flex min-w-0 gap-1 overflow-x-auto"
          >
            {VIEWS.map((v) => {
              const Icon = v.icon;
              return (
                <button
                  key={v.id}
                  aria-current={view === v.id ? 'page' : undefined}
                  onClick={() => setView(v.id)}
                  className={cn(
                    'flex min-h-10 items-center gap-2 rounded-md px-3 text-sm',
                    view === v.id
                      ? 'bg-card text-primary shadow-[inset_0_-2px_var(--primary)]'
                      : 'text-muted-foreground hover:bg-card',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {v.label}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="hidden sm:inline">
            Updated{' '}
            {refreshed
              ? new Date(refreshed).toLocaleTimeString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                })
              : '—'}{' '}
            IST
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw
              className={cn('size-3.5', loading && 'animate-spin')}
              aria-hidden
            />
            Refresh
          </Button>
        </div>
      </header>
      <main
        id="main"
        className="mx-auto max-w-6xl min-w-0 px-4 py-8 lg:px-10 lg:py-12"
      >
        <div className="mb-8 max-w-2xl">
          <p className="mb-2 font-mono text-[10px] tracking-[0.07em] text-muted-foreground uppercase">
            {view === 'daily'
              ? 'Daily trend breakout · v005 · paper only'
              : view === 'signals'
                ? 'BTC-relative signals · paper only'
                : 'Out-of-sample evidence'}
          </p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            {view === 'daily'
              ? 'Strong coins, only in a BTC uptrend.'
              : view === 'signals'
                ? 'Every signal, as it fires.'
                : 'What actually held up.'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {view === 'daily'
              ? 'Buy a coin that closes at a 20-day high while Bitcoin is above its 100-day average; sell when it closes at a 10-day low. Checked once a day after the 00:00 UTC close.'
              : view === 'signals'
                ? 'Signals from the live engines with simulated outcomes. Telegram delivery is a future option; this feed is the channel today.'
                : 'Walk-forward results on unseen periods, the filter-free edge study and measured order-book costs.'}
          </p>
        </div>
        {error && (
          <Alert variant="destructive" className="mb-6" role="alert">
            <AlertTitle>Signals could not be refreshed.</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {view === 'daily' ? (
          <TrendBoard data={trend} onInspect={setDetail} />
        ) : view === 'signals' ? (
          <TradeSignals
            data={signals}
            research={research}
            onInspect={setDetail}
            onFillRecorded={() => void refresh()}
          />
        ) : (
          <StrategyLab data={research} onInspect={setDetail} />
        )}
      </main>
      <AlertDialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Evidence record</AlertDialogTitle>
            <AlertDialogDescription>
              Raw computed record. Close with Escape.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detail !== null && (
            <div className="max-h-[65vh] overflow-auto">
              <CodeBlock
                code={JSON.stringify(detail, null, 2)}
                language="json"
              />
            </div>
          )}
          <div className="flex justify-end">
            <Button autoFocus variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
