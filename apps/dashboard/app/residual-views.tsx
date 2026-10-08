'use client';
import { useMemo, useState } from 'react';
import { Bell, BellOff, CircleAlert } from 'lucide-react';
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
import { cn } from '@/lib/utils';

type Dict = Record<string, any>;
const bps = (x: unknown, digits = 1) =>
  typeof x === 'number' ? `${x >= 0 ? '+' : ''}${x.toFixed(digits)} bps` : '—';
const pct = (x: unknown) =>
  typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—';
const price = (x: unknown) =>
  typeof x === 'number' ? Number(x.toPrecision(6)).toString() : '—';
const clock = (x: unknown) =>
  typeof x === 'number'
    ? new Date(x).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
      })
    : '—';
const asset = (s: unknown) => String(s ?? '').replace(/USDT$/, '');
const duration = (ms: unknown) =>
  typeof ms === 'number'
    ? ms < 60000
      ? `${Math.round(ms / 1000)}s`
      : `${(ms / 60000).toFixed(1)} min`
    : '—';

function Stat({
  term,
  value,
  hint,
}: {
  term: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="font-display mt-1 text-xl font-medium tabular-nums">
        {value}
      </dd>
      {hint && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <Card className="bg-card">
      <CardContent className="flex min-h-36 flex-col justify-center gap-2 p-7">
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardContent>
    </Card>
  );
}

export function TradeSignals({
  data,
  research,
  onInspect,
  onFillRecorded,
}: {
  data: Dict | null;
  research: Dict | null;
  onInspect: (x: unknown) => void;
  onFillRecorded: () => void;
}) {
  const sessions: Dict[] = data?.sessions ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const [fillFor, setFillFor] = useState<Dict | null>(null);
  const session = sessions.find((s) => s.id === chosen) ?? sessions[0];
  if (!session)
    return (
      <Empty
        title="No live signal session yet."
        body="Start the live engine with pnpm residual:live. Signals appear here as soon as a bar closes with a qualifying setup."
      />
    );
  const h = session.health ?? {},
    now = Date.now(),
    fresh = typeof h.at === 'number' && now - h.at < 180000,
    version = String(h.version ?? ''),
    validation = (research?.walkForward ?? []).find(
      (w: Dict) => w.planId === version,
    ),
    active = (session.signals as Dict[]).filter(
      (s) => typeof s.entryAtTs === 'number' && s.entryAtTs + s.holdMs > now,
    ),
    reported = new Set(
      (session.fills?.recent ?? []).map((f: Dict) => f.signalId),
    );
  return (
    <section
      aria-label="Live trade signals"
      className="grid min-w-0 gap-8 [&>*]:min-w-0"
    >
      <Alert variant="destructive" role="note">
        <CircleAlert aria-hidden />
        <AlertTitle>
          {validation?.gate && !validation.gate.passed
            ? 'This strategy failed its out-of-sample validation.'
            : 'This strategy is unvalidated.'}
        </AlertTitle>
        <AlertDescription>
          Signals are paper research, not trade advice. Execution is disabled.
          {validation?.outOfSample &&
            (validation.outOfSample.closedTrades
              ? ` Unseen-period result: ${validation.outOfSample.closedTrades} trades, ${pct(validation.outOfSample.winRate)} wins, ${bps(validation.outOfSample.netExpectancyBps)} per trade.`
              : ' It produced no qualifying trades in unseen periods.')}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={fresh ? 'default' : 'secondary'} className="gap-1.5">
            <span
              className={cn(
                'size-1.5 rounded-full',
                fresh ? 'bg-emerald-400' : 'bg-muted-foreground',
              )}
              aria-hidden
            />
            {fresh ? 'Engine running' : 'Engine stale'}
          </Badge>
          <Badge variant="outline">
            {String(h.market ?? 'spot').toUpperCase()}
          </Badge>
          <Badge variant="outline">{String(h.instrument ?? '—')}</Badge>
          {(h.channels ?? []).map((c: Dict) => (
            <Badge
              key={c.name}
              variant={c.enabled ? 'secondary' : 'outline'}
              className="gap-1"
              title={c.detail}
            >
              {c.enabled ? <Bell aria-hidden /> : <BellOff aria-hidden />}
              {c.name}
              {!c.enabled && ' · later'}
            </Badge>
          ))}
        </div>
        {sessions.length > 1 && (
          <div className="flex items-center gap-2">
            <Label htmlFor="session" className="text-xs text-muted-foreground">
              Session
            </Label>
            <NativeSelect
              id="session"
              value={session.id}
              onChange={(e) => setChosen(e.target.value)}
              className="w-auto"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      <div>
        <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
          Active signals
        </h2>
        {active.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {active.map((s) => (
              <Card
                key={s.id}
                className={cn(
                  s.side === 'LONG'
                    ? 'border-emerald-500/40'
                    : 'border-rose-500/40',
                )}
              >
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-2xl">
                      {s.side} {asset(s.symbol)}
                    </CardTitle>
                    <Badge variant={s.side === 'LONG' ? 'default' : 'outline'}>
                      {s.instrument}
                    </Badge>
                  </div>
                  <CardDescription>
                    Decided {clock(s.decisionTs)} · enter around{' '}
                    {clock(s.entryAtTs)} · exit by{' '}
                    {clock(s.entryAtTs + s.holdMs)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat term="Reference" value={price(s.referencePrice)} />
                    <Stat term="Skip beyond" value={price(s.entryPriceLimit)} />
                    <Stat
                      term="Target"
                      value={price(s.targetPrice)}
                      hint={bps(s.targetBps, 0)}
                    />
                    <Stat
                      term="Stop"
                      value={price(s.stopPrice)}
                      hint={bps(-s.stopBps, 0)}
                    />
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    BTC {bps(s.btcMoveBps, 0)}; {asset(s.symbol)} lagging its{' '}
                    {Number(s.beta).toFixed(2)} beta by {bps(s.lagBps, 0)} (z{' '}
                    {Number(s.residualZ).toFixed(2)}). Score {s.score} is a
                    heuristic, not a win probability.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={reported.has(s.id)}
                      onClick={() => setFillFor(s)}
                    >
                      {reported.has(s.id)
                        ? 'Fill reported'
                        : 'I took this trade'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onInspect(s)}
                    >
                      Evidence
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Empty
            title="No active signal right now."
            body="A signal appears when an alt lags its BTC beta beyond the entry threshold and every filter passes. Most bars produce nothing."
          />
        )}
      </div>
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Paper record</CardTitle>
            <CardDescription>
              Simulated fills from this session only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-5">
              <Stat
                term="Closed trades"
                value={String(session.paper?.closedTrades ?? 0)}
              />
              <Stat term="Win rate" value={pct(session.paper?.winRate)} />
              <Stat
                term="Net per trade"
                value={bps(session.paper?.netExpectancyBps)}
              />
              <Stat
                term="Breakeven win rate"
                value={pct(session.paper?.breakevenWinRate)}
              />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Delivery</CardTitle>
            <CardDescription>Decision to channel, per sink.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-5">
              <Stat
                term="Dashboard"
                value="Live feed"
                hint={`${session.signals.length} recent signals`}
              />
              {Object.entries(session.deliveries ?? {}).map(
                ([sink, d]: [string, any]) => (
                  <Stat
                    key={sink}
                    term={sink}
                    value={`${d.ok} sent`}
                    hint={`${d.failed} failed · median ${duration(d.medianLatencyMs)}`}
                  />
                ),
              )}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Your fills</CardTitle>
            <CardDescription>
              Measures real reaction time and slippage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-5">
              <Stat term="Reported" value={String(session.fills?.count ?? 0)} />
              <Stat
                term="Median reaction"
                value={duration(session.fills?.medianReactionMs)}
              />
              <Stat
                term="Median slippage"
                value={bps(session.fills?.medianSlippageBps)}
                hint="Adverse is positive"
              />
            </dl>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Open paper positions</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {(h.open ?? []).length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Entry</TableHead>
                    <TableHead className="text-right">Exit by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.open.map((p: Dict) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.side} {asset(p.symbol)}
                      </TableCell>
                      <TableCell>{price(p.entryPrice)}</TableCell>
                      <TableCell className="text-right">
                        {clock(p.exitByTs)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No open paper positions.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent paper exits</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {session.trades.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Exit</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {session.trades.slice(0, 12).map((t: Dict) => (
                    <TableRow
                      key={t.signalId}
                      className="cursor-pointer"
                      onClick={() => onInspect(t)}
                    >
                      <TableCell className="font-medium">
                        {t.side} {asset(t.symbol)}
                      </TableCell>
                      <TableCell>
                        {t.exitReason} · {clock(t.exitTs)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          t.netReturnBps >= 0
                            ? 'text-emerald-500'
                            : 'text-rose-500',
                        )}
                      >
                        {bps(t.netReturnBps)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No closed paper trades yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <FillDialog
        sessionId={session.id}
        signal={fillFor}
        onClose={() => setFillFor(null)}
        onSaved={() => {
          setFillFor(null);
          onFillRecorded();
        }}
      />
    </section>
  );
}

function FillDialog({
  sessionId,
  signal,
  onClose,
  onSaved,
}: {
  sessionId: string;
  signal: Dict | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fill, setFill] = useState(''),
    [minutesAgo, setMinutesAgo] = useState('0'),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  async function save() {
    const value = Number(fill),
      ago = Number(minutesAgo);
    if (!(value > 0) || !(ago >= 0)) {
      setError('Enter your fill price and how many minutes ago it filled.');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/evidence/signals/${sessionId}/fills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signalId: signal!.id,
          price: value,
          filledAt: Math.round(Date.now() - ago * 60000),
        }),
      });
      if (!r.ok)
        throw new Error(
          r.status === 409
            ? 'A fill for this signal is already recorded.'
            : r.status === 400
              ? 'The fill time must be after the signal was published.'
              : 'The fill could not be recorded. Is the evidence service running?',
        );
      setFill('');
      setMinutesAgo('0');
      setError('');
      onSaved();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <AlertDialog
      open={signal !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Report your {signal?.side} {asset(signal?.symbol)} fill
          </AlertDialogTitle>
          <AlertDialogDescription>
            Used only to measure real reaction time and slippage against the
            paper reference {price(signal?.referencePrice)}. Nothing is traded.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="fill-price">Fill price</Label>
            <Input
              id="fill-price"
              inputMode="decimal"
              value={fill}
              onChange={(e) => setFill(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fill-ago">Filled how many minutes ago</Label>
            <Input
              id="fill-ago"
              inputMode="decimal"
              value={minutesAgo}
              onChange={(e) => setMinutesAgo(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Record fill'}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function StrategyLab({
  data,
  onInspect,
}: {
  data: Dict | null;
  onInspect: (x: unknown) => void;
}) {
  const results: Dict[] = data?.study?.results ?? [];
  const [combo, setCombo] = useState(0);
  const study = results[combo];
  const costs: Dict[] = useMemo(
    () =>
      [...(data?.costs?.symbols ?? [])].sort(
        (a, b) =>
          a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol),
      ),
    [data],
  );
  const notionals: number[] =
    costs[0]?.roundTripImpact?.map((i: Dict) => i.notionalUsdt) ?? [];
  const cell = (s: Dict) =>
    s?.meanBps == null
      ? '—'
      : `${s.meanBps >= 0 ? '+' : ''}${s.meanBps.toFixed(1)} (t ${s.t?.toFixed(1)})`;
  return (
    <section
      aria-label="Strategy validation"
      className="grid min-w-0 gap-10 [&>*]:min-w-0"
    >
      <div>
        <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
          Out-of-sample validation
        </h2>
        {data?.walkForward?.length ? (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Unseen trades</TableHead>
                    <TableHead className="text-right">Win rate</TableHead>
                    <TableHead className="text-right">Net / trade</TableHead>
                    <TableHead className="text-right">95% range</TableHead>
                    <TableHead>Gate</TableHead>
                    <TableHead className="text-right">Inspect</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.walkForward.map((w: Dict) => (
                    <TableRow key={w.id}>
                      <TableCell className="font-medium">{w.planId}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.outOfSample?.closedTrades ?? 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pct(w.outOfSample?.winRate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {bps(w.outOfSample?.netExpectancyBps)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {w.outOfSample?.expectancy95
                          ? `${w.outOfSample.expectancy95[0].toFixed(0)} … ${w.outOfSample.expectancy95[1].toFixed(0)}`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={w.gate?.passed ? 'default' : 'destructive'}
                        >
                          {w.gate?.passed ? 'Passed' : 'Failed'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => onInspect(w)}
                        >
                          Folds & variants
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Empty
            title="No walk-forward results yet."
            body="Run pnpm residual:walk-forward with a plan to populate this table."
          />
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          A plan passes only with at least 500 unseen trades, a positive
          event-clustered expectancy bound, profit factor ≥ 1.3 and its drawdown
          and concentration limits.
        </p>
      </div>
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-medium tracking-tight">
            Filter-free edge study
          </h2>
          {results.length > 0 && (
            <div className="flex items-center gap-2">
              <Label htmlFor="combo" className="text-xs text-muted-foreground">
                Lookback / hold
              </Label>
              <NativeSelect
                id="combo"
                value={combo}
                onChange={(e) => setCombo(Number(e.target.value))}
                className="w-auto"
              >
                {results.map((r: Dict, i: number) => (
                  <option key={i} value={i}>
                    {r.lookbackMs / 3600000}h / {r.holdMs / 3600000}h
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </div>
        {study ? (
          <Card>
            <CardHeader>
              <CardDescription>
                Mean gross bps after each residual bucket, signed so positive
                means the lag closed. Outright round-trip cost is about{' '}
                {study.outrightCostBps} bps. Many cells were inspected, so
                isolated large t-values are expected by chance.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Residual z</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Outright</TableHead>
                    <TableHead className="text-right">Hedged</TableHead>
                    <TableHead className="text-right">BTC-confirmed</TableHead>
                    <TableHead className="text-right">n</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {study.buckets.map((b: Dict) => (
                    <TableRow key={b.z.join()}>
                      <TableCell className="font-mono text-xs">
                        {b.z[0] ?? '−∞'} … {b.z[1] ?? '∞'}
                      </TableCell>
                      <TableCell>{b.side}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cell(b.outright)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cell(b.hedged)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cell(b.btcConfirmedOutright)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {b.outright?.n ?? 0}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Empty
            title="No edge study yet."
            body="Run pnpm residual:study to measure what followed each residual size."
          />
        )}
      </div>
      <div>
        <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
          Measured execution costs
        </h2>
        {costs.length ? (
          <Card>
            <CardHeader>
              <CardDescription>
                Median spread and round-trip market-order impact from{' '}
                {data?.costs?.samples} order-book snapshots, excluding exchange
                fees.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead className="text-right">Spread</TableHead>
                    {notionals.map((n) => (
                      <TableHead key={n} className="text-right">
                        ${n.toLocaleString('en-US')}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costs.map((c) => (
                    <TableRow key={c.market + c.symbol}>
                      <TableCell>{c.market}</TableCell>
                      <TableCell className="font-medium">
                        {asset(c.symbol)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {c.spreadBps?.median?.toFixed(2)}
                      </TableCell>
                      {c.roundTripImpact.map((i: Dict) => (
                        <TableCell
                          key={i.notionalUsdt}
                          className="text-right tabular-nums"
                        >
                          {i.median == null ? 'thin' : i.median.toFixed(2)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Empty
            title="No cost samples yet."
            body="Run pnpm costs:sample, then pnpm costs:report."
          />
        )}
      </div>
    </section>
  );
}
