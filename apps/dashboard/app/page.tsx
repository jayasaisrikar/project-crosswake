'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  ArrowUpRight,
  FlaskConical,
  Radio,
  RefreshCw,
  Search,
  Signal,
  Layers,
} from 'lucide-react';
import { Button } from '@/components/base-ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/base-ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/base-ui/table';
import { Badge } from '@/components/base-ui/badge';
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
import { NativeSelect } from '@/components/base-ui/native-select';
import { Label } from '@/components/base-ui/label';
import { Input } from '@/components/base-ui/input';
import { Separator } from '@/components/base-ui/separator';
import { Skeleton } from '@/components/base-ui/skeleton';
import { RollingNumber } from '@/components/base-ui/rolling-number';
import { GradientHeading } from '@/components/base-ui/gradient-heading';
import {
  MinimalCard,
  MinimalCardDescription,
  MinimalCardTitle,
} from '@/components/base-ui/minimal-card';
import { CodeBlock } from '@/components/base-ui/code-block';
import { cn } from '@/lib/utils';

type Dict = Record<string, any>;
const number = (x: unknown) =>
  typeof x === 'number'
    ? x.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : '—';
const percent = (x: unknown) =>
  typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—';
const time = (x: unknown) =>
  typeof x === 'number'
    ? new Date(x).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
    : '—';
const format = (x: unknown) =>
  typeof x === 'number' || typeof x === 'string' ? String(x) : '—';
const roll = (x: unknown) =>
  typeof x === 'number' ? (
    <RollingNumber
      value={x}
      format={(n) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
    />
  ) : (
    '—'
  );
async function read(path: string) {
  const r = await fetch(`/api/evidence/${path}`, { cache: 'no-store' });
  if (!r.ok)
    throw new Error(
      r.status === 503
        ? 'Evidence service is offline. Start the local API and refresh.'
        : 'This evidence is incomplete or failed its integrity check.',
    );
  return r.json();
}

const DESTINATIONS = [
  { id: 'Overview', icon: Layers, blurb: 'Follow the evidence.' },
  { id: 'Signals', icon: Signal, blurb: 'Inspect every decision.' },
  { id: 'Experiments', icon: FlaskConical, blurb: 'Compare research runs.' },
  { id: 'Context', icon: Radio, blurb: 'Higher-timeframe context.' },
];
const TAB_COPY: Record<string, { eyebrow: string; body: string }> = {
  Overview: {
    eyebrow: 'BTC → ALTCOIN TRANSMISSION',
    body: 'A live view of collection and research readiness. Strategy performance remains unvalidated.',
  },
  Signals: {
    eyebrow: 'PAPER SESSION DECISIONS',
    body: 'Candidates, entries and rejection reasons from the current paper session.',
  },
  Experiments: {
    eyebrow: 'FROZEN PROTOCOL EVIDENCE',
    body: 'Computed reports from frozen protocols. An incomplete run is not performance evidence.',
  },
  Context: {
    eyebrow: 'SUPPLEMENTARY OBSERVATIONS',
    body: 'Timestamped altFINS observations. Missing or stale context stays unavailable.',
  },
};

export default function Workbench() {
  const [tab, setTab] = useState('Overview'),
    [live, setLive] = useState<Dict | null>(null),
    [protocols, setProtocols] = useState<string[]>([]),
    [runs, setRuns] = useState<string[]>([]),
    [selected, setSelected] = useState<Dict | null>(null),
    [detail, setDetail] = useState<Dict | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refreshed, setRefreshed] = useState<number | null>(null),
    [filter, setFilter] = useState('ALL'),
    [palette, setPalette] = useState(false),
    [query, setQuery] = useState(''),
    [cursor, setCursor] = useState(0);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [l, p, r] = await Promise.all([
        read('live'),
        read('protocols'),
        read('experiments'),
      ]);
      setLive(l);
      setProtocols(p.protocols);
      setRuns(r.experiments);
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
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [query, palette]);
  const health = live?.health,
    shadow = health?.shadow,
    fresh = health && Date.now() - health.ts < 30000,
    connected = fresh && health.connected;
  const events = (live?.events ?? []).filter(
    (e: Dict) => filter === 'ALL' || e.kind === filter,
  );
  const matches = DESTINATIONS.filter((x) =>
    x.id.toLowerCase().includes(query.toLowerCase()),
  );
  const navigate = (value: string) => {
    setTab(value);
    setPalette(false);
    setQuery('');
  };
  const copy = TAB_COPY[tab] ?? TAB_COPY.Overview;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-0 focus:z-50 focus:bg-background focus:p-4"
      >
        Skip to research
      </a>
      <aside className="flex flex-col gap-6 border-b border-border bg-card px-4 py-5 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:px-6 lg:py-9">
        <a href="#main" className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <ArrowUpRight className="size-5" aria-hidden />
          </span>
          <span className="font-display text-xl font-semibold tracking-tight">
            crosswake
          </span>
        </a>
        <p className="font-mono text-[10px] tracking-[0.13em] text-muted-foreground">
          RESEARCH WORKBENCH
        </p>
        <nav
          aria-label="Research views"
          className="flex gap-1 overflow-x-auto lg:grid"
        >
          {DESTINATIONS.map((x) => {
            const Icon = x.icon;
            const active = tab === x.id;
            return (
              <button
                key={x.id}
                aria-current={active ? 'page' : undefined}
                onClick={() => setTab(x.id)}
                className={cn(
                  'relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm whitespace-nowrap',
                  active
                    ? 'text-primary'
                    : 'text-muted-foreground hover:bg-background',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="rail-active"
                    className="absolute inset-0 rounded-md bg-background shadow-[inset_2px_0_var(--primary)]"
                    transition={{ type: 'spring', bounce: 0.19, duration: 0.4 }}
                  />
                )}
                <Icon className="relative size-4" aria-hidden />
                <span className="relative">{x.id}</span>
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden flex-col gap-3 lg:flex">
          <div className="flex flex-col gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="w-fit font-mono text-[10px]">
              BINANCE SPOT
            </Badge>
            <p>
              Long-only paper validation.
              <br />
              Short signals for research.
            </p>
          </div>
          <Separator />
          <Button
            variant="outline"
            className="justify-between"
            onClick={() => setPalette(true)}
          >
            Find a view
            <kbd className="font-mono text-[11px] text-muted-foreground">
              ⌘K
            </kbd>
          </Button>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 text-xs lg:px-10 lg:py-4">
          <span className="hidden text-muted-foreground sm:block">
            Research / <strong className="text-foreground">{tab}</strong>
          </span>
          <Button
            variant="outline"
            size="sm"
            className="sm:hidden"
            onClick={() => setPalette(true)}
            aria-label="Find a research view"
          >
            <Search className="size-4" aria-hidden />
          </Button>
          <div className="flex items-center gap-3">
            <Badge
              variant={connected ? 'default' : 'secondary'}
              className="gap-1.5"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  connected ? 'bg-emerald-400' : 'bg-muted-foreground',
                )}
                aria-hidden
              />
              {connected
                ? 'Collecting'
                : health
                  ? 'Feed unavailable'
                  : 'Waiting for collector'}
            </Badge>
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
              {loading ? 'Refreshing…' : 'Refresh evidence'}
            </Button>
          </div>
        </header>
        <main
          id="main"
          className="mx-auto max-w-6xl px-4 py-8 lg:px-10 lg:py-12"
        >
          <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <p className="mb-3 font-mono text-[10px] tracking-[0.07em] text-muted-foreground uppercase">
                {copy.eyebrow}
              </p>
              <GradientHeading asChild size="lg" weight="semi">
                <h1>{DESTINATIONS.find((d) => d.id === tab)?.blurb}</h1>
              </GradientHeading>
              <p className="mt-3 text-sm text-muted-foreground">{copy.body}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-[10px] tracking-[0.07em] text-muted-foreground uppercase">
                Last refresh · IST
              </p>
              <p className="font-mono text-base font-medium">
                {time(refreshed)}
              </p>
            </div>
          </div>
          {error && (
            <Alert variant="destructive" className="mb-6" role="alert">
              <AlertTitle>Evidence could not be refreshed.</AlertTitle>
              <AlertDescription className="mt-1">{error}</AlertDescription>
              <div className="mt-3">
                <Button
                  size="sm"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  Try refresh
                </Button>
              </div>
            </Alert>
          )}
          {!error && loading && !live && (
            <div
              role="status"
              className="grid gap-3"
              aria-label="Loading local evidence"
            >
              <Skeleton className="h-36 w-full" />
              <div className="grid gap-3 sm:grid-cols-2">
                <Skeleton className="h-48 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            </div>
          )}
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              {tab === 'Overview' && (
                <>
                  <Card className="mb-10 overflow-hidden border-primary/20 bg-primary text-primary-foreground">
                    <CardContent className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_2fr]">
                      <div>
                        <p className="font-mono text-[11px] tracking-[0.06em] uppercase opacity-80">
                          Closed research seconds
                        </p>
                        <p className="font-display mt-2 text-5xl font-medium tracking-tight tabular-nums lg:text-6xl">
                          {roll(shadow?.steps)}
                        </p>
                        <p className="mt-2 text-xs opacity-80">
                          {shadow?.mode
                            ? 'Adaptive paper observation'
                            : 'No active paper session'}
                        </p>
                      </div>
                      <dl className="grid grid-cols-2 gap-6">
                        {[
                          ['Candidates evaluated', roll(shadow?.candidates)],
                          ['Closed paper trades', roll(shadow?.closedTrades)],
                          ['Open positions', roll(shadow?.openPositions)],
                          ['Late market events', roll(health?.late)],
                        ].map(([term, value]) => (
                          <div key={term as string}>
                            <dt className="text-xs opacity-80">{term}</dt>
                            <dd className="font-display mt-1 text-2xl font-medium tabular-nums">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </CardContent>
                  </Card>
                  <Card className="mb-10">
                    <CardHeader>
                      <CardTitle>Signal readiness</CardTitle>
                      <CardDescription>
                        Filter counts can overlap. Scores are heuristics, not
                        win probabilities.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="mb-4 text-sm">
                        Fitted assets:{' '}
                        {number(shadow?.engine?.relationshipCount)}
                      </p>
                      {shadow?.engine?.funnel ? (
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {Object.entries(shadow.engine.funnel).map(
                            ([reason, count]) => (
                              <div key={reason} className="min-w-0">
                                <dt className="text-xs text-muted-foreground">
                                  {reason.replaceAll('_', ' ')}
                                </dt>
                                <dd className="text-sm tabular-nums">
                                  {number(count)}
                                </dd>
                              </div>
                            ),
                          )}
                        </dl>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          This collector session predates filter diagnostics.
                        </p>
                      )}
                    </CardContent>
                  </Card>
                  <div className="mb-10 grid gap-6 [&>*]:min-w-0 lg:grid-cols-[1.25fr_1fr]">
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Collection health
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="overflow-x-auto">
                        <Table>
                          <TableBody>
                            {[
                              [
                                'Universe',
                                health?.symbols?.join(' · ') ?? 'No collector',
                              ],
                              [
                                'Last market message',
                                time(health?.lastMessageAt),
                              ],
                              [
                                'Closure allowance',
                                health?.latenessMs
                                  ? `${health.latenessMs / 1000} seconds`
                                  : 'Legacy session setting',
                              ],
                              ['Rejected payloads', number(health?.rejected)],
                              ['Queue pending', number(health?.pending)],
                              [
                                'Memory',
                                health
                                  ? `${(health.memoryBytes / 1024 / 1024).toFixed(0)} MB`
                                  : '—',
                              ],
                              [
                                'Recovered paper steps',
                                number(health?.recoveredPaperSteps),
                              ],
                            ].map(([a, b]) => (
                              <TableRow key={a}>
                                <TableHead>{a}</TableHead>
                                <TableCell className="text-right">
                                  {b}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Validation readiness
                        </CardTitle>
                        <CardDescription>
                          No profitability claim. No exchange orders are
                          enabled.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <ol className="grid gap-5">
                          {[
                            [
                              'Collect sufficient history',
                              'The frozen protocol needs prospective coverage before evaluation can begin.',
                            ],
                            [
                              'Evaluate unseen periods',
                              'Walk-forward and one-use holdout results must meet sample and confidence gates.',
                            ],
                            [
                              'Reconcile forward paper',
                              'Confirm costs, missing quotes and session continuity before considering execution.',
                            ],
                          ].map(([title, body], i) => (
                            <li key={title} className="flex gap-4">
                              <span className="font-mono text-xs text-primary">
                                0{i + 1}
                              </span>
                              <div>
                                <p className="text-sm font-medium">{title}</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {body}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </CardContent>
                    </Card>
                  </div>
                  <Card>
                    <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
                      <div>
                        <CardTitle className="text-lg">
                          Frozen protocols
                        </CardTitle>
                        <CardDescription className="mt-1">
                          Declared clocks and hypotheses, before selection.
                        </CardDescription>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {protocols.length ? (
                          protocols.map((id) => (
                            <Button
                              key={id}
                              variant="outline"
                              onClick={async () => {
                                try {
                                  setDetail(await read(`protocols/${id}`));
                                } catch (e) {
                                  setError(String(e));
                                }
                              }}
                            >
                              Inspect {id}{' '}
                              <ArrowUpRight className="size-3.5" aria-hidden />
                            </Button>
                          ))
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No registered protocols.
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
              {tab === 'Signals' && (
                <section aria-label="Current session decisions">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-display text-xl font-medium tracking-tight">
                      Current session decisions
                    </h2>
                    <div className="flex items-center gap-2">
                      <Label
                        htmlFor="event-filter"
                        className="text-xs text-muted-foreground"
                      >
                        Event type
                      </Label>
                      <NativeSelect
                        id="event-filter"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="w-auto"
                      >
                        <option value="ALL">All events</option>
                        <option value="candidate">Candidates</option>
                        <option value="entry">Entries</option>
                        <option value="trade">Closed trades</option>
                        <option value="entry_rejection">
                          Entry rejections
                        </option>
                      </NativeSelect>
                    </div>
                  </div>
                  {!events.length ? (
                    <Card className="bg-card">
                      <CardContent className="flex min-h-44 flex-col justify-center gap-2 p-7">
                        <CardTitle className="text-lg">
                          No matching decisions yet.
                        </CardTitle>
                        <CardDescription>
                          The engine needs warm-up history and a qualifying BTC
                          impulse. Empty samples have no win-rate estimate.
                        </CardDescription>
                      </CardContent>
                    </Card>
                  ) : (
                    <Card>
                      <CardContent className="overflow-x-auto p-0">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Event</TableHead>
                              <TableHead>Asset</TableHead>
                              <TableHead>Direction</TableHead>
                              <TableHead>Evidence</TableHead>
                              <TableHead className="text-right">
                                Inspect
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {events.map((e: Dict, i: number) => {
                              const c = e.candidate ?? e;
                              return (
                                <TableRow key={`${c.id ?? c.signalId}-${i}`}>
                                  <TableCell>
                                    <Badge variant="secondary">
                                      {format(e.kind)}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="font-medium">
                                    {format(c.symbol)}
                                  </TableCell>
                                  <TableCell>
                                    <Badge
                                      variant={
                                        String(c.side ?? 'LONG') === 'LONG'
                                          ? 'default'
                                          : 'outline'
                                      }
                                    >
                                      {format(c.side ?? 'LONG')}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="max-w-64 truncate text-muted-foreground">
                                    {c.reasons?.join(', ') ||
                                      c.reason ||
                                      c.exitReason ||
                                      'Paper observation'}
                                  </TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      variant="link"
                                      size="sm"
                                      onClick={() => setDetail(e)}
                                    >
                                      View evidence
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                  )}
                  <p className="mt-4 text-[11px] text-muted-foreground">
                    Showing up to 100 recent material events. Short-side
                    observations remain research-only.
                  </p>
                </section>
              )}
              {tab === 'Experiments' && (
                <section
                  aria-label="Saved experiment runs"
                  className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[1.2fr_1fr]"
                >
                  <div>
                    <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
                      Saved experiment runs
                    </h2>
                    {runs.length ? (
                      <div className="grid gap-2">
                        {runs.map((id) => (
                          <button
                            key={id}
                            onClick={async () => {
                              try {
                                setSelected(await read(`experiments/${id}`));
                                setError('');
                              } catch (e) {
                                setSelected(null);
                                setError(
                                  String(e instanceof Error ? e.message : e),
                                );
                              }
                            }}
                            className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 font-mono text-xs break-all hover:border-primary hover:text-primary"
                          >
                            {id}
                            <span className="shrink-0 text-primary">
                              Inspect →
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Card className="bg-card">
                        <CardContent className="flex min-h-44 flex-col justify-center gap-2 p-7">
                          <CardTitle className="text-lg">
                            No completed research evidence yet.
                          </CardTitle>
                          <CardDescription>
                            Run a frozen protocol after its required data window
                            is available. Failed runs are retained for audit.
                          </CardDescription>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                  <div>
                    {selected ? (
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-lg">
                            Unseen block summary
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <dl className="grid grid-cols-2 gap-6">
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                Closed long trades
                              </dt>
                              <dd className="font-display mt-1 text-2xl tabular-nums">
                                {roll(selected.metrics?.closedTrades)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                Net win rate
                              </dt>
                              <dd className="font-display mt-1 text-2xl tabular-nums">
                                {percent(selected.metrics?.winRate)}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                Net expectancy
                              </dt>
                              <dd className="font-display mt-1 text-2xl tabular-nums">
                                {number(selected.metrics?.netExpectancyBps)} bps
                              </dd>
                            </div>
                            <div>
                              <dt className="text-xs text-muted-foreground">
                                Profit factor
                              </dt>
                              <dd className="font-display mt-1 text-2xl tabular-nums">
                                {number(selected.metrics?.profitFactor)}
                              </dd>
                            </div>
                          </dl>
                          <Alert
                            variant={
                              selected.gate?.passed ? 'default' : 'destructive'
                            }
                            className="mt-6"
                          >
                            <AlertTitle>
                              {selected.gate?.passed
                                ? 'Statistical checks passed; holdout and forward paper still required.'
                                : 'Statistical evidence is insufficient or failed.'}
                            </AlertTitle>
                            {!!selected.gate?.reasons?.length && (
                              <AlertDescription>
                                <ul className="mt-2 list-disc pl-4">
                                  {selected.gate.reasons.map((x: string) => (
                                    <li key={x}>{x.replaceAll('_', ' ')}</li>
                                  ))}
                                </ul>
                              </AlertDescription>
                            )}
                          </Alert>
                          <Button
                            variant="outline"
                            className="mt-4"
                            onClick={() => setDetail(selected)}
                          >
                            Inspect provenance and limits
                          </Button>
                        </CardContent>
                      </Card>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Choose a run to inspect its computed evidence.
                      </p>
                    )}
                  </div>
                </section>
              )}
              {tab === 'Context' && (
                <section aria-label="altFINS cache">
                  <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
                    altFINS cache
                  </h2>
                  <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[1.5fr_1fr]">
                    <MinimalCard className="bg-card p-7">
                      <Badge
                        variant={
                          live?.context?.snapshot ? 'default' : 'secondary'
                        }
                      >
                        {live?.context?.status ?? 'Unavailable'}
                      </Badge>
                      <MinimalCardTitle className="mt-4">
                        {live?.context?.snapshot
                          ? 'A timestamped context snapshot is available.'
                          : 'Context has not been collected.'}
                      </MinimalCardTitle>
                      <MinimalCardDescription>
                        Configure the subscription key locally and run the
                        context collector. Context availability begins when
                        Crosswake retrieves it; later downloads cannot become
                        past evidence.
                      </MinimalCardDescription>
                    </MinimalCard>
                    <Card>
                      <CardContent className="p-6">
                        <dl className="grid gap-5">
                          {[
                            ['Provider', 'altFINS'],
                            [
                              'Retrieved',
                              time(live?.context?.snapshot?.retrievedAt),
                            ],
                            [
                              'Expires',
                              time(live?.context?.snapshot?.expiresAt),
                            ],
                            [
                              'Assets',
                              live?.context?.snapshot?.request?.symbols?.join(
                                ', ',
                              ) ?? '—',
                            ],
                          ].map(([a, b]) => (
                            <div key={a}>
                              <dt className="text-xs text-muted-foreground">
                                {a}
                              </dt>
                              <dd className="mt-1 font-mono text-sm">{b}</dd>
                            </div>
                          ))}
                        </dl>
                      </CardContent>
                    </Card>
                  </div>
                  {live?.context?.snapshot && (
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={() => setDetail(live.context.snapshot)}
                    >
                      Inspect context and provenance
                    </Button>
                  )}
                </section>
              )}
            </motion.div>
          </AnimatePresence>
          <footer className="mt-12 flex flex-wrap justify-between gap-4 border-t border-border pt-6 font-mono text-[10px] text-muted-foreground">
            <span>crosswake / local research</span>
            <span>Evidence first. Execution disabled.</span>
          </footer>
        </main>
      </div>
      <AlertDialog
        open={palette}
        onOpenChange={(open) => {
          setPalette(open);
          if (!open) setQuery('');
        }}
      >
        <AlertDialogContent
          className="max-w-lg"
          onKeyDown={(e) => {
            if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
            e.preventDefault();
            if (!matches.length) return;
            if (e.key === 'Enter') {
              const pick = matches[cursor] ?? matches[0];
              if (pick) navigate(pick.id);
              return;
            }
            const next =
              (cursor + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) %
              matches.length;
            setCursor(next);
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Find a research view</AlertDialogTitle>
            <AlertDialogDescription>
              Jump between evidence views. Arrow keys move, Enter selects,
              Escape closes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              aria-label="Search research views"
              placeholder="Search views"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="border-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div
            className="grid gap-1"
            role="listbox"
            aria-label="Research views"
          >
            {matches.map((x, i) => (
              <button
                key={x.id}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => navigate(x.id)}
                className={cn(
                  'flex items-center justify-between rounded-md px-3 py-2.5 text-left text-sm',
                  i === cursor
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/60',
                )}
              >
                {x.id}
                <span className="text-primary">↗</span>
              </button>
            ))}
          </div>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
      >
        <AlertDialogContent className="max-w-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Research evidence</AlertDialogTitle>
            <AlertDialogDescription>
              Raw computed record. Copy it for audit or close with Escape.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detail && (
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
