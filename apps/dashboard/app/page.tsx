'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Command,
  Database,
  FileJson,
  FlaskConical,
  Layers,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
  Waves,
  X,
} from 'lucide-react';
import { Button } from '@/components/base-ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/base-ui/card';
import { Badge } from '@/components/base-ui/badge';
import { Input } from '@/components/base-ui/input';
import { Label } from '@/components/base-ui/label';
import { NativeSelect } from '@/components/base-ui/native-select';
import { Skeleton } from '@/components/base-ui/skeleton';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/base-ui/alert-dialog';
import { RollingNumber } from '@/components/base-ui/rolling-number';
import { MinimalCard } from '@/components/base-ui/minimal-card';
import { CodeBlock } from '@/components/base-ui/code-block';
import { Brand, Status } from '@/components/crosswake/brand';
import { cn } from '@/lib/utils';
import { TradeSignals, StrategyLab } from './residual-views';
import { DataWorkbench } from './data-views';
import { MarketView } from './market-view';
import {
  BacktestLab,
  ExperimentLauncher,
  HyperliquidView,
} from './research-views';

type Dict = Record<string, any>;
const number = (x: unknown) =>
  typeof x === 'number' && Number.isFinite(x)
    ? x.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : '—';
const percent = (x: unknown) =>
  typeof x === 'number' && Number.isFinite(x)
    ? `${(x * 100).toFixed(1)}%`
    : '—';
const time = (x: unknown) =>
  typeof x === 'number'
    ? new Date(x).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
const text = (x: unknown) =>
  typeof x === 'string' || typeof x === 'number' ? String(x) : '—';
const human = (s: string) => s.replaceAll('_', ' ');
const rolling = (x: unknown) =>
  typeof x === 'number' && Number.isFinite(x) ? (
    <RollingNumber
      value={x}
      damping={24}
      format={(v) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
    />
  ) : (
    '—'
  );
const VIEWS = [
  {
    id: 'Market',
    icon: Activity,
    caption: 'Daily trend · v005',
    title: 'Market dashboard',
    description:
      'The BTC filter, coins closest to a breakout, open paper trades and every signal sent to Telegram.',
  },
  {
    id: 'Hyperliquid',
    icon: Waves,
    caption: 'Venue data · HYPE',
    title: 'Hyperliquid',
    description:
      'HYPE against its breakout level, live funding and open interest, and the daily Binance price check.',
  },
  {
    id: 'Backtest lab',
    icon: SlidersHorizontal,
    caption: 'Exploratory, not evidence',
    title: 'Backtest lab',
    description:
      'Try the daily trend rules with your own settings. Every run is labelled exploratory and kept apart from frozen results.',
  },
  {
    id: 'Trade signals',
    icon: ArrowUpRight,
    caption: 'Published setups',
    title: 'Trade signals',
    description:
      'Inspect published setups, expiry, delivery health, and reported fills.',
  },
  {
    id: 'Strategy lab',
    icon: FlaskConical,
    caption: 'Residual strategy research',
    title: 'Strategy validation',
    description:
      'Compare unseen results, study outcomes, and observed trading costs.',
  },
  {
    id: 'Overview',
    icon: Layers,
    caption: 'The research desk',
    title: 'Market overview',
    description:
      'Follow the feed, understand the filters, and see what the evidence supports.',
  },
  {
    id: 'Signals',
    icon: Signal,
    caption: 'Every decision, recorded',
    title: 'Signal ledger',
    description:
      'Inspect candidates, paper entries, closed trades, and the reasons an entry was rejected.',
  },
  {
    id: 'Experiments',
    icon: FlaskConical,
    caption: 'Hypotheses under test',
    title: 'Research experiments',
    description:
      'Frozen protocols and chronological evaluations, with their provenance and limits.',
  },
  {
    id: 'Context',
    icon: Radio,
    caption: 'The wider market',
    title: 'Market context',
    description:
      'Timestamped altFINS observations, kept alongside the primary market evidence.',
  },
  {
    id: 'Data',
    icon: Database,
    caption: 'What we hold, and what it showed',
    title: 'Datasets and backtests',
    description:
      'Every dataset on disk with its coverage, and every backtest run with its measured outcome.',
  },
] as const;
type View = (typeof VIEWS)[number]['id'];
async function read(path: string) {
  const response = await fetch(`/api/evidence/${path}`, { cache: 'no-store' });
  if (!response.ok)
    throw new Error(
      response.status === 503
        ? 'The local evidence service is offline. Start it, then refresh.'
        : 'This record is incomplete or failed its integrity check.',
    );
  return response.json();
}
function Empty({
  icon: Icon = Database,
  title,
  body,
  action,
}: {
  icon?: typeof Database;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={22} aria-hidden />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
  icon: typeof Database;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <Icon size={15} aria-hidden />
      </div>
      <div className="metric-value">{value}</div>
      <p>{note}</p>
    </div>
  );
}
function EvidenceDetails({ record }: { record: Dict }) {
  const c = record.candidate ?? record;
  const facts = [
    ['Asset', text(c.symbol)],
    ['Direction', text(c.side)],
    ['Recorded', time(c.ts ?? c.entryTs)],
    ['Eligible entry', time(c.entryEligibleTs ?? c.decisionTs)],
    [
      'Net return',
      typeof c.netReturnBps === 'number'
        ? `${number(c.netReturnBps)} bps`
        : '—',
    ],
    ['Model', text(c.modelVersion ?? c.modelKind)],
  ];
  return (
    <>
      <dl className="inspector-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {(c.reason || c.reasons?.length) && (
        <div className="record-reasons">
          <ShieldCheck size={16} aria-hidden />
          <span>
            {c.reason ? human(c.reason) : c.reasons.map(human).join(' · ')}
          </span>
        </div>
      )}
      <details className="raw-record" open={!c.symbol}>
        <summary>
          <FileJson size={16} aria-hidden />
          Computed record <span>JSON</span>
        </summary>
        <div className="evidence-json">
          <CodeBlock code={JSON.stringify(record, null, 2)} language="json" />
        </div>
      </details>
    </>
  );
}

export default function Workbench() {
  const [tab, setTab] = useState<View>('Market'),
    [live, setLive] = useState<Dict | null>(null),
    [protocols, setProtocols] = useState<string[]>([]),
    [runs, setRuns] = useState<string[]>([]),
    [selected, setSelected] = useState<Dict | null>(null),
    [selectedId, setSelectedId] = useState(''),
    [detail, setDetail] = useState<Dict | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [refreshed, setRefreshed] = useState<number | null>(null),
    [filter, setFilter] = useState('ALL'),
    [palette, setPalette] = useState(false),
    [query, setQuery] = useState(''),
    [cursor, setCursor] = useState(0),
    [runLoading, setRunLoading] = useState(false);
  const [signals, setSignals] = useState<Dict | null>(null),
    [research, setResearch] = useState<Dict | null>(null),
    [dataset, setDataset] = useState<Dict | null>(null),
    [backtests, setBacktests] = useState<Dict | null>(null),
    [trend, setTrend] = useState<Dict | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null),
    detailOpenerRef = useRef<HTMLElement | null>(null);
  const showDetail = (record: Dict) => {
    detailOpenerRef.current = document.activeElement as HTMLElement;
    setDetail(record);
  };
  const requestId = useRef(0),
    runRequestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const [
        l,
        p,
        r,
        signalData,
        researchData,
        datasetData,
        backtestData,
        trendData,
      ] =
        await Promise.all([
          read('live'),
          read('protocols'),
          read('experiments'),
          read('signals').catch(() => null),
          read('research').catch(() => null),
          read('data').catch(() => null),
          read('backtests').catch(() => null),
          read('trend').catch(() => null),
        ]);
      if (id !== requestId.current) return;
      setLive(l);
      setSignals(signalData);
      setResearch(researchData);
      setDataset(datasetData);
      setBacktests(backtestData);
      setTrend(trendData);
      setProtocols(Array.isArray(p.protocols) ? p.protocols : []);
      setRuns(Array.isArray(r.experiments) ? r.experiments : []);
      setError('');
      setRefreshed(Date.now());
    } catch (e) {
      if (id === requestId.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10000);
    return () => {
      clearInterval(interval);
      requestId.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  useEffect(() => setCursor(0), [query]);
  const health = live?.health,
    shadow = health?.shadow,
    engine = shadow?.engine;
  const connected =
    health && Date.now() - health.ts < 30000 && health.connected;
  const events = (live?.events ?? []).filter(
    (e: Dict) => filter === 'ALL' || e.kind === filter,
  );
  const matches = VIEWS.filter((v) =>
    v.id.toLowerCase().includes(query.toLowerCase()),
  );
  const view = VIEWS.find((v) => v.id === tab)!;
  const navigate = (v: View) => {
    setTab(v);
    setPalette(false);
    setQuery('');
  };
  const inspectProtocol = async (id: string) => {
    try {
      showDetail(await read(`protocols/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const inspectRun = async (id: string) => {
    const version = ++runRequestId.current;
    setRunLoading(true);
    setSelectedId(id);
    setSelected(null);
    try {
      const r = await read(`experiments/${id}`);
      if (version === runRequestId.current) {
        setSelected(r);
        setError('');
      }
    } catch (e) {
      if (version === runRequestId.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === runRequestId.current) setRunLoading(false);
    }
  };
  const funnel: Record<string, number> | undefined = engine?.funnel;
  const metrics = selected?.metrics;
  return (
    <MotionConfig reducedMotion="user">
      <div className="workspace">
        <a href="#main" className="skip-link">
          Skip to research
        </a>
        <aside className="workspace-rail">
          <Brand href="#main" />
          <div className="workspace-label">
            <span className="workspace-avatar">
              <FlaskConical size={16} aria-hidden />
            </span>
            <div>
              <strong>Research workspace</strong>
              <span>Local environment</span>
            </div>
            <ChevronRight size={14} aria-hidden />
          </div>
          <p className="rail-section-label">WORKSPACE</p>
          <nav className="workspace-nav" aria-label="Research views">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                aria-current={tab === v.id ? 'page' : undefined}
                onClick={() => navigate(v.id)}
                className={cn('nav-item', tab === v.id && 'is-active')}
              >
                <v.icon size={18} aria-hidden />
                <span>{v.id}</span>
                {tab === v.id && (
                  <span className="nav-active-dot" aria-hidden />
                )}
              </button>
            ))}
          </nav>
          <div className="rail-bottom">
            <div className="paper-mode">
              <ShieldCheck size={17} aria-hidden />
              <div>
                <strong>Paper research</strong>
                <span>Exchange execution disabled</span>
              </div>
            </div>
            <a
              href="https://github.com/jayasaisrikar/project-crosswake"
              target="_blank"
              rel="noreferrer"
              className="rail-repo"
            >
              Open repository
              <ArrowUpRight size={14} aria-hidden />
            </a>
            <div className="rail-credit">CROSSWAKE / RESEARCH LAB</div>
          </div>
        </aside>
        <div className="workspace-body">
          <header className="workspace-topbar">
            <div className="breadcrumb">
              <span>Workspace</span>
              <ChevronRight size={13} aria-hidden />
              <strong>{tab}</strong>
            </div>
            <button
              ref={searchButtonRef}
              className="search-pill"
              onClick={() => setPalette(true)}
            >
              <Search size={15} aria-hidden />
              <span>Find a view</span>
              <kbd>⌘ K</kbd>
            </button>
          </header>
          <main id="main" className="workspace-main" tabIndex={-1}>
            <div className="workspace-heading">
              <div>
                <p className="eyebrow">{view.caption}</p>
                <h1>{view.title}</h1>
                <p className="page-description">{view.description}</p>
              </div>
              <div className="page-actions">
                <Status
                  good={!!connected}
                  waiting={!connected}
                  label={
                    connected
                      ? 'Feed connected'
                      : health
                        ? 'Feed unavailable'
                        : 'Waiting for feed'
                  }
                />
                <Button
                  variant="outline"
                  disabled={loading}
                  onClick={() => void refresh()}
                  className="refresh-button"
                >
                  <RefreshCw
                    size={14}
                    className={cn(loading && 'animate-spin')}
                    aria-hidden
                  />
                  {loading ? 'Refreshing' : 'Refresh'}
                </Button>
              </div>
            </div>
            <div className="data-caption">
              <span>
                <Clock3 size={12} aria-hidden />
                Last refresh {time(refreshed)} IST
              </span>
              <span>
                Binance Spot<span className="caption-separator">/</span>
                Long-only paper
              </span>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <Activity size={18} aria-hidden />
                <div>
                  <strong>Evidence unavailable</strong>
                  <p>
                    {error}
                    {live
                      ? ' The last successful snapshot is shown below.'
                      : ''}
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  Retry
                </Button>
              </div>
            )}
            {!live && loading ? (
              <div
                className="initial-loading"
                role="status"
                aria-label="Loading local evidence"
              >
                <Skeleton className="h-32" />
                <div className="grid gap-6 md:grid-cols-2">
                  <Skeleton className="h-80" />
                  <Skeleton className="h-80" />
                </div>
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={tab}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                >
                  {tab === 'Market' && (
                    <MarketView
                      data={trend}
                      onInspect={(x) => showDetail(x)}
                    />
                  )}
                  {tab === 'Hyperliquid' && <HyperliquidView />}
                  {tab === 'Backtest lab' && <BacktestLab />}
                  {tab === 'Trade signals' && (
                    <div className="residual-surface">
                      <TradeSignals
                        data={signals}
                        research={research}
                        onInspect={(x) => showDetail(x as Dict)}
                        onFillRecorded={() => void refresh()}
                      />
                    </div>
                  )}
                  {tab === 'Strategy lab' && (
                    <div className="residual-surface">
                      <StrategyLab
                        data={research}
                        onInspect={(x) => showDetail(x as Dict)}
                      />
                    </div>
                  )}
                  {tab === 'Overview' && (
                    <>
                      <div className="metric-strip">
                        <Metric
                          label="Research seconds"
                          value={rolling(shadow?.steps)}
                          note="Closed market-data buckets"
                          icon={Clock3}
                        />
                        <Metric
                          label="Candidates evaluated"
                          value={rolling(shadow?.candidates)}
                          note="Accepted and rejected observations"
                          icon={Signal}
                        />
                        <Metric
                          label="Closed paper trades"
                          value={rolling(shadow?.closedTrades)}
                          note="Recorded simulated outcomes"
                          icon={ArrowUpRight}
                        />
                        <Metric
                          label="Open positions"
                          value={rolling(shadow?.openPositions)}
                          note="Current simulated exposure"
                          icon={Layers}
                        />
                      </div>
                      <div className="overview-grid">
                        <div className="overview-primary">
                          <Card className="research-panel">
                            <CardHeader className="panel-heading">
                              <div>
                                <CardTitle>Market watch</CardTitle>
                                <CardDescription>
                                  The declared collection universe
                                </CardDescription>
                              </div>
                              <Badge variant="outline">SPOT</Badge>
                            </CardHeader>
                            <CardContent className="asset-list">
                              {health?.symbols?.length ? (
                                health.symbols.map((s: string, i: number) => (
                                  <div key={s} className="asset-row">
                                    <span
                                      className={cn(
                                        'coin-mark',
                                        i === 0 ? 'coin-btc' : 'coin-alt',
                                      )}
                                    >
                                      {s.startsWith('BTC')
                                        ? '₿'
                                        : s.replace('USDT', '').slice(0, 1)}
                                    </span>
                                    <div className="asset-name">
                                      <strong>
                                        {s.replace('USDT', '')}
                                        <span>/ USDT</span>
                                      </strong>
                                      <small>
                                        {s === 'BTCUSDT'
                                          ? 'Reference market'
                                          : 'Transmission candidate'}
                                      </small>
                                    </div>
                                    <Status
                                      good={!!connected}
                                      waiting={!connected}
                                      label={
                                        connected
                                          ? 'Collecting'
                                          : 'Feed unavailable'
                                      }
                                    />
                                    <button
                                      className="asset-action"
                                      aria-label={`Inspect ${s} collection evidence`}
                                      onClick={() =>
                                        showDetail({
                                          symbol: s,
                                          collectorHealth: health,
                                          researchStatus: live?.researchStatus,
                                        })
                                      }
                                    >
                                      <ArrowUpRight size={16} aria-hidden />
                                    </button>
                                  </div>
                                ))
                              ) : (
                                <Empty
                                  title="Waiting for market data"
                                  body="Start the collector to see the declared assets and feed status."
                                  action={
                                    <Button
                                      variant="outline"
                                      onClick={() => void refresh()}
                                    >
                                      Check feed
                                    </Button>
                                  }
                                />
                              )}
                            </CardContent>
                            <div className="panel-footnote">
                              <Database size={13} aria-hidden />
                              Quote-backed observations. Prices are shown only
                              in recorded evidence.
                            </div>
                          </Card>
                          <Card className="research-panel">
                            <CardHeader className="panel-heading">
                              <div>
                                <CardTitle>Collection health</CardTitle>
                                <CardDescription>
                                  Receipt timing and continuity stay visible
                                </CardDescription>
                              </div>
                              <Activity
                                size={18}
                                className="text-muted-foreground"
                                aria-hidden
                              />
                            </CardHeader>
                            <CardContent>
                              <dl className="health-grid">
                                {[
                                  ['Last message', time(health?.lastMessageAt)],
                                  [
                                    'Closure allowance',
                                    typeof health?.latenessMs === 'number'
                                      ? `${number(health.latenessMs / 1000)} s`
                                      : '—',
                                  ],
                                  ['Late market events', number(health?.late)],
                                  [
                                    'Rejected payloads',
                                    number(health?.rejected),
                                  ],
                                  ['Queue pending', number(health?.pending)],
                                  [
                                    'Memory',
                                    typeof health?.memoryBytes === 'number'
                                      ? `${number(health.memoryBytes / 1048576)} MB`
                                      : '—',
                                  ],
                                  [
                                    'Recovered steps',
                                    number(health?.recoveredPaperSteps),
                                  ],
                                  [
                                    'Maximum data delay',
                                    typeof engine?.maxDataDelayMs === 'number'
                                      ? `${number(engine.maxDataDelayMs)} ms`
                                      : '—',
                                  ],
                                ].map(([label, value]) => (
                                  <div key={label}>
                                    <dt>{label}</dt>
                                    <dd>{value}</dd>
                                  </div>
                                ))}
                              </dl>
                            </CardContent>
                          </Card>
                          <Card className="research-panel">
                            <CardHeader className="panel-heading">
                              <div>
                                <CardTitle>Frozen protocols</CardTitle>
                                <CardDescription>
                                  Declared before evaluating unseen periods
                                </CardDescription>
                              </div>
                              <FlaskConical
                                size={18}
                                className="text-muted-foreground"
                                aria-hidden
                              />
                            </CardHeader>
                            <CardContent className="protocol-list">
                              {protocols.length ? (
                                protocols.map((id) => (
                                  <button
                                    key={id}
                                    onClick={() => void inspectProtocol(id)}
                                    className="protocol-row"
                                  >
                                    <span className="protocol-icon">
                                      <FileJson size={17} aria-hidden />
                                    </span>
                                    <span>
                                      <strong>Protocol {id}</strong>
                                      <small>
                                        Inspect configuration and evaluation
                                        clocks
                                      </small>
                                    </span>
                                    <ArrowUpRight size={16} aria-hidden />
                                  </button>
                                ))
                              ) : (
                                <p className="unavailable-note">
                                  No registered protocols are available.
                                </p>
                              )}
                            </CardContent>
                          </Card>
                        </div>
                        <div className="overview-secondary">
                          <MinimalCard className="readiness-panel">
                            <div className="readiness-icon">
                              <ShieldCheck size={24} aria-hidden />
                            </div>
                            <p className="eyebrow">Research status</p>
                            <h2>Evidence in progress.</h2>
                            <p>
                              Performance remains unvalidated. A passing
                              software check is the start of the research.
                            </p>
                            <ol className="validation-steps">
                              {[
                                [
                                  'Collect sufficient history',
                                  'Complete coverage and reliable quote timing.',
                                ],
                                [
                                  'Evaluate unseen periods',
                                  'Frozen selection, costs and statistical checks.',
                                ],
                                [
                                  'Reconcile forward paper',
                                  'Confirm what survives real observation.',
                                ],
                              ].map(([title, body], i) => (
                                <li key={title}>
                                  <span>{String(i + 1).padStart(2, '0')}</span>
                                  <div>
                                    <strong>{title}</strong>
                                    <p>{body}</p>
                                  </div>
                                </li>
                              ))}
                            </ol>
                            <Button
                              variant="outline"
                              onClick={() => navigate('Experiments')}
                            >
                              Explore experiments
                              <ArrowRight size={14} aria-hidden />
                            </Button>
                          </MinimalCard>
                          <Card className="research-panel">
                            <CardHeader>
                              <CardTitle>Signal readiness</CardTitle>
                              <CardDescription>
                                Fitted assets{' '}
                                <strong className="text-foreground">
                                  {number(engine?.relationshipCount)}
                                </strong>
                              </CardDescription>
                            </CardHeader>
                            <CardContent>
                              {funnel ? (
                                <dl className="funnel-list">
                                  {Object.entries(funnel)
                                    .filter(([, count]) => count > 0)
                                    .map(([reason, count]) => (
                                      <div key={reason}>
                                        <dt>{human(reason)}</dt>
                                        <dd>{number(count)}</dd>
                                      </div>
                                    ))}
                                </dl>
                              ) : (
                                <p className="unavailable-note">
                                  Filter diagnostics are unavailable in this
                                  session.
                                </p>
                              )}
                              <p className="quiet-note">
                                Counts can overlap. Scores are heuristics, not
                                win probabilities.
                              </p>
                            </CardContent>
                          </Card>
                        </div>
                      </div>
                    </>
                  )}
                  {tab === 'Signals' && (
                    <section aria-label="Current session decisions">
                      <div className="ledger-summary">
                        <div>
                          <span className="section-kicker">SESSION LEDGER</span>
                          <h2>Every signal has a record.</h2>
                        </div>
                        <div className="ledger-totals">
                          <span>
                            <strong>{number(live?.counts?.candidate)}</strong>{' '}
                            candidates
                          </span>
                          <span>
                            <strong>{number(live?.counts?.entry)}</strong>{' '}
                            entries
                          </span>
                          <span>
                            <strong>{number(live?.counts?.trade)}</strong>{' '}
                            closed
                          </span>
                        </div>
                      </div>
                      <Card className="research-panel ledger-panel">
                        <div className="ledger-toolbar">
                          <span>
                            <Signal size={16} aria-hidden />
                            Recent decisions{' '}
                            <Badge variant="secondary">{events.length}</Badge>
                          </span>
                          <div className="filter-control">
                            <Label htmlFor="event-filter">
                              <SlidersHorizontal size={14} aria-hidden />
                              <span>Event type</span>
                            </Label>
                            <NativeSelect
                              id="event-filter"
                              value={filter}
                              onChange={(e) => setFilter(e.target.value)}
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
                          <Empty
                            icon={Signal}
                            title="No matching decisions yet"
                            body={
                              filter === 'ALL'
                                ? 'The engine needs sufficient history and a qualifying BTC impulse. Empty samples have no win-rate estimate.'
                                : 'This event type has no recent records. Try all events.'
                            }
                            action={
                              <Button
                                variant="outline"
                                onClick={() =>
                                  filter === 'ALL'
                                    ? void refresh()
                                    : setFilter('ALL')
                                }
                              >
                                {filter === 'ALL'
                                  ? 'Refresh ledger'
                                  : 'Show all events'}
                              </Button>
                            }
                          />
                        ) : (
                          <div className="decision-list">
                            <div className="decision-columns" aria-hidden>
                              <span>Asset / event</span>
                              <span>Time · IST</span>
                              <span>Decision evidence</span>
                              <span>Inspect</span>
                            </div>
                            {events.map((e: Dict, i: number) => {
                              const c = e.candidate ?? e;
                              const negative =
                                c.accepted === false ||
                                e.kind === 'entry_rejection';
                              return (
                                <button
                                  className="decision-row"
                                  key={`${c.id ?? c.signalId}-${i}`}
                                  onClick={() => showDetail(e)}
                                  aria-label={`Inspect ${text(c.symbol)} ${human(text(e.kind))} evidence`}
                                >
                                  <span className="decision-asset">
                                    <span className="decision-icon">
                                      {negative ? (
                                        <ArrowDownRight size={17} aria-hidden />
                                      ) : (
                                        <ArrowUpRight size={17} aria-hidden />
                                      )}
                                    </span>
                                    <span>
                                      <strong>{text(c.symbol)}</strong>
                                      <small>
                                        {human(text(e.kind))} ·{' '}
                                        {text(c.side ?? 'LONG')}
                                      </small>
                                    </span>
                                  </span>
                                  <span className="decision-time">
                                    {time(c.ts ?? c.entryTs ?? c.exitTs)}
                                  </span>
                                  <span className="decision-evidence">
                                    <Badge
                                      variant={
                                        negative ? 'outline' : 'secondary'
                                      }
                                    >
                                      {negative
                                        ? 'Rejected'
                                        : e.kind === 'candidate'
                                          ? 'Candidate'
                                          : e.kind === 'trade'
                                            ? 'Closed'
                                            : 'Paper entry'}
                                    </Badge>
                                    <span>
                                      {c.reasons?.map(human).join(' · ') ||
                                        human(
                                          c.reason ||
                                            c.exitReason ||
                                            'Paper observation',
                                        )}
                                    </span>
                                    {typeof c.netReturnBps === 'number' && (
                                      <strong
                                        className={
                                          c.netReturnBps > 0
                                            ? 'text-success'
                                            : 'text-destructive'
                                        }
                                      >
                                        {number(c.netReturnBps)} bps net
                                      </strong>
                                    )}
                                  </span>
                                  <span className="decision-inspect">
                                    <ArrowUpRight size={17} aria-hidden />
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </Card>
                      <p className="quiet-note">
                        Up to 100 recent material events. Short observations
                        remain research-only.
                      </p>
                    </section>
                  )}
                  {tab === 'Experiments' && (
                    <section aria-label="Saved experiment runs">
                      <div className="experiment-layout">
                        <Card className="research-panel experiment-index">
                          <CardHeader className="panel-heading">
                            <div>
                              <CardTitle>Experiment library</CardTitle>
                              <CardDescription>
                                Completed, integrity-checked reports
                              </CardDescription>
                            </div>
                            <Badge variant="outline">{runs.length}</Badge>
                          </CardHeader>
                          <CardContent>
                            {runs.length ? (
                              <div className="run-list">
                                {runs.map((id) => (
                                  <button
                                    key={id}
                                    onClick={() => void inspectRun(id)}
                                    className={cn(
                                      'run-item',
                                      selectedId === id && 'selected',
                                    )}
                                  >
                                    <FlaskConical size={18} aria-hidden />
                                    <span>
                                      <strong>{id}</strong>
                                      <small>View computed evidence</small>
                                    </span>
                                    <ChevronRight size={15} aria-hidden />
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <Empty
                                icon={FlaskConical}
                                title="No completed experiments"
                                body="Evaluate a frozen protocol when its required data window is available. Failed runs remain available for audit."
                                action={
                                  <Button
                                    variant="outline"
                                    onClick={() => void refresh()}
                                  >
                                    Refresh library
                                  </Button>
                                }
                              />
                            )}
                          </CardContent>
                          <ExperimentLauncher
                            protocols={protocols}
                            onFinished={refresh}
                          />
                          <div className="protocol-index">
                            <p className="eyebrow">Available protocols</p>
                            {protocols.length ? (
                              protocols.map((id) => (
                                <button
                                  key={id}
                                  onClick={() => void inspectProtocol(id)}
                                >
                                  Protocol {id}
                                  <ArrowUpRight size={14} aria-hidden />
                                </button>
                              ))
                            ) : (
                              <p className="unavailable-note">
                                No registered protocols.
                              </p>
                            )}
                          </div>
                        </Card>
                        <div className="experiment-detail">
                          {runLoading ? (
                            <div role="status" aria-label="Loading experiment">
                              <Skeleton className="h-80" />
                            </div>
                          ) : selected ? (
                            <>
                              <div className="experiment-title">
                                <p className="eyebrow">Unseen block summary</p>
                                <h2>{selectedId}</h2>
                                <Badge variant="outline">
                                  Research evidence
                                </Badge>
                              </div>
                              <div className="experiment-metrics">
                                <Metric
                                  label="Closed long trades"
                                  value={rolling(metrics?.closedTrades)}
                                  note="Eligible closed positions"
                                  icon={Layers}
                                />
                                <Metric
                                  label="Net win rate"
                                  value={percent(metrics?.winRate)}
                                  note="After configured trading costs"
                                  icon={Activity}
                                />
                                <Metric
                                  label="Net expectancy"
                                  value={
                                    typeof metrics?.netExpectancyBps ===
                                    'number'
                                      ? `${number(metrics.netExpectancyBps)} bps`
                                      : '—'
                                  }
                                  note="Average net return per trade"
                                  icon={ArrowUpRight}
                                />
                                <Metric
                                  label="Profit factor"
                                  value={number(metrics?.profitFactor)}
                                  note="Net gains / net losses"
                                  icon={FlaskConical}
                                />
                              </div>
                              <Card className="research-panel">
                                <CardHeader>
                                  <CardTitle>Evidence assessment</CardTitle>
                                </CardHeader>
                                <CardContent>
                                  <div
                                    className="assessment"
                                    data-passed={!!selected.gate?.passed}
                                  >
                                    <ShieldCheck size={20} aria-hidden />
                                    <div>
                                      <strong>
                                        {selected.gate?.passed
                                          ? 'Statistical checks passed'
                                          : 'Evidence is insufficient or failed'}
                                      </strong>
                                      <p>
                                        {selected.gate?.passed
                                          ? 'Holdout and forward-paper confirmation are still required.'
                                          : 'Check the reasons below before treating this run as strategy evidence.'}
                                      </p>
                                    </div>
                                  </div>
                                  {!!selected.gate?.reasons?.length && (
                                    <ul className="gate-reasons">
                                      {selected.gate.reasons.map(
                                        (s: string) => (
                                          <li key={s}>
                                            <span
                                              className="status-dot"
                                              aria-hidden
                                            />
                                            {human(s)}
                                          </li>
                                        ),
                                      )}
                                    </ul>
                                  )}
                                  <Button
                                    variant="outline"
                                    onClick={() => showDetail(selected)}
                                  >
                                    Inspect provenance
                                    <ArrowUpRight size={14} aria-hidden />
                                  </Button>
                                </CardContent>
                              </Card>
                            </>
                          ) : (
                            <div className="experiment-placeholder">
                              <FlaskConical
                                size={34}
                                strokeWidth={1.2}
                                aria-hidden
                              />
                              <h2>Select an experiment.</h2>
                              <p>
                                Its outcomes, cost assumptions, and statistical
                                checks will appear here.
                              </p>
                              <span className="quiet-note">
                                A missing result is not a zero-return result.
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  )}
                  {tab === 'Context' && (
                    <section aria-label="altFINS cache">
                      <div className="context-layout">
                        <MinimalCard className="context-feature">
                          <div className="context-feature-top">
                            <span className="context-provider">
                              <Radio size={20} aria-hidden />
                              altFINS
                            </span>
                            <Badge variant="outline">SUPPLEMENTARY</Badge>
                          </div>
                          <h2>
                            A wider view.
                            <br />A separate layer.
                          </h2>
                          <p>
                            Market context adds perspective to recorded price
                            movements. Its contribution to the strategy needs
                            its own unseen evaluation.
                          </p>
                          <div className="context-status">
                            <Status
                              good={live?.context?.status === 'available'}
                              waiting={live?.context?.status !== 'available'}
                              label={text(
                                live?.context?.status ?? 'Unavailable',
                              )}
                            />
                            <strong>
                              {live?.context?.snapshot
                                ? 'Timestamped snapshot available'
                                : 'Waiting for a context snapshot'}
                            </strong>
                          </div>
                          {live?.context?.snapshot ? (
                            <Button
                              variant="outline"
                              onClick={() => showDetail(live.context.snapshot)}
                            >
                              Inspect snapshot
                              <ArrowUpRight size={14} aria-hidden />
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              onClick={() => void refresh()}
                            >
                              Check availability
                              <RefreshCw size={14} aria-hidden />
                            </Button>
                          )}
                        </MinimalCard>
                        <div className="context-side">
                          <Card className="research-panel">
                            <CardHeader>
                              <CardTitle>Snapshot provenance</CardTitle>
                              <CardDescription>
                                Availability starts at retrieval
                              </CardDescription>
                            </CardHeader>
                            <CardContent>
                              <dl className="context-facts">
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
                                  [
                                    'Status',
                                    text(
                                      live?.context?.status ?? 'Unavailable',
                                    ),
                                  ],
                                ].map(([k, v]) => (
                                  <div key={k}>
                                    <dt>{k}</dt>
                                    <dd>{v}</dd>
                                  </div>
                                ))}
                              </dl>
                            </CardContent>
                          </Card>
                          <div className="context-note">
                            <Clock3 size={19} aria-hidden />
                            <div>
                              <h3>Time matters.</h3>
                              <p>
                                A later download cannot become past evidence.
                                Expired snapshots stay visible as expired.
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </section>
                  )}
                  {tab === 'Data' && (
                    <DataWorkbench
                      dataset={dataset}
                      backtests={backtests}
                      onInspect={showDetail}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            )}
            <footer className="workspace-footer">
              <span>
                <span className="status-dot" aria-hidden />
                Local research workspace
              </span>
              <span>
                Evidence first<span className="caption-separator">/</span>
                Execution disabled
              </span>
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
            className="search-dialog"
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              searchButtonRef.current?.focus({ preventScroll: true });
            }}
            onKeyDown={(e) => {
              if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
              e.preventDefault();
              if (!matches.length) return;
              if (e.key === 'Enter') {
                navigate(matches[cursor]?.id ?? matches[0]!.id);
                return;
              }
              setCursor(
                (cursor + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) %
                  matches.length,
              );
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Find a research view</AlertDialogTitle>
              <AlertDialogDescription>
                Search the workspace. Use ↑ ↓ to move and Enter to open.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <button
              className="dialog-dismiss"
              aria-label="Close search"
              onClick={() => setPalette(false)}
            >
              <X size={18} aria-hidden />
            </button>
            <Label htmlFor="view-search" className="sr-only">
              Search research views
            </Label>
            <div className="command-input">
              <Search size={18} aria-hidden />
              <Input
                id="view-search"
                role="combobox"
                aria-expanded={palette}
                autoFocus
                placeholder="Search views…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-controls="view-options"
                aria-activedescendant={
                  matches[cursor]
                    ? `view-option-${matches[cursor]!.id}`
                    : undefined
                }
              />
              <kbd>ESC</kbd>
            </div>
            <div
              id="view-options"
              role="listbox"
              aria-label="Research views"
              className="command-results"
            >
              {matches.length ? (
                matches.map((v, i) => (
                  <button
                    key={v.id}
                    id={`view-option-${v.id}`}
                    role="option"
                    aria-selected={i === cursor}
                    className={cn('command-result', i === cursor && 'selected')}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => navigate(v.id)}
                  >
                    <v.icon size={19} aria-hidden />
                    <span>
                      <strong>{v.id}</strong>
                      <small>{v.caption}</small>
                    </span>
                    <ArrowRight size={15} aria-hidden />
                  </button>
                ))
              ) : (
                <p className="command-empty">
                  No matching views. Try “Signals” or “Context”.
                </p>
              )}
            </div>
            <div className="command-footer">
              <Command size={13} aria-hidden />
              Research workspace<span>{VIEWS.length} views</span>
            </div>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={detail !== null}
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
        >
          <AlertDialogContent
            className="evidence-dialog"
            onCloseAutoFocus={(e) => {
              const opener = detailOpenerRef.current;
              if (opener?.isConnected) {
                e.preventDefault();
                opener.focus({ preventScroll: true });
              }
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Research evidence</AlertDialogTitle>
              <AlertDialogDescription>
                Recorded values and their provenance.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <button
              className="dialog-dismiss"
              aria-label="Close evidence"
              onClick={() => setDetail(null)}
            >
              <X size={18} aria-hidden />
            </button>
            <div className="inspector-body">
              {detail && <EvidenceDetails record={detail} />}
            </div>
            <div className="inspector-footer">
              <span>
                <ShieldCheck size={14} aria-hidden />
                Read-only record
              </span>
              <Button
                autoFocus
                variant="outline"
                onClick={() => setDetail(null)}
              >
                Close
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </MotionConfig>
  );
}
