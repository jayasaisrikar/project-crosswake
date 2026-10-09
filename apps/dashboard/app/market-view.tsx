'use client';

import { cn } from '@/lib/utils';

// Daily trend (v005) at a glance: the BTC filter, the watchlist ranked by distance
// to the 20-day breakout, open paper positions and the signal log.
type Dict = Record<string, any>;
const DAY = 86_400_000;
const asset = (s: string) => s.replace(/USDT$/, '');
const pctBps = (x: unknown) =>
  typeof x === 'number' && Number.isFinite(x)
    ? `${x >= 0 ? '+' : '−'}${Math.abs(x / 100).toFixed(1)}%`
    : '—';
const price = (x: unknown) =>
  typeof x === 'number'
    ? x.toLocaleString('en-US', {
        maximumSignificantDigits: x >= 1 ? 6 : 4,
      })
    : '—';
const tone = (x: unknown) =>
  typeof x === 'number' ? (x >= 0 ? 'up' : 'down') : '';
const day = (ts: number) =>
  new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
const reasonLabel: Record<string, string> = {
  breakdown: '10-day low',
  regime: 'BTC filter off',
  open: 'Open',
};

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

function Spark({ up }: { up: boolean }) {
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      className={cn('mv-spark', !up && 'is-down')}
      aria-hidden
    >
      <path
        d={
          up
            ? 'M0 26L12 22L24 24L36 16L48 18L60 11L72 13L84 6L100 4'
            : 'M0 10L14 12L28 9L42 15L56 13L70 19L84 17L100 22'
        }
      />
    </svg>
  );
}

export function MarketView({
  data,
  onInspect,
}: {
  data: Dict | null;
  onInspect: (x: Dict) => void;
}) {
  const list: Dict[] = data?.strategies ?? [];
  const s =
    list.find((x) => x.version === 'trend-daily-v005') ??
    list.find((x) => x.kind !== 'htf-rsi');
  if (!s)
    return (
      <div className="mv-empty">
        <h3>The daily engine has not reported yet.</h3>
        <p>
          Start it with <code>pnpm trend:live</code>. It checks every coin after
          each 00:00 UTC daily close.
        </p>
      </div>
    );
  const regime: Dict = s.regime ?? {};
  const open: Dict[] = s.open ?? [];
  const watch: Dict[] = s.watch ?? [];
  const events: Dict[] = (s.events ?? []).slice(0, 8);
  const near = watch.filter((w) => w.toHighBps < 0 && w.toHighBps > -200);
  const openAvg = open.length
    ? open.reduce((a, o) => a + (o.markBps ?? 0), 0) / open.length
    : null;
  const filterGap =
    regime.btcClose && regime.btcSma
      ? (regime.btcClose / regime.btcSma - 1) * 100
      : null;
  const hoursToClose =
    typeof s.nextDailyClose === 'number'
      ? Math.max(0, (s.nextDailyClose - Date.now()) / 3_600_000)
      : null;
  const holding = new Set(open.map((o) => o.symbol));
  return (
    <div className="mv">
      <div className="mv-bar">
        <span className="mv-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span>crosswake / market</span>
        <span className="mv-tag">
          {s.version === 'trend-daily-v005' ? 'v005' : s.version} · paper
        </span>
      </div>
      <div className="mv-body">
        <div className="mv-kpis">
          <Kpi
            label="Market filter"
            value={regime.on ? 'ON' : 'OFF'}
            good={!!regime.on}
            note={
              filterGap === null
                ? 'BTC vs 100-day average'
                : `BTC ${Math.abs(filterGap).toFixed(1)}% ${filterGap >= 0 ? 'above' : 'below'} 100-day avg`
            }
          />
          <Kpi
            label="Open paper trades"
            value={String(open.length)}
            note={
              openAvg === null
                ? 'No open positions'
                : `Avg ${pctBps(openAvg)} unrealised`
            }
          />
          <Kpi
            label="Near a breakout"
            value={watch.length ? String(near.length) : '—'}
            note="Within 2% of 20-day high"
          />
          <Kpi
            label="Next check"
            value="00:05"
            note={
              hoursToClose === null
                ? 'UTC · daily close'
                : `UTC · in ${Math.floor(hoursToClose)}h ${Math.round((hoursToClose % 1) * 60)}m`
            }
          />
        </div>
        <div className="mv-split">
          <Panel
            title={`Watchlist · ${s.universe ?? watch.length} coins`}
            meta="Last daily close"
            footnote={
              watch.length
                ? 'Ranked by distance to the 20-day closing high.'
                : 'The watchlist appears after the trend engine next writes its state.'
            }
          >
            <div className="mv-scroll">
              <table>
                <tbody>
                  {watch.slice(0, 12).map((w) => {
                    const state = holding.has(w.symbol)
                      ? 'hold'
                      : w.toHighBps >= 0
                        ? 'go'
                        : w.toHighBps > -200
                          ? 'near'
                          : 'off';
                    return (
                      <tr key={w.symbol}>
                        <td>
                          <b>{asset(w.symbol)}</b>
                        </td>
                        <td className="num">{price(w.close)}</td>
                        <td className={cn('num', tone(w.changeBps))}>
                          {pctBps(w.changeBps)}
                        </td>
                        <td>
                          <span className={`mv-chip is-${state}`}>
                            {state === 'hold'
                              ? 'Holding'
                              : state === 'go'
                                ? 'Breakout'
                                : `${Math.abs(w.toHighBps / 100).toFixed(1)}% below high`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel
            title="Open paper positions"
            meta={s.version === 'trend-daily-v005' ? 'v005' : undefined}
            footnote="Exit when a coin closes below its 10-day low."
          >
            {open.length ? (
              open.map((o) => (
                <button
                  className="mv-pos"
                  key={o.symbol}
                  onClick={() => onInspect(o)}
                >
                  <b>{asset(o.symbol)}</b>
                  <span>
                    Day {Math.max(1, Math.round((Date.now() - o.entryTs) / DAY))}
                  </span>
                  <Spark up={(o.markBps ?? 0) >= 0} />
                  <span className={cn('num', tone(o.markBps))}>
                    {pctBps(o.markBps)}
                  </span>
                </button>
              ))
            ) : (
              <p className="mv-quiet">
                No open trades. Entries need a 20-day breakout while the BTC
                filter is on.
              </p>
            )}
          </Panel>
        </div>
        <Panel
          title="Signal log · sent to Telegram"
          meta="Wins and losses"
          footnote="Results include modelled fees and slippage. Paper signals, not advice."
        >
          {events.length ? (
            <div className="mv-scroll">
              <table className="mv-log">
                <thead>
                  <tr>
                    <th>Side</th>
                    <th>Coin</th>
                    <th>Date</th>
                    <th>Rule</th>
                    <th className="num">Price</th>
                    <th className="num">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr
                      key={e.id}
                      tabIndex={0}
                      onClick={() => onInspect(e)}
                      onKeyDown={(k) => k.key === 'Enter' && onInspect(e)}
                    >
                      <td>
                        <span
                          className={`mv-chip is-${e.kind === 'entry' ? 'go' : 'off'}`}
                        >
                          {e.kind === 'entry' ? 'BUY' : 'SELL'}
                        </span>
                      </td>
                      <td>
                        <b>{asset(e.symbol)}</b>
                      </td>
                      <td>{day(e.fillAt)}</td>
                      <td>
                        {e.kind === 'entry'
                          ? '20-day breakout'
                          : (reasonLabel[e.reason] ?? e.reason)}
                      </td>
                      <td className="num">{price(e.price)}</td>
                      <td className={cn('num', tone(e.netBps))}>
                        {e.kind === 'entry' ? '—' : pctBps(e.netBps)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mv-quiet">
              No signals since the live record started. They appear here the
              moment they are sent.
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}
