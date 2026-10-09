'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Info } from 'lucide-react';
import { SiteFooter, SiteHeader } from './site-shell';

type Point = { t: number; strategy: number; btc: number; basket: number; exposure: number; drawdown: number };
type Summary = {
  version: string;
  period: [string, string];
  model: { slots: number; sizing: string; marking: string; costBpsRoundTrip: number };
  trades: number;
  winRate: number;
  avgNetBps: number;
  bestBps: number;
  worstBps: number;
  longestLosingStreak: number;
  avgExposure: number;
  maxExposure: number;
  totalReturn: Record<'strategy' | 'btc' | 'basket', number>;
  maxDrawdown: Record<'strategy' | 'btc' | 'basket', number>;
  worstDrawdown: { from: number; to: number };
  basketCoins: number;
  excludingTop?: { symbol: string; multiple: number; strategy: number; basket: number };
  fillDelay?: {
    skipped: number;
    rows: { delayHours: number; trades: number; avgNetBps: number; winRate: number; totalReturn: number }[];
  };
};
type Data = { summary: Summary; points: Point[] };

const VERSION = 'trend-daily-v005';
// Validated (dark, all pairs, CVD-safe) against the page surface; text never uses these.
const SERIES = [
  { key: 'strategy', label: 'Crosswake v005', short: 'v005', color: '#56a334' },
  { key: 'btc', label: 'Hold BTC', short: 'BTC', color: '#4a8ad0' },
  { key: 'basket', label: 'Hold the altcoins', short: 'Altcoins', color: '#d8679b' },
] as const;
const DD_COLOR = '#e87461';

const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
const plain = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const month = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const PAD_WIDE = { l: 56, r: 128, t: 16, b: 32 },
  PAD_NARROW = { l: 40, r: 108, t: 12, b: 28 };

/** Draws at the container's real width so labels render at their true size on phones. */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(960);
  useEffect(() => {
    if (!el) return;
    const measure = () => setW(Math.max(280, Math.round(el.clientWidth - 16)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const narrow = w < 600;
  return { ref: setEl, W: w, PAD: narrow ? PAD_NARROW : PAD_WIDE, narrow };
}

function useHover(n: number, W: number, PAD: typeof PAD_WIDE) {
  const [i, setI] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const k = Math.round(((x - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setI(k < 0 || k >= n ? null : k);
  };
  return { i, ref, onMove, onLeave: () => setI(null) };
}

function ticks(lo: number, hi: number, count = 5) {
  const step = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(step));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step)!;
  const out: number[] = [];
  for (let v = Math.ceil(lo / nice) * nice; v <= hi + 1e-9; v += nice) out.push(+v.toFixed(6));
  return out;
}

function EquityChart({ points }: { points: Point[] }) {
  const { ref: box, W, PAD, narrow } = useWidth();
  const H = narrow ? 260 : 340, n = points.length;
  const all = points.flatMap((p) => [p.strategy, p.btc, p.basket]);
  const lo = Math.min(...all) * 0.97, hi = Math.max(...all) * 1.03;
  const x = (k: number) => PAD.l + (k / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const path = (key: 'strategy' | 'btc' | 'basket') =>
    points.map((p, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)} ${y(p[key]).toFixed(1)}`).join('');
  const hover = useHover(n, W, PAD);
  const months = points
    .map((p, k) => [p, k] as const)
    .filter(([p], k) => k === 0 || new Date(p.t).getUTCDate() === 1)
    .filter((_, j) => j % (narrow ? 6 : 3) === 0);
  // End labels, nudged apart so they never collide.
  const ends = SERIES.map((s) => ({ ...s, y: y(points[n - 1]![s.key]) })).sort((a, b) => a.y - b.y);
  for (let j = 1; j < ends.length; j++) if (ends[j]!.y - ends[j - 1]!.y < 16) ends[j]!.y = ends[j - 1]!.y + 16;
  const h = hover.i !== null ? points[hover.i]! : null;
  return (
    <div className="pf-chart" ref={box}>
      <svg
        ref={hover.ref}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Growth of 1 unit: Crosswake v005 against holding BTC and holding the 29-coin basket"
        onPointerMove={hover.onMove}
        onPointerLeave={hover.onLeave}
      >
        {ticks(lo, hi).map((v) => (
          <g key={v}>
            <line className="pf-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="pf-axis" x={PAD.l - 10} y={y(v) + 4} textAnchor="end">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        <line className="pf-base" x1={PAD.l} x2={W - PAD.r} y1={y(1)} y2={y(1)} />
        {months.map(([p, k]) => (
          <text key={p.t} className="pf-axis" x={x(k)} y={H - 8} textAnchor="middle">
            {month(p.t)}
          </text>
        ))}
        {[...SERIES].reverse().map((s) => (
          <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={s.key === 'strategy' ? 2.5 : 2} strokeLinejoin="round" />
        ))}
        {ends.map((s) => (
          <g key={s.key}>
            <circle cx={x(n - 1)} cy={y(points[n - 1]![s.key])} r={4} fill={s.color} stroke="#0b0b0b" strokeWidth={2} />
            <text className="pf-end" x={x(n - 1) + 10} y={s.y + 4}>
              {s.short} {pct(points[n - 1]![s.key] - 1, 0)}
            </text>
          </g>
        ))}
        {h && (
          <g>
            <line className="pf-cross" x1={x(hover.i!)} x2={x(hover.i!)} y1={PAD.t} y2={H - PAD.b} />
            {SERIES.map((s) => (
              <circle key={s.key} cx={x(hover.i!)} cy={y(h[s.key])} r={4} fill={s.color} stroke="#0b0b0b" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {h && (
        <div className="pf-tip" style={{ left: `${(x(hover.i!) / W) * 100}%` }}>
          <b>{day(h.t)}</b>
          {SERIES.map((s) => (
            <span key={s.key}>
              <i style={{ background: s.color }} /> {s.label} <em>{pct(h[s.key] - 1)}</em>
            </span>
          ))}
          <span className="pf-tip-note">Capital deployed {plain(h.exposure, 0)}</span>
        </div>
      )}
    </div>
  );
}

function DrawdownChart({ points }: { points: Point[] }) {
  const { ref: box, W, PAD } = useWidth();
  const H = 150, n = points.length;
  const lo = Math.min(...points.map((p) => p.drawdown)) * 1.1;
  const x = (k: number) => PAD.l + (k / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (v / lo) * (H - PAD.t - PAD.b);
  const area = `M${x(0)} ${y(0)}` + points.map((p, k) => `L${x(k).toFixed(1)} ${y(p.drawdown).toFixed(1)}`).join('') + `L${x(n - 1)} ${y(0)}Z`;
  const hover = useHover(n, W, PAD);
  const h = hover.i !== null ? points[hover.i]! : null;
  return (
    <div className="pf-chart" ref={box}>
      <svg ref={hover.ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Strategy drawdown from its previous peak" onPointerMove={hover.onMove} onPointerLeave={hover.onLeave}>
        {ticks(lo, 0, 3).map((v) => (
          <g key={v}>
            <line className="pf-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="pf-axis" x={PAD.l - 10} y={y(v) + 4} textAnchor="end">
              {plain(v, 0)}
            </text>
          </g>
        ))}
        <path d={area} fill={DD_COLOR} fillOpacity={0.22} stroke={DD_COLOR} strokeWidth={1.5} />
        {h && <line className="pf-cross" x1={x(hover.i!)} x2={x(hover.i!)} y1={PAD.t} y2={H - PAD.b} />}
      </svg>
      {h && (
        <div className="pf-tip" style={{ left: `${(x(hover.i!) / W) * 100}%` }}>
          <b>{day(h.t)}</b>
          <span>Below previous peak <em>{pct(h.drawdown)}</em></span>
        </div>
      )}
    </div>
  );
}

export function PerformanceView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    fetch(`/data/${VERSION}-performance.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setError(true));
  }, []);
  const s = data?.summary;
  const rows = useMemo(
    () =>
      s
        ? ([
            ['Total return', 'totalReturn'],
            ['Maximum drawdown', 'maxDrawdown'],
          ] as const)
        : [],
    [s],
  );
  return (
    <div className="cw-site cw-docs-site">
      <a className="skip-link" href="#main">Skip to content</a>
      <SiteHeader />
      <main id="main" className="pf-page">
        <p className="sl-eyebrow">v005 · Unseen-data test</p>
        <h1>Performance, in full.</h1>
        <p className="sl-lead">
          What v005 would have done as a portfolio on data it never saw during development, next to simply holding Bitcoin or the
          same coins. Every trade behind these numbers is downloadable.
        </p>
        {error && <p className="sl-quiet">Performance data is not available right now.</p>}
        {!s && !error && <p className="sl-quiet">Loading…</p>}
        {s && data && (
          <>
            <dl className="pf-stats">
              <div><dt>Total return</dt><dd>{pct(s.totalReturn.strategy)}</dd></div>
              <div><dt>Maximum drawdown</dt><dd>{pct(s.maxDrawdown.strategy)}</dd></div>
              <div><dt>Average capital deployed</dt><dd>{plain(s.avgExposure, 0)}</dd></div>
              <div><dt>Longest losing streak</dt><dd>{s.longestLosingStreak} trades</dd></div>
              <div><dt>Trades</dt><dd>{s.trades}</dd></div>
              <div><dt>Win rate</dt><dd>{plain(s.winRate)}</dd></div>
              <div><dt>Best trade</dt><dd>{pct(s.bestBps / 10_000)}</dd></div>
              <div><dt>Worst trade</dt><dd>{pct(s.worstBps / 10_000)}</dd></div>
            </dl>

            <section className="pf-section">
              <header>
                <h2>Growth of 1 unit</h2>
                <ul className="pf-legend">
                  {SERIES.map((x) => (
                    <li key={x.key}><i style={{ background: x.color }} /> {x.label}</li>
                  ))}
                </ul>
              </header>
              <EquityChart points={data.points} />
            </section>

            <section className="pf-section">
              <header>
                <h2>Drawdown</h2>
                <p>How far v005 sat below its previous high. The deepest fall ran from {day(s.worstDrawdown.from)} to {day(s.worstDrawdown.to)}.</p>
              </header>
              <DrawdownChart points={data.points} />
            </section>

            <section className="pf-section">
              <h2>Side by side</h2>
              <div className="sl-scroll">
                <table className="pf-table">
                  <thead>
                    <tr><th /><th className="num">Crosswake v005</th><th className="num">Hold BTC</th><th className="num">Hold the {s.basketCoins} coins</th></tr>
                  </thead>
                  <tbody>
                    {rows.map(([label, key]) => (
                      <tr key={key}>
                        <td>{label}</td>
                        <td className="num">{pct(s[key].strategy)}</td>
                        <td className="num">{pct(s[key].btc)}</td>
                        <td className="num">{pct(s[key].basket)}</td>
                      </tr>
                    ))}
                    {s.excludingTop && (
                      <tr>
                        <td>
                          Total return without {s.excludingTop.symbol.replace(/USDT$/, '')}
                          <small className="pf-row-note">
                            The best coin rose {s.excludingTop.multiple.toFixed(1)}× and drives both results
                          </small>
                        </td>
                        <td className="num">{pct(s.excludingTop.strategy)}</td>
                        <td className="num">—</td>
                        <td className="num">{pct(s.excludingTop.basket)}</td>
                      </tr>
                    )}
                    <tr><td>Capital deployed on average</td><td className="num">{plain(s.avgExposure, 0)}</td><td className="num">100%</td><td className="num">100%</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            {s.fillDelay && (
              <section className="pf-section">
                <header>
                  <h2>If you act later</h2>
                  <p>
                    The test fills at the exact 00:00 UTC open. Alerts arrive a few minutes after, so here every trade is re-priced
                    at the open 1 and 4 hours later, entry and exit alike, from hourly data.
                  </p>
                </header>
                <div className="sl-scroll">
                  <table className="pf-table">
                    <thead>
                      <tr>
                        <th>Fill time</th>
                        <th className="num">Avg net / trade</th>
                        <th className="num">Win rate</th>
                        <th className="num">Total return</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.fillDelay.rows.map((r) => (
                        <tr key={r.delayHours}>
                          <td>{r.delayHours === 0 ? 'At the open (as tested)' : `${r.delayHours} hour${r.delayHours > 1 ? 's' : ''} later`}</td>
                          <td className="num">{pct(r.avgNetBps / 10_000, 2)}</td>
                          <td className="num">{plain(r.winRate)}</td>
                          <td className="num">{pct(r.totalReturn)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {s.fillDelay.skipped > 0 && (
                  <p className="sl-quiet">{s.fillDelay.skipped} trades without hourly data are left out of this table.</p>
                )}
              </section>
            )}

            <section className="pf-section">
              <h2>How this is calculated</h2>
              <ul className="pf-notes">
                <li>{s.model.sizing}</li>
                <li>{s.model.marking}</li>
                <li>Costs: {s.model.costBpsRoundTrip / 100}% per round trip for fees and slippage. Entries assume the next daily open.</li>
                <li>Period: {s.period[0]} to {s.period[1]}, after the rules were frozen. Benchmarks are bought on day one and held.</li>
                <li>Cash that is not deployed earns nothing here. On average {plain(1 - s.avgExposure, 0)} of capital is idle.</li>
                <li>The altcoin basket holds the {s.basketCoins} coins that traded on day one, in equal amounts; a coin that stops trading keeps its last price.</li>
                {s.excludingTop && (
                  <li>
                    One coin, {s.excludingTop.symbol.replace(/USDT$/, '')}, rose {s.excludingTop.multiple.toFixed(1)}× in this period. Without it, v005 was
                    roughly flat ({pct(s.excludingTop.strategy)}) while holding the other coins lost {pct(s.excludingTop.basket).replace('−', '')}. Its
                    value in this test was mostly in staying out of a falling market.
                  </li>
                )}
              </ul>
              <aside className="pf-callout">
                <Info size={17} aria-hidden="true" />
                <p>
                  A backtest on unseen data is still a backtest. The 95% confidence interval for the average trade includes zero, so
                  this is evidence, not proof. The live paper record is the real test.
                </p>
              </aside>
              <a className="cw-button pf-download" href={`/data/${VERSION}-test-trades.csv`} download>
                Download all {s.trades} trades (CSV) <Download size={16} aria-hidden="true" />
              </a>
            </section>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
