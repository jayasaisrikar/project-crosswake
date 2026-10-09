// Coded product panels filled with demo data. They stand in for workspace
// screenshots so the landing page never shows an empty, unconnected feed.

const watch = [
  ['SOL', '182.40', '+4.8%', 'Breakout', 'go'],
  ['LINK', '24.12', '+2.1%', '0.6% below high', 'near'],
  ['AVAX', '41.85', '+1.4%', '1.9% below high', 'near'],
  ['ARB', '1.12', '−0.8%', '7.4% below high', 'off'],
  ['DOGE', '0.214', '+0.3%', '5.2% below high', 'off'],
  ['INJ', '31.60', '+3.6%', 'Holding · day 9', 'hold'],
] as const;

const positions = [
  ['INJ', 'Day 9', '+11.4%', true],
  ['NEAR', 'Day 4', '+3.2%', true],
  ['OP', 'Day 2', '−1.9%', false],
] as const;

function Chrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="demo">
      <div className="demo-bar">
        <span className="demo-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{title}</span>
        <span className="demo-tag">Demo data</span>
      </div>
      {children}
    </div>
  );
}

function Spark({ d, up = true }: { d: string; up?: boolean }) {
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={up ? 'demo-spark' : 'demo-spark is-down'} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function DashboardDemo() {
  return (
    <Chrome title="crosswake / market">
      <div className="demo-body demo-dash">
        <div className="demo-kpis">
          <div className="demo-kpi is-good">
            <small>Market filter</small>
            <strong>ON</strong>
            <span>BTC 6.2% above 100-day avg</span>
          </div>
          <div className="demo-kpi">
            <small>Open paper trades</small>
            <strong>3</strong>
            <span>Avg +4.2% unrealised</span>
          </div>
          <div className="demo-kpi">
            <small>Near a breakout</small>
            <strong>2</strong>
            <span>Within 2% of 20-day high</span>
          </div>
          <div className="demo-kpi">
            <small>Next check</small>
            <strong>00:05</strong>
            <span>UTC · daily close</span>
          </div>
        </div>
        <div className="demo-split">
          <div className="demo-panel">
            <header>
              <span>Watchlist · 30 coins</span>
              <span>24h</span>
            </header>
            <table>
              <tbody>
                {watch.map(([c, p, ch, note, s]) => (
                  <tr key={c}>
                    <td>
                      <b>{c}</b>
                    </td>
                    <td className="num">{p}</td>
                    <td className={ch.startsWith('−') ? 'num down' : 'num up'}>{ch}</td>
                    <td>
                      <span className={`demo-chip is-${s}`}>{note}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="demo-panel">
            <header>
              <span>Open paper positions</span>
              <span>v005</span>
            </header>
            {positions.map(([c, d, r, up]) => (
              <div className="demo-pos" key={c}>
                <b>{c}</b>
                <span>{d}</span>
                <Spark up={up} d={up ? 'M0 26L12 22L24 24L36 16L48 18L60 11L72 13L84 6L100 4' : 'M0 10L14 12L28 9L42 15L56 13L70 19L84 17L100 22'} />
                <span className={up ? 'num up' : 'num down'}>{r}</span>
              </div>
            ))}
            <div className="demo-note">Exit when a coin closes below its 10-day low.</div>
          </div>
        </div>
      </div>
    </Chrome>
  );
}

const versions = [
  ['v005', 'Daily trend', 'Live paper', 'live'],
  ['v006', 'Daily trend · wider universe', 'Live paper', 'live'],
  ['v007', '15m RSI perp', 'Failed test', 'fail'],
  ['v003', 'Laggard catch-up', 'Failed test', 'fail'],
  ['v001', 'BTC lead-lag', 'Rejected', 'fail'],
] as const;

export function LabDemo() {
  return (
    <Chrome title="crosswake / strategy lab">
      <div className="demo-body demo-lab">
        <div className="demo-panel demo-equity">
          <header>
            <span>v005 · unseen-data test · equity (R)</span>
            <span>Jan 2025 — Sep 2026</span>
          </header>
          <svg viewBox="0 0 400 140" preserveAspectRatio="none" aria-hidden="true">
            <path className="demo-zero" d="M0 110H400" />
            <path className="demo-area" d="M0 110L20 112L40 104L60 108L80 96L100 100L120 84L140 90L160 76L180 82L200 60L220 70L240 66L260 48L280 56L300 40L320 46L340 30L360 38L380 26L400 22V140H0Z" />
            <path className="demo-line" d="M0 110L20 112L40 104L60 108L80 96L100 100L120 84L140 90L160 76L180 82L200 60L220 70L240 66L260 48L280 56L300 40L320 46L340 30L360 38L380 26L400 22" />
          </svg>
          <div className="demo-stats">
            <div><small>Trades</small><b>243</b></div>
            <div><small>Win rate</small><b>33.7%</b></div>
            <div><small>Avg / trade</small><b className="up">+1.5%</b></div>
            <div><small>Profit factor</small><b>1.32</b></div>
          </div>
        </div>
        <div className="demo-panel">
          <header>
            <span>Every version, on the record</span>
          </header>
          {versions.map(([v, name, st, s]) => (
            <div className="demo-ver" key={v}>
              <b>{v}</b>
              <span>{name}</span>
              <span className={`demo-chip is-${s}`}>{st}</span>
            </div>
          ))}
          <div className="demo-note">95% CI −2.9% to +6.3% · includes zero. Fees and slippage modelled.</div>
        </div>
      </div>
    </Chrome>
  );
}

const log = [
  ['BUY', 'SOL', 'Oct 08', '20-day breakout', '—', 'open'],
  ['SELL', 'TIA', 'Oct 06', '10-day low', '+18.6%', 'win'],
  ['SELL', 'OP', 'Oct 03', '10-day low', '−6.1%', 'loss'],
  ['BUY', 'INJ', 'Sep 30', '20-day breakout', '—', 'open'],
  ['SELL', 'LINK', 'Sep 27', 'BTC filter off', '−3.4%', 'loss'],
  ['SELL', 'SUI', 'Sep 22', '10-day low', '+31.2%', 'win'],
] as const;

export function SignalLogDemo() {
  return (
    <Chrome title="crosswake / signal log">
      <div className="demo-body">
        <div className="demo-panel">
          <header>
            <span>Every signal sent to Telegram</span>
            <span>Wins and losses</span>
          </header>
          <table className="demo-log">
            <thead>
              <tr>
                <th>Side</th>
                <th>Coin</th>
                <th>Date</th>
                <th>Rule</th>
                <th className="num">Result</th>
              </tr>
            </thead>
            <tbody>
              {log.map(([side, c, d, rule, r, s]) => (
                <tr key={c + d}>
                  <td>
                    <span className={`demo-chip is-${side === 'BUY' ? 'go' : 'off'}`}>{side}</span>
                  </td>
                  <td>
                    <b>{c}</b>
                  </td>
                  <td>{d}</td>
                  <td>{rule}</td>
                  <td className={`num ${s === 'win' ? 'up' : s === 'loss' ? 'down' : ''}`}>{r}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="demo-note">Results include modelled fees and slippage. Paper signals, not advice.</div>
        </div>
      </div>
    </Chrome>
  );
}
