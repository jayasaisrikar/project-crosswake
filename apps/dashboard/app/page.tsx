'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
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
    [query, setQuery] = useState('');
  const evidenceDialog = useRef<HTMLDialogElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null);
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
    if (palette) {
      dialog.current?.showModal();
      search.current?.focus();
    } else dialog.current?.close();
  }, [palette]);
  useEffect(() => {
    if (detail) evidenceDialog.current?.showModal();
    else evidenceDialog.current?.close();
  }, [detail]);
  const health = live?.health,
    shadow = health?.shadow,
    fresh = health && Date.now() - health.ts < 30000,
    connected = fresh && health.connected;
  const events = (live?.events ?? []).filter(
    (e: Dict) => filter === 'ALL' || e.kind === filter,
  );
  const destinations = ['Overview', 'Signals', 'Experiments', 'Context'];
  const navigate = (value: string) => {
    setTab(value);
    setPalette(false);
    setQuery('');
  };
  return (
    <div className="workbench">
      <a className="skip" href="#main">
        Skip to research
      </a>
      <aside className="rail">
        <a href="#main" className="brand">
          <span className="brandmark">↗</span> crosswake
          <span className="brand-note">RESEARCH WORKBENCH</span>
        </a>
        <nav aria-label="Research views">
          {destinations.map((x, i) => (
            <button
              key={x}
              aria-current={tab === x ? 'page' : undefined}
              className={tab === x ? 'active' : ''}
              onClick={() => setTab(x)}
            >
              <span className="nav-number">0{i + 1}</span>
              {x}
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <span className="tag">BINANCE SPOT</span>
          <p>
            Long-only paper validation.
            <br />
            Short signals for research.
          </p>
          <button className="command" onClick={() => setPalette(true)}>
            Find a view <kbd>⌘ K</kbd>
          </button>
        </div>
      </aside>
      <div className="canvas">
        <header className="toolbar">
          <span>
            Research / <strong>{tab}</strong>
          </span>
          <div>
            <span className={`status ${connected ? 'connected' : ''}`}>
              {connected
                ? 'Collecting'
                : health
                  ? 'Feed unavailable'
                  : 'Waiting for collector'}
            </span>
            <button
              className="button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? 'Refreshing…' : 'Refresh evidence'}
            </button>
          </div>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">BTC → ALTCOIN TRANSMISSION</p>
              <h1>
                {tab === 'Overview'
                  ? 'Follow the evidence.'
                  : tab === 'Signals'
                    ? 'Inspect every decision.'
                    : tab === 'Experiments'
                      ? 'Compare research runs.'
                      : 'Higher-timeframe context.'}
              </h1>
              <p>
                {tab === 'Overview'
                  ? 'A live view of collection and research readiness. Strategy performance remains unvalidated.'
                  : tab === 'Signals'
                    ? 'Candidates, entries and rejection reasons from the current paper session.'
                    : tab === 'Experiments'
                      ? 'Computed reports from frozen protocols. An incomplete run is not performance evidence.'
                      : 'Timestamped altFINS observations. Missing or stale context stays unavailable.'}
              </p>
            </div>
            <div className="updated">
              <span>LAST REFRESH · IST</span>
              <strong>{time(refreshed)}</strong>
            </div>
          </div>
          {error && (
            <div className="notice" role="alert">
              <strong>Evidence could not be refreshed.</strong>
              <p>{error}</p>
              <button
                className="button"
                onClick={() => void refresh()}
                disabled={loading}
              >
                Try refresh
              </button>
            </div>
          )}
          {!error && loading && !live && (
            <div role="status" className="empty">
              Loading local evidence…
            </div>
          )}
          {tab === 'Overview' && (
            <>
              <section
                className="instrument"
                aria-label="Collection measurements"
              >
                <div className="lead-reading">
                  <span>Closed research seconds</span>
                  <strong>{number(shadow?.steps)}</strong>
                  <p>
                    {shadow?.mode
                      ? 'Adaptive paper observation'
                      : 'No active paper session'}
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>Accepted candidates</dt>
                    <dd>{number(shadow?.candidates)}</dd>
                  </div>
                  <div>
                    <dt>Closed paper trades</dt>
                    <dd>{number(shadow?.closedTrades)}</dd>
                  </div>
                  <div>
                    <dt>Open positions</dt>
                    <dd>{number(shadow?.openPositions)}</dd>
                  </div>
                  <div>
                    <dt>Late market events</dt>
                    <dd>{number(health?.late)}</dd>
                  </div>
                </dl>
              </section>
              <div className="overview-grid">
                <section>
                  <h2>Collection health</h2>
                  <table>
                    <tbody>
                      {[
                        [
                          'Universe',
                          health?.symbols?.join(' · ') ?? 'No collector',
                        ],
                        ['Last market message', time(health?.lastMessageAt)],
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
                        <tr key={a}>
                          <th>{a}</th>
                          <td>{b}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
                <section className="readiness">
                  <h2>Validation readiness</h2>
                  <ol>
                    <li>
                      <span>01</span>
                      <div>
                        <strong>Collect sufficient history</strong>
                        <p>
                          The frozen protocol needs prospective coverage before
                          evaluation can begin.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>02</span>
                      <div>
                        <strong>Evaluate unseen periods</strong>
                        <p>
                          Walk-forward and one-use holdout results must meet
                          sample and confidence gates.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>03</span>
                      <div>
                        <strong>Reconcile forward paper</strong>
                        <p>
                          Confirm costs, missing quotes and session continuity
                          before considering execution.
                        </p>
                      </div>
                    </li>
                  </ol>
                  <p className="footnote">
                    No profitability claim. No exchange orders are enabled.
                  </p>
                </section>
              </div>
              <section className="protocol-strip">
                <div>
                  <h2>Frozen protocols</h2>
                  <p>Declared clocks and hypotheses, before selection.</p>
                </div>
                <div>
                  {protocols.length ? (
                    protocols.map((id) => (
                      <button
                        className="button"
                        key={id}
                        onClick={async () => {
                          try {
                            setDetail(await read(`protocols/${id}`));
                          } catch (e) {
                            setError(String(e));
                          }
                        }}
                      >
                        Inspect {id} ↗
                      </button>
                    ))
                  ) : (
                    <p>No registered protocols.</p>
                  )}
                </div>
              </section>
            </>
          )}
          {tab === 'Signals' && (
            <section>
              <div className="section-toolbar">
                <h2>Current session decisions</h2>
                <label>
                  Event type{' '}
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="ALL">All events</option>
                    <option value="candidate">Candidates</option>
                    <option value="entry">Entries</option>
                    <option value="trade">Closed trades</option>
                    <option value="entry_rejection">Entry rejections</option>
                  </select>
                </label>
              </div>
              {!events.length ? (
                <div className="empty">
                  <h3>No matching decisions yet.</h3>
                  <p>
                    The engine needs warm-up history and a qualifying BTC
                    impulse. Empty samples have no win-rate estimate.
                  </p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>Asset</th>
                        <th>Direction</th>
                        <th>Evidence</th>
                        <th>Inspect</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((e: Dict, i: number) => {
                        const c = e.candidate ?? e;
                        return (
                          <tr key={`${c.id ?? c.signalId}-${i}`}>
                            <td>{format(e.kind)}</td>
                            <td>{format(c.symbol)}</td>
                            <td>{format(c.side ?? 'LONG')}</td>
                            <td>
                              {c.reasons?.join(', ') ||
                                c.reason ||
                                c.exitReason ||
                                'Paper observation'}
                            </td>
                            <td>
                              <button
                                className="text-button"
                                onClick={() => setDetail(e)}
                              >
                                View evidence
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="footnote">
                Showing up to 100 recent material events. Short-side
                observations remain research-only.
              </p>
            </section>
          )}
          {tab === 'Experiments' && (
            <section>
              <div className="run-layout">
                <div>
                  <h2>Saved experiment runs</h2>
                  {runs.length ? (
                    runs.map((id) => (
                      <button
                        key={id}
                        className="run-row"
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
                      >
                        {id}
                        <span>Inspect →</span>
                      </button>
                    ))
                  ) : (
                    <div className="empty">
                      <h3>No completed research evidence yet.</h3>
                      <p>
                        Run a frozen protocol after its required data window is
                        available. Failed runs are retained for audit.
                      </p>
                    </div>
                  )}
                </div>
                <div>
                  {selected ? (
                    <>
                      <h2>Unseen block summary</h2>
                      <dl className="result-readings">
                        <div>
                          <dt>Closed long trades</dt>
                          <dd>{number(selected.metrics?.closedTrades)}</dd>
                        </div>
                        <div>
                          <dt>Net win rate</dt>
                          <dd>{percent(selected.metrics?.winRate)}</dd>
                        </div>
                        <div>
                          <dt>Net expectancy</dt>
                          <dd>
                            {number(selected.metrics?.netExpectancyBps)} bps
                          </dd>
                        </div>
                        <div>
                          <dt>Profit factor</dt>
                          <dd>{number(selected.metrics?.profitFactor)}</dd>
                        </div>
                      </dl>
                      <p className="notice">
                        {selected.gate?.passed
                          ? 'Statistical checks passed; holdout and forward paper still required.'
                          : 'Statistical evidence is insufficient or failed.'}
                      </p>
                      <ul>
                        {selected.gate?.reasons?.map((x: string) => (
                          <li key={x}>{x.replaceAll('_', ' ')}</li>
                        ))}
                      </ul>
                      <button
                        className="button"
                        onClick={() => setDetail(selected)}
                      >
                        Inspect provenance and limits
                      </button>
                    </>
                  ) : (
                    <p className="muted">
                      Choose a run to inspect its computed evidence.
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}
          {tab === 'Context' && (
            <section>
              <h2>altFINS cache</h2>
              <div className="context-layout">
                <div className="context-state">
                  <span className="tag">
                    {live?.context?.status ?? 'Unavailable'}
                  </span>
                  <h3>
                    {live?.context?.snapshot
                      ? 'A timestamped context snapshot is available.'
                      : 'Context has not been collected.'}
                  </h3>
                  <p>
                    Configure the subscription key locally and run the context
                    collector. Context availability begins when Crosswake
                    retrieves it; later downloads cannot become past evidence.
                  </p>
                </div>
                <dl>
                  {[
                    ['Provider', 'altFINS'],
                    ['Retrieved', time(live?.context?.snapshot?.retrievedAt)],
                    ['Expires', time(live?.context?.snapshot?.expiresAt)],
                    [
                      'Assets',
                      live?.context?.snapshot?.request?.symbols?.join(', ') ??
                        '—',
                    ],
                  ].map(([a, b]) => (
                    <div key={a}>
                      <dt>{a}</dt>
                      <dd>{b}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {live?.context?.snapshot && (
                <button
                  className="button"
                  onClick={() => setDetail(live.context.snapshot)}
                >
                  Inspect context and provenance
                </button>
              )}
            </section>
          )}
          <footer>
            <span>crosswake / local research</span>
            <span>Evidence first. Execution disabled.</span>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        onCancel={() => setPalette(false)}
        onClick={(e) => {
          if (e.target === dialog.current) setPalette(false);
        }}
        onKeyDown={(e) => {
          if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
          e.preventDefault();
          const buttons = [
            ...(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ??
              []),
          ];
          if (!buttons.length) return;
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            current < 0
              ? e.key === 'ArrowDown'
                ? 0
                : buttons.length - 1
              : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                buttons.length;
          buttons[next]?.focus();
        }}
        className="palette"
      >
        <h2>Find a research view</h2>
        <input
          ref={search}
          aria-label="Search research views"
          placeholder="Search views"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {destinations
          .filter((x) => x.toLowerCase().includes(query.toLowerCase()))
          .map((x) => (
            <button key={x} onClick={() => navigate(x)}>
              {x} <span>↗</span>
            </button>
          ))}
        <button onClick={() => setPalette(false)}>Close search</button>
      </dialog>
      <dialog
        ref={evidenceDialog}
        onCancel={() => setDetail(null)}
        onClick={(e) => {
          if (e.target === evidenceDialog.current) setDetail(null);
        }}
        aria-label="Research evidence"
        className="drawer"
      >
        {detail && (
          <>
            <div>
              <h2>Research evidence</h2>
              <button
                className="button"
                autoFocus
                onClick={() => setDetail(null)}
              >
                Close
              </button>
            </div>
            <pre tabIndex={0}>{JSON.stringify(detail, null, 2)}</pre>
          </>
        )}
      </dialog>
    </div>
  );
}
