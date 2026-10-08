'use client';
import {
  CircleAlert,
  Database,
  FileBarChart,
  HardDrive,
  Microscope,
} from 'lucide-react';
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

const bytesLabel = (value: unknown) => {
  const n = typeof value === 'number' ? value : 0;
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(
    Math.floor(Math.log(n) / Math.log(1024)),
    units.length - 1,
  );
  return `${(n / 1024 ** power).toFixed(power >= 3 ? 2 : 0)} ${units[power]}`;
};
const countLabel = (value: unknown) =>
  typeof value === 'number' ? value.toLocaleString('en-IN') : '—';
const dayLabel = (ts: unknown) =>
  typeof ts === 'number'
    ? new Date(ts).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
    : '—';
const stampLabel = (ts: unknown) =>
  typeof ts === 'number'
    ? new Date(ts).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      })
    : '—';
const rangeLabel = (range: unknown) => {
  const r = (range ?? {}) as Dict;
  return typeof r.startTs === 'number' && typeof r.endTs === 'number'
    ? `${dayLabel(r.startTs)} → ${dayLabel(r.endTs)}`
    : '—';
};
/** 1 basis point is 0.01%. Signs matter, so keep them. */
const bpsLabel = (value: unknown) =>
  typeof value === 'number'
    ? `${value > 0 ? '+' : ''}${value.toFixed(1)} bps`
    : '—';
const pctLabel = (value: unknown) =>
  typeof value === 'number' ? `${(value * 100).toFixed(0)}%` : '—';

const SOURCE_ICON: Record<string, typeof Database> = {
  live: Database,
  bars: FileBarChart,
  journals: HardDrive,
  archives: HardDrive,
};

function Verdict({ run }: { run: Dict }) {
  const trades = run.trades as Dict | null;
  if (!trades || !trades.closed) {
    return (
      <span className="text-muted-foreground">
        No trades were taken, so there is nothing to measure yet.
      </span>
    );
  }
  const ci = trades.expectancy95 as number[] | null;
  const spansZero =
    Array.isArray(ci) && ci[0] <= 0 && ci[1] >= 0 ? true : false;
  return (
    <span
      className={cn('text-muted-foreground', spansZero && 'text-foreground')}
    >
      {trades.closed} trade{trades.closed === 1 ? '' : 's'},{' '}
      {pctLabel(trades.winRate)} won, average {bpsLabel(trades.expectancyBps)}{' '}
      per trade.{' '}
      {spansZero
        ? 'The 95% interval includes zero, so this is not evidence of an edge.'
        : 'The 95% interval stays above zero, but the sample is small.'}
    </span>
  );
}

function DatasetCard({ source }: { source: Dict }) {
  const Icon = SOURCE_ICON[source.id as string] ?? Database;
  return (
    <Card className="h-full">
      <CardHeader className="panel-heading">
        <div className="flex min-w-0 items-start gap-3">
          <Icon size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <CardTitle>{source.label}</CardTitle>
            <CardDescription>{source.detail}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {typeof source.symbols?.length === 'number' &&
            source.symbols.length > 0 && (
              <div>
                <dt className="text-xs text-muted-foreground">Symbols</dt>
                <dd className="text-lg font-semibold">
                  {source.symbols.length}
                </dd>
              </div>
            )}
          <div>
            <dt className="text-xs text-muted-foreground">Rows</dt>
            <dd className="text-lg font-semibold">{countLabel(source.rows)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">On disk</dt>
            <dd className="text-lg font-semibold">
              {bytesLabel(source.bytes)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Granularity</dt>
            <dd className="text-sm font-medium">{source.granularity ?? '—'}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          {source.granularity === 'per message'
            ? `Session files: ${countLabel(source.sessions)}. Newest ${stampLabel(
                source.newest?.at,
              )}.`
            : typeof source.firstTs === 'number' &&
                typeof source.lastTs === 'number'
              ? `Covers ${dayLabel(source.firstTs)} → ${dayLabel(source.lastTs)}.`
              : `${countLabel(source.files)} files on disk.`}
          {typeof source.unverified === 'number' && source.unverified > 0
            ? ` ${countLabel(source.unverified)} partition(s) missing an integrity manifest.`
            : ''}
        </p>
        {source.symbols?.length > 0 && (
          <p className="mt-2 font-mono text-[11px] break-words text-muted-foreground">
            {source.symbols.map((s: Dict) => s.symbol).join(' · ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function DataWorkbench({
  dataset,
  backtests,
  onInspect,
}: {
  dataset: Dict | null;
  backtests: Dict | null;
  onInspect?: (record: Dict) => void;
}) {
  const sources: Dict[] = dataset?.sources ?? [],
    runs: Dict[] = backtests?.runs ?? [];
  return (
    <section aria-label="Datasets and backtest results" className="space-y-8">
      <Alert>
        <CircleAlert aria-hidden />
        <AlertTitle>How to read this page</AlertTitle>
        <AlertDescription>
          <p>
            Everything here comes from files already on this machine. Nothing is
            fetched, simulated or estimated.
          </p>
          <p className="mt-2">
            Outcomes are measured in <strong>bps</strong> — one basis point is
            0.01%, so 100 bps is 1%. A dash or <em>null</em> means no trades
            were taken, so there is nothing to measure; it does not mean zero.
          </p>
        </AlertDescription>
      </Alert>

      <div>
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold">
              What is collected
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Four datasets back the research. Only the last one grows quickly.
            </p>
          </div>
          <Badge variant="outline">
            {bytesLabel(dataset?.totalBytes)} total
          </Badge>
        </div>
        {sources.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {sources.map((source) => (
              <DatasetCard key={source.id} source={source} />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              No datasets found under this data directory yet.
            </CardContent>
          </Card>
        )}
      </div>

      <div>
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold">
              What the backtests found
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every run on disk, newest first. These are exploratory results,
              not validated strategies.
            </p>
          </div>
          <Badge variant="outline">{runs.length} runs</Badge>
        </div>
        {runs.length ? (
          <Card>
            <CardContent className="overflow-x-auto pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Read from</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Sample</TableHead>
                    <TableHead>Trades</TableHead>
                    <TableHead>Win rate</TableHead>
                    <TableHead>Avg outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={`${run.kind}-${run.id}`}>
                      <TableCell>
                        <button
                          className="text-left hover:underline"
                          onClick={() => onInspect?.(run)}
                        >
                          <strong className="block">{run.strategy}</strong>
                          <small className="text-muted-foreground">
                            {run.kind === 'residual'
                              ? 'BTC-relative residual'
                              : 'BTC catch-up pair'}{' '}
                            · {stampLabel(run.completedAt)}
                          </small>
                        </button>
                      </TableCell>
                      <TableCell>{run.source ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {rangeLabel(run.range)}
                      </TableCell>
                      <TableCell>
                        {countLabel(run.units?.value)}{' '}
                        <small className="text-muted-foreground">
                          {run.units?.label}
                        </small>
                      </TableCell>
                      <TableCell>{countLabel(run.trades?.closed)}</TableCell>
                      <TableCell>{pctLabel(run.trades?.winRate)}</TableCell>
                      <TableCell>
                        {bpsLabel(run.trades?.expectancyBps)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-8 text-sm text-muted-foreground">
              No backtest reports found. Run{' '}
              <code>pnpm backtest -- --data-dir ./data --source live</code> or{' '}
              <code>pnpm residual:backtest -- --from … --to …</code>.
            </CardContent>
          </Card>
        )}
        {runs.length > 0 && (
          <ul className="mt-4 space-y-3">
            {runs.slice(0, 4).map((run) => (
              <li
                key={`verdict-${run.kind}-${run.id}`}
                className="flex gap-3 text-sm"
              >
                <Microscope
                  size={16}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span>
                  <strong>{run.strategy}</strong> — <Verdict run={run} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
