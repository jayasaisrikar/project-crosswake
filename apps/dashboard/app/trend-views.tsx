'use client';
import { useState } from 'react';
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

/** One line saying why the board looks the way it does, most blocking reason first. */
function statusLine(data: Dict, fresh: boolean, today: Dict[]): string {
  const r: Dict = data.regime ?? {},
    open = data.open?.length ?? 0;
  if (!fresh)
    return `Engine stale: last report ${day(data.updatedAt)}. Restart it with pnpm trend:live.`;
  if (Date.now() < data.forwardStart)
    return `Not started: live paper trading begins ${day(data.forwardStart)} at 00:00 UTC. Empty until then.`;
  if (!r.on) {
    const gap =
      typeof r.btcClose === 'number' && typeof r.btcSma === 'number'
        ? ` BTC ${price(r.btcClose)} is ${(((r.btcSma - r.btcClose) / r.btcSma) * 100).toFixed(1)}% below its 100-day average of ${price(r.btcSma)}.`
        : '';
    return `Regime off: no new entries until BTC closes above its 100-day average.${gap}`;
  }
  if (today.length)
    return `${today.length} new signal${today.length > 1 ? 's' : ''} today.`;
  return open
    ? `Regime on, holding ${open} position${open > 1 ? 's' : ''}. No coin broke its 20-day high today.`
    : 'Regime on and watching. No coin broke its 20-day high today.';
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
        {bt.trades ? (
          <>
            <AlertTitle>
              Promising in testing, now being proven live.
            </AlertTitle>
            <AlertDescription>
              On 2025–2026 data it had never seen: {bt.trades} trades,{' '}
              {pct(bt.winRate)} wins, {pctBps(bt.netExpectancyBps)} per trade
              after fees. That result is not yet statistically certain. Paper
              signals only, not trade advice. Execution is disabled.
            </AlertDescription>
          </>
        ) : (
          <>
            <AlertTitle>New universe, judged on live results only.</AlertTitle>
            <AlertDescription>
              Same rules as v005 with HYPE and other newer coins added. Most
              have too little history for a fair backtest, so only live paper
              trades from {day(data.forwardStart)} count. Paper signals only,
              not trade advice. Execution is disabled.
            </AlertDescription>
          </>
        )}
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

      <p
        role="status"
        className="rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium"
      >
        {statusLine(data, fresh, today)}
      </p>

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
            hint={bt.trades ? `Backtest ${pct(bt.winRate)}` : undefined}
          />
          <Stat
            term="Per trade, after fees"
            value={pctBps(s.netExpectancyBps)}
            hint={
              bt.trades ? `Backtest ${pctBps(bt.netExpectancyBps)}` : undefined
            }
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

/** Switches between the frozen daily-trend plans that report live state. */
export function TrendBoard({
  data,
  onInspect,
}: {
  data: Dict | null;
  onInspect: (x: unknown) => void;
}) {
  const list: Dict[] = data?.strategies ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const current =
    list.find((s) => s.version === chosen) ??
    list.find((s) => s.kind !== 'htf-rsi') ??
    list[0] ??
    null;
  return (
    <div className="grid min-w-0 gap-6">
      {list.length > 1 && (
        <div
          role="tablist"
          aria-label="Strategy version"
          className="flex flex-wrap gap-2"
        >
          {list.map((s) => (
            <button
              key={s.version}
              role="tab"
              aria-selected={s.version === current?.version}
              onClick={() => setChosen(s.version)}
              className={cn(
                'min-h-9 rounded-full border px-4 text-sm',
                s.version === current?.version
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-card',
              )}
            >
              {s.kind === 'htf-rsi'
                ? 'v007 · 15m RSI perps (BTC/ETH/SOL)'
                : s.version === 'trend-daily-v005'
                  ? 'v005 · core 28 coins'
                  : `v006 · + HYPE & new coins (${s.universe})`}
            </button>
          ))}
        </div>
      )}
      {current?.kind === 'htf-rsi' ? (
        <HtfSignals data={current} onInspect={onInspect} />
      ) : (
        <TrendSignals data={current} onInspect={onInspect} />
      )}
    </div>
  );
}

const rMult = (x: unknown) =>
  typeof x === 'number' ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}R` : '—';
const time = (x: unknown) =>
  typeof x === 'number'
    ? new Date(x).toLocaleString('en-IN', {
        timeZone: 'UTC',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }) + ' UTC'
    : '—';
const exitLabel: Record<string, string> = {
  stop: 'Stop',
  trail: 'Trail',
  time: 'Time stop',
  gap: 'Data gap',
  open: 'Open',
};
const skipLabel: Record<string, string> = {
  funding: 'Funding against',
  max_concurrent: '2 already open',
  position_open: 'Already in coin',
  gap_through_stop: 'Gapped past stop',
  no_next_bar: 'Awaiting fill',
};

/** v007 15m RSI re-cross on perps: open paper positions and every signal with its logged fields. */
export function HtfSignals({
  data,
  onInspect,
}: {
  data: Dict;
  onInspect: (x: unknown) => void;
}) {
  const fresh = Date.now() - data.updatedAt < 45 * 60_000,
    s: Dict = data.stats ?? {},
    events: Dict[] = data.events ?? [],
    open: Dict[] = data.open ?? [];
  const status = !fresh
    ? `Engine stale: last report ${time(data.updatedAt)}. Restart it with pnpm htf:live.`
    : Date.now() < data.forwardStart
      ? `Not started: live paper trading begins ${day(data.forwardStart)} at 00:00 UTC.`
      : open.length
        ? `Holding ${open.length} of 2 allowed positions. Next check after ${time(data.nextClose)}.`
        : `Watching ${data.universe} perps on every 15m close. No open position; next check after ${time(data.nextClose)}.`;
  return (
    <section
      aria-label="15m RSI perp signals"
      className="grid min-w-0 gap-8 [&>*]:min-w-0"
    >
      <Alert role="note">
        <CircleAlert aria-hidden />
        <AlertTitle>
          New strategy, judged on its frozen test and live paper.
        </AlertTitle>
        <AlertDescription>
          4h EMA trend filter with 15m RSI re-crosses on BTC, ETH and SOL perps.
          Results are in R (multiples of the stop distance) after 10 bps costs
          and funding. Paper signals only, not trade advice. Execution is
          disabled.
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
        <Badge variant="outline">{data.universe} perps · 15m</Badge>
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

      <p
        role="status"
        className="rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium"
      >
        {status}
      </p>

      <div>
        <h2 className="font-display mb-4 text-xl font-medium tracking-tight">
          Live record since {day(data.forwardStart)}
        </h2>
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat
            term="Closed trades"
            value={String(s.trades ?? 0)}
            hint="Target 200 before judging"
          />
          <Stat term="Win rate" value={pct(s.winRate)} hint="Target 45–55%" />
          <Stat term="Per trade, net" value={rMult(s.expectancyR)} />
          <Stat term="Total" value={rMult(s.totalR)} />
        </dl>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open paper positions</CardTitle>
          <CardDescription>
            Half comes off at 1.5R; the stop moves to entry after 1R; the rest
            trails 2 ATR. Flat after 16 bars if 1.5R is not reached.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {open.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coin</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Stop</TableHead>
                  <TableHead className="text-right">Now</TableHead>
                  <TableHead className="text-right">Mark</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {open.map((t) => (
                  <TableRow
                    key={t.id}
                    className="cursor-pointer"
                    onClick={() => onInspect(t)}
                  >
                    <TableCell className="font-medium">
                      {asset(t.symbol)}
                    </TableCell>
                    <TableCell>
                      {t.side === 'long' ? 'Long' : 'Short'}
                    </TableCell>
                    <TableCell>{time(t.ts)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(t.entry)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(t.stop)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {price(t.lastClose)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        tone(t.realizedR),
                      )}
                    >
                      {rMult(t.realizedR)}
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
          <CardTitle>Signal log</CardTitle>
          <CardDescription>
            Every trigger, including skipped ones. Select a row for all logged
            fields (EMA state, ADX, RSI, ATR, VWAP, funding).
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {events.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Signal</TableHead>
                  <TableHead>Trade</TableHead>
                  <TableHead className="text-right">RSI</TableHead>
                  <TableHead className="text-right">4h ADX</TableHead>
                  <TableHead className="text-right">Stop</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((e) => (
                  <TableRow
                    key={e.id}
                    className="cursor-pointer"
                    onClick={() => onInspect(e)}
                  >
                    <TableCell>{time(e.ts)}</TableCell>
                    <TableCell>
                      {e.side === 'long' ? 'Long' : 'Short'} {asset(e.symbol)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.rsiPrev?.toFixed(1)}→{e.rsi?.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.adx4h?.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {typeof e.rDistance === 'number'
                        ? `${((e.rDistance / e.entry) * 100).toFixed(2)}%`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {e.status === 'skipped'
                        ? `Skipped: ${skipLabel[e.skipReason] ?? e.skipReason}`
                        : `${exitLabel[e.exitReason] ?? e.exitReason}${e.scaled ? ' · ½ at 1.5R' : ''}`}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        tone(e.realizedR),
                      )}
                    >
                      {e.status === 'skipped' ? '—' : rMult(e.realizedR)}
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
