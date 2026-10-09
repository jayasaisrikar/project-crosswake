'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// Hyperliquid venue view, exploratory backtest lab, and frozen-experiment launcher.
// All three talk to the local evidence API through /api/evidence.
type Dict = Record<string, any>;
const asset = (s: string) => s.replace(/USDT$/, '');
const pctBps = (x: unknown) =>
  typeof x === 'number' && Number.isFinite(x)
    ? `${x >= 0 ? '+' : '−'}${Math.abs(x / 100).toFixed(1)}%`
    : '—';
const tone = (x: unknown) =>
  typeof x === 'number' ? (x >= 0 ? 'up' : 'down') : '';
const price = (x: unknown) =>
  typeof x === 'number'
    ? x.toLocaleString('en-US', { maximumSignificantDigits: x >= 1 ? 6 : 4 })
    : '—';
const usd = (x: unknown) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  return a >= 1e9
    ? `$${(x / 1e9).toFixed(2)}B`
    : a >= 1e6
      ? `$${(x / 1e6).toFixed(1)}M`
      : `$${(x / 1e3).toFixed(0)}K`;
};
const day = (ts: unknown) =>
  typeof ts === 'number'
    ? new Date(ts).toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: '2-digit',
        timeZone: 'UTC',
      })
    : '—';

async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/evidence/${path}`, {
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      r.status === 503
        ? 'The evidence service is offline. Start it with pnpm research:api.'
        : String(data.error ?? `HTTP ${r.status}`).replaceAll('_', ' '),
    );
  return data;
}

function useApi(path: string, everyMs = 30_000) {
  const [data, setData] = useState<Dict | null>(null),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api(path));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { data, error, reload: load };
}

function Shell({
  name,
  tag,
  children,
}: {
  name: string;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mv">
      <div className="mv-bar">
        <span className="mv-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span>crosswake / {name}</span>
        <span className="mv-tag">{tag}</span>
      </div>
      <div className="mv-body">{children}</div>
    </div>
  );
}
function Kpi({
  label,
  value,
  note,
  good,
}: {
  label: string;
  value: string;
  note: string;
  good?: boolean;
}) {
  return (
    <div className={cn('mv-kpi', good && 'is-good')}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{note}</span>
    </div>
  );
}
function Panel({
  title,
  meta,
  children,
  footnote,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  footnote?: string;
}) {
  return (
    <section className="mv-panel">
      <header>
        <span>{title}</span>
        {meta && <span>{meta}</span>}
      </header>
      {children}
      {footnote && <p className="mv-note">{footnote}</p>}
    </section>
  );
}
function Problem({ error }: { error: string }) {
  return (
    <div className="mv-empty">
      <h3>Unavailable</h3>
      <p>{error}</p>
    </div>
  );
}

/** Line chart with optional horizontal reference. Values only; no smoothing. */
function LineChart({
  points,
  reference,
  referenceLabel,
  format,
  zero,
  step,
  label,
}: {
  points: { ts: number; v: number }[];
  reference?: number | null;
  referenceLabel?: string;
  format: (v: number) => string;
  zero?: boolean;
  step?: boolean;
  label: string;
}) {
  if (points.length < 2) return <p className="mv-quiet">Not enough data.</p>;
  // Wide viewBox so 11-unit text lands near 11px in a ~1000px panel.
  const W = 1000,
    H = 260,
    L = 8,
    R = 64,
    T = 12,
    B = 24;
  const vs = points.map((p) => p.v).concat(reference ?? [], zero ? [0] : []);
  const lo = Math.min(...vs),
    hi = Math.max(...vs),
    pad = (hi - lo || 1) * 0.06;
  const x0 = points[0]!.ts,
    x1 = points.at(-1)!.ts;
  const X = (t: number) => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R),
    Y = (v: number) => T + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * (H - T - B);
  // Step: a cumulative total only changes on the day a trade closes.
  const d = points
    .map((p, i) =>
      i
        ? `${step ? `H${X(p.ts).toFixed(1)}V` : `L${X(p.ts).toFixed(1)} `}${Y(p.v).toFixed(1)}`
        : `M${X(p.ts).toFixed(1)} ${Y(p.v).toFixed(1)}`,
    )
    .join('');
  const ticks = [lo, (lo + hi) / 2, hi];
  const last = points.at(-1)!;
  return (
    <svg
      className="rv-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className="rv-grid" />
          <text x={W - R + 8} y={Y(v) + 4} className="rv-axis">
            {format(v)}
          </text>
        </g>
      ))}
      {zero && (
        <line x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} className="rv-zero" />
      )}
      {typeof reference === 'number' && (
        <g>
          <line
            x1={L}
            x2={W - R}
            y1={Y(reference)}
            y2={Y(reference)}
            className="rv-ref"
          />
          <text x={L + 4} y={Y(reference) - 6} className="rv-ref-label">
            {referenceLabel}
          </text>
        </g>
      )}
      <path d={d} className={cn('rv-line', last.v < (zero ? 0 : points[0]!.v) && 'is-down')} />
      <circle cx={X(last.ts)} cy={Y(last.v)} r="3.5" className="rv-dot" />
      <text x={L} y={H - 6} className="rv-axis">
        {day(x0)}
      </text>
      <text x={W - R} y={H - 6} className="rv-axis" textAnchor="end">
        {day(x1)}
      </text>
    </svg>
  );
}

export function HyperliquidView() {
  const { data, error } = useApi('hyperliquid');
  if (error) return <Problem error={error} />;
  if (!data)
    return (
      <Shell name="hyperliquid" tag="loading">
        <p className="mv-quiet">Loading Hyperliquid data…</p>
      </Shell>
    );
  const hype: Dict = data.hype ?? {},
    check: Dict | null = data.venueCheck,
    markets: Dict[] = data.markets ?? [],
    listed = markets.filter((m) => m.listed);
  const bars: Dict[] = hype.bars ?? [];
  const broke = typeof hype.toHighBps === 'number' && hype.toHighBps >= 0;
  const hypeChecked: Dict | undefined = check?.checks?.find(
    (c: Dict) => c.symbol === 'HYPEUSDT',
  );
  return (
    <Shell name="hyperliquid" tag={`${data.plan} · read-only`}>
      <div className="mv-kpis">
        <Kpi
          label="HYPE close"
          value={hype.lastClose ? `$${price(hype.lastClose)}` : '—'}
          note={hype.source ? `${hype.source.pair} spot · last daily close` : 'No Hyperliquid source'}
        />
        <Kpi
          label="To 20-day breakout"
          value={broke ? 'Breakout' : pctBps(hype.toHighBps)}
          good={broke}
          note={
            hype.breakoutHigh
              ? `High of prior 20 closes: $${price(hype.breakoutHigh)}`
              : 'Needs 20 closed days'
          }
        />
        <Kpi
          label="HYPE perp funding"
          value={
            typeof hype.perp?.fundingAprPct === 'number'
              ? `${hype.perp.fundingAprPct.toFixed(1)}%`
              : '—'
          }
          note="Annualised, current hourly rate"
        />
        <Kpi
          label="Price check"
          value={check ? `${check.summary.checked - check.summary.flagged}/${check.summary.checked}` : '—'}
          good={!!check && check.summary.flagged === 0}
          note={
            check
              ? `Within ${check.thresholdBps} bps of Binance · to ${check.window.to}`
              : 'Run pnpm venue:check'
          }
        />
      </div>
      <Panel
        title="HYPE / USDC · daily close"
        meta={hype.liveEngineReporting ? (hype.openPosition ? 'v006 holding' : 'v006 watching') : 'v006 state not on this machine'}
        footnote={
          hype.amendment
            ? `Data source amended ${hype.amendment.date}: ${hype.amendment.change}`
            : undefined
        }
      >
        <LineChart
          label="HYPE daily closes with the 20-day breakout level"
          points={bars.map((b) => ({ ts: b.ts, v: b.close }))}
          reference={hype.breakoutHigh}
          referenceLabel="20-day breakout level"
          format={(v) => `$${v.toFixed(v >= 100 ? 0 : 1)}`}
        />
      </Panel>
      <div className="mv-split">
        <Panel
          title={`Perp markets · ${listed.length} of ${markets.length} v006 coins listed`}
          meta={data.contextsAvailable ? 'Live' : 'Hyperliquid unreachable'}
          footnote="Funding is the current hourly rate × 8760. Positive means longs pay shorts."
        >
          <div className="mv-scroll">
            <table>
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">Mark</th>
                  <th className="num">Funding APR</th>
                  <th className="num">Open interest</th>
                  <th className="num">24h volume</th>
                </tr>
              </thead>
              <tbody>
                {[...listed]
                  .sort((a, b) => b.openInterestUsd - a.openInterestUsd)
                  .map((m) => (
                    <tr key={m.symbol} className={m.symbol === 'HYPEUSDT' ? 'rv-hl' : undefined}>
                      <td>
                        <b>{m.coin}</b>
                      </td>
                      <td className="num">{price(m.markPx)}</td>
                      <td className={cn('num', tone(m.fundingAprPct))}>
                        {m.fundingAprPct.toFixed(1)}%
                      </td>
                      <td className="num">{usd(m.openInterestUsd)}</td>
                      <td className="num">{usd(m.dayVolumeUsd)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel
          title="Binance vs Hyperliquid closes"
          meta={check ? `${check.window.from} → ${check.window.to}` : undefined}
          footnote={
            check?.summary.missing?.length
              ? `Not on Hyperliquid: ${check.summary.missing.map(asset).join(', ')}.`
              : undefined
          }
        >
          {check ? (
            <div className="mv-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th className="num">Days</th>
                    <th className="num">Median</th>
                    <th className="num">Worst</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(check.checks as Dict[])
                    .filter((c) => c.status !== 'missing')
                    .sort((a, b) => b.maxAbsGapBps - a.maxAbsGapBps)
                    .map((c) => (
                      <tr key={c.symbol}>
                        <td>
                          <b>{asset(c.symbol)}</b>
                        </td>
                        <td className="num">{c.days}</td>
                        <td className="num">{c.medianGapBps.toFixed(1)} bps</td>
                        <td className="num">{c.maxAbsGapBps.toFixed(1)} bps</td>
                        <td>
                          <span className={`mv-chip is-${c.status === 'ok' ? 'go' : 'near'}`}>
                            {c.status === 'ok' ? 'OK' : 'Flagged'}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {hypeChecked && hypeChecked.days < 20 && (
                <p className="mv-note">
                  HYPE overlaps only {hypeChecked.days} days: Binance&apos;s HYPE
                  spot history is that short.
                </p>
              )}
            </div>
          ) : (
            <p className="mv-quiet">
              No price check yet. Run <code>pnpm venue:check</code>.
            </p>
          )}
        </Panel>
      </div>
    </Shell>
  );
}

const DEFAULTS = {
  breakoutDays: 20,
  breakdownDays: 10,
  regimeSmaDays: 100,
  costBpsRoundTrip: 30,
  from: '2025-01-01',
  to: new Date().toISOString().slice(0, 10),
};
const FIELDS: [keyof typeof DEFAULTS, string, string][] = [
  ['breakoutDays', 'Breakout days', 'Enter above the high of N closes'],
  ['breakdownDays', 'Breakdown days', 'Exit below the low of N closes'],
  ['regimeSmaDays', 'BTC filter days', 'Trade only while BTC > N-day avg'],
  ['costBpsRoundTrip', 'Cost (bps round trip)', 'Fees + slippage per trade'],
];

export function BacktestLab() {
  const list = useApi('sandbox', 120_000);
  const [form, setForm] = useState(DEFAULTS),
    [picked, setPicked] = useState<string[]>([]),
    [run, setRun] = useState<Dict | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const symbols: string[] = list.data?.symbols ?? [];
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api('sandbox', {
        ...form,
        ...(picked.length ? { symbols: picked } : {}),
      });
      setRun(r);
      void list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (id: string) => {
    try {
      setRun(await api(`sandbox/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const s: Dict | null = run?.stats ?? null;
  return (
    <Shell name="backtest-lab" tag="exploratory · not evidence">
      <div className="rv-warn">
        <strong>Exploratory only.</strong> These runs use data the strategy has
        already seen. Changing settings until the curve looks good is curve
        fitting, so no result here counts as evidence. A promising idea gets
        frozen as a new plan and tested on unseen data first.
      </div>
      <div className="mv-split">
        <Panel title="Rules" meta="Daily trend engine">
          <form
            className="rv-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {FIELDS.map(([k, label, hint]) => (
              <label key={k}>
                <span>
                  {label}
                  {form[k] !== DEFAULTS[k] && <em> · v005: {DEFAULTS[k]}</em>}
                </span>
                <input
                  type="number"
                  value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
                />
                <small>{hint}</small>
              </label>
            ))}
            <label>
              <span>From</span>
              <input
                type="date"
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
              />
            </label>
            <fieldset>
              <legend>
                Coins · {picked.length ? `${picked.length} picked` : `all ${symbols.length} with daily data`}
              </legend>
              <div className="rv-coins">
                {symbols
                  .filter((x) => x !== 'BTCUSDT')
                  .map((x) => (
                    <button
                      type="button"
                      key={x}
                      aria-pressed={picked.includes(x)}
                      onClick={() =>
                        setPicked(
                          picked.includes(x)
                            ? picked.filter((p) => p !== x)
                            : [...picked, x],
                        )
                      }
                    >
                      {asset(x)}
                    </button>
                  ))}
              </div>
            </fieldset>
            <div className="rv-actions">
              <button type="submit" className="rv-primary" disabled={busy}>
                {busy ? 'Running…' : 'Run backtest'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setForm(DEFAULTS);
                  setPicked([]);
                }}
              >
                Reset to v005
              </button>
            </div>
            {error && <p className="rv-error">{error}</p>}
          </form>
        </Panel>
        <Panel
          title="Past sandbox runs"
          meta={`${list.data?.runs?.length ?? 0} saved`}
          footnote="Every run is saved under data/sandbox, apart from frozen experiments."
        >
          {list.data?.runs?.length ? (
            <div className="mv-scroll">
              <table className="mv-log">
                <thead>
                  <tr>
                    <th>Ran</th>
                    <th>Changed</th>
                    <th className="num">Trades</th>
                    <th className="num">Avg net</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.data.runs as Dict[]).map((r) => (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      onClick={() => void open(r.id)}
                      onKeyDown={(k) => k.key === 'Enter' && void open(r.id)}
                    >
                      <td>{day(r.ranAt)}</td>
                      <td>
                        {r.differsFromV005.length
                          ? r.differsFromV005.join(', ')
                          : 'v005 rules'}
                      </td>
                      <td className="num">{r.stats?.trades ?? 0}</td>
                      <td className={cn('num', tone(r.stats?.netExpectancyBps))}>
                        {pctBps(r.stats?.netExpectancyBps)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mv-quiet">No runs yet.</p>
          )}
        </Panel>
      </div>
      {run && (
        <>
          <div className="mv-kpis">
            <Kpi label="Trades" value={String(s?.trades ?? 0)} note={`${run.input.from} → ${run.input.to}`} />
            <Kpi
              label="Win rate"
              value={s ? `${(s.winRate * 100).toFixed(0)}%` : '—'}
              note={s ? `Avg win ${pctBps(s.avgWinBps)} · loss ${pctBps(s.avgLossBps)}` : ''}
            />
            <Kpi
              label="Avg net per trade"
              value={pctBps(s?.netExpectancyBps)}
              good={!!s && s.ci95[0] > 0}
              note={s ? `95% range ${pctBps(s.ci95[0])} to ${pctBps(s.ci95[1])}` : ''}
            />
            <Kpi
              label="Profit factor"
              value={s && Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '—'}
              note={s ? `Avg hold ${s.avgHoldDays.toFixed(1)} days` : ''}
            />
          </div>
          <Panel
            title="Cumulative net return · sum of trades"
            meta={run.differsFromV005.length ? `Changed: ${run.differsFromV005.join(', ')}` : 'v005 rules'}
            footnote="Equal size per trade, summed by exit date, no compounding. A 95% range that includes zero means no proven edge."
          >
            <LineChart
              label="Cumulative net return of sandbox trades"
              points={(run.equity as Dict[]).map((p) => ({ ts: p.ts, v: p.cumBps / 100 }))}
              zero
              step
              format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`}
            />
          </Panel>
          <Panel title="By coin" meta={`${run.bySymbol.length} coins traded`}>
            <div className="rv-bars">
              {(run.bySymbol as Dict[]).slice(0, 30).map((b) => {
                const max = Math.max(...run.bySymbol.map((x: Dict) => Math.abs(x.netBps)), 1);
                return (
                  <div key={b.symbol} className="rv-bar">
                    <b>{asset(b.symbol)}</b>
                    <span>
                      <i
                        className={b.netBps < 0 ? 'is-down' : undefined}
                        style={{ width: `${(Math.abs(b.netBps) / max) * 100}%` }}
                      />
                    </span>
                    <em className={cn('num', tone(b.netBps))}>
                      {pctBps(b.netBps)} · {b.trades}
                    </em>
                  </div>
                );
              })}
            </div>
          </Panel>
        </>
      )}
    </Shell>
  );
}

export function ExperimentLauncher({
  protocols,
  onFinished,
}: {
  protocols: string[];
  onFinished: () => void;
}) {
  const { data, reload } = useApi('jobs', 5_000);
  const [pick, setPick] = useState(''),
    [error, setError] = useState('');
  const jobs: Dict[] = data?.jobs ?? [];
  const busy = !!data?.busy;
  const doneCount = jobs.filter((j) => j.status === 'complete').length;
  useEffect(() => {
    if (doneCount) onFinished();
  }, [doneCount, onFinished]);
  const start = async () => {
    setError('');
    try {
      await api('jobs', { protocolId: pick || protocols[0] });
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="rv-launch">
      <p className="eyebrow">Run a frozen protocol</p>
      <div className="rv-launch-row">
        <select
          value={pick || protocols[0] || ''}
          onChange={(e) => setPick(e.target.value)}
          aria-label="Protocol"
        >
          {protocols.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button
          className="rv-primary"
          disabled={busy || !protocols.length}
          onClick={() => void start()}
        >
          {busy ? 'Running…' : 'Run experiment'}
        </button>
      </div>
      <small>
        Same workflow as <code>pnpm research:experiment</code>. The protocol and
        data are hashed before the run; results can never be overwritten.
      </small>
      {error && <p className="rv-error">{error}</p>}
      {jobs.slice(0, 5).map((j) => (
        <details key={j.id} className="rv-job">
          <summary>
            <span className={`mv-chip is-${j.status === 'complete' ? 'go' : j.status === 'running' ? 'near' : 'off'}`}>
              {j.status}
            </span>
            {j.protocolId} · {day(j.startedAt)}
          </summary>
          {j.logTail && <pre>{j.logTail}</pre>}
        </details>
      ))}
    </div>
  );
}
