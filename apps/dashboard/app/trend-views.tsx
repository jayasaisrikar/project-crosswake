'use client';
import { Bell, BellOff, CircleAlert, TrendingUp } from 'lucide-react';
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
import { cn } from '@/lib/utils';

type Dict = Record<string, any>;
const pctBps = (x: unknown) =>
  typeof x === 'number' ? `${x >= 0 ? '+' : ''}${(x / 100).toFixed(1)}%` : '—';
const pct = (x: unknown) =>
  typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—';
const price = (x: unknown) =>
  typeof x === 'number' ? Number(x.toPrecision(6)).toString() : '—';
const day = (x: unknown) =>
  typeof x === 'number'
    ? new Date(x).toLocaleDateString('en-IN', {
        timeZone: 'UTC',
        day: '2-digit',
        month: 'short',
      })
    : '—';
const asset = (s: unknown) => String(s ?? '').replace(/USDT$/, '');
const tone = (x: unknown) =>
  typeof x === 'number'
    ? x >= 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400'
    : '';

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

/** v005 daily breakout: today's signals, open paper positions and the forward record against the backtest. */
export function TrendSignals({
  data,
  onInspect,
}: {
  data: Dict | null;
  onInspect: (x: unknown) => void;
}) {
  if (!data)
    return (
      <Card>
        <CardContent className="flex min-h-36 flex-col justify-center gap-2 p-7">
          <CardTitle className="text-lg">
            The daily engine has not reported yet.
          </CardTitle>
          <CardDescription>
            Start it with pnpm trend:live. It checks all coins after each 00:00
            UTC daily close.
          </CardDescription>
        </CardContent>
      </Card>
    );
  const fresh = Date.now() - data.updatedAt < 2 * 3_600_000,
    s: Dict = data.stats ?? {},
    bt: Dict = data.backtest?.test ?? {},
    today = (data.events as Dict[]).filter(
      (e) => e.decidedAt >= data.lastDailyClose - 86_400_000,
    ),
    history = (data.events as Dict[]).slice(0, 30);
  return (
    <section
      aria-label="Daily trend signals"
      className="grid min-w-0 gap-8 [&>*]:min-w-0"
    >
      <Alert role="note">
        <CircleAlert aria-hidden />
        <AlertTitle>Promising in testing, now being proven live.</AlertTitle>
        <AlertDescription>
          On 2025–2026 data it had never seen: {bt.trades} trades,{' '}
          {pct(bt.winRate)} wins, {pctBps(bt.netExpectancyBps)} per trade after
          fees. That result is not yet statistically certain. Paper signals
          only, not trade advice. Execution is disabled.
        </AlertDescription>
      </Alert>

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
        <Badge
          variant={data.regime?.on ? 'secondary' : 'outline'}
          className="gap-1"
        >
          <TrendingUp aria-hidden />
          BTC{' '}
          {data.regime?.on
            ? 'uptrend: entries allowed'
            : 'below 100-day average: no new entries'}
        </Badge>
        <Badge variant="outline">{data.universe} coins</Badge>
        {(data.channels ?? []).map((c: Dict) => (
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

      <Card>
        <CardHeader>
          <CardTitle>Today</CardTitle>
          <CardDescription>
            From the {day(data.lastDailyClose - 86_400_000)} daily close. Next
            check after {day(data.nextDailyClose)} 00:00 UTC (05:30 IST).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {today.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No new signals today. Breakouts are rare by design; most days
              nothing fires.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {today.map((e) => (
                <li key={e.id} className="rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display text-lg font-medium">
                      {e.kind === 'entry' ? 'Buy' : 'Sell'} {asset(e.symbol)}
                    </span>
                    <Badge
                      variant={e.kind === 'entry' ? 'default' : 'secondary'}
                    >
                      {e.kind === 'entry'
                        ? '20-day breakout'
                        : e.reason === 'regime'
                          ? 'BTC trend ended'
                          : '10-day low'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    At the daily open, about {price(e.price)}.
                    {e.kind === 'entry'
                      ? ' Exit when a daily close falls below the 10-day low.'
                      : ` Paper result ${pctBps(e.netBps)}.`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div>
        <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
          Live record since {day(data.forwardStart)}
        </h2>
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            term="Closed trades"
            value={String(s.trades ?? 0)}
            hint="Backtest expects ~12 a month"
          />
          <Stat
            term="Win rate"
            value={pct(s.winRate)}
            hint={`Backtest ${pct(bt.winRate)}`}
          />
          <Stat
            term="Per trade, after fees"
            value={pctBps(s.netExpectancyBps)}
            hint={`Backtest ${pctBps(bt.netExpectancyBps)}`}
          />
          <Stat term="Open positions" value={String(data.open?.length ?? 0)} />
        </dl>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open paper positions</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.open?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coin</TableHead>
                  <TableHead>Entered</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Now</TableHead>
                  <TableHead className="text-right">Unrealised</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.open.map((t: Dict) => (
                  <TableRow
                    key={t.symbol}
                    className="cursor-pointer"
                    onClick={() => onInspect(t)}
                  >
                    <TableCell className="font-medium">
                      {asset(t.symbol)}
                    </TableCell>
                    <TableCell>{day(t.entryTs)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(t.entry)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(t.lastClose)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', tone(t.markBps))}
                    >
                      {pctBps(t.markBps)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No open positions.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Signal history</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {history.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((e) => (
                  <TableRow
                    key={e.id}
                    className="cursor-pointer"
                    onClick={() => onInspect(e)}
                  >
                    <TableCell>{day(e.fillAt)}</TableCell>
                    <TableCell>
                      {e.kind === 'entry' ? 'Buy' : 'Sell'} {asset(e.symbol)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(e.price)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', tone(e.netBps))}
                    >
                      {pctBps(e.netBps)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No signals since the live start yet.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
