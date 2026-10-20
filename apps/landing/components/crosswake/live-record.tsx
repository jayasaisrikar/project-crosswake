import { pct, relativeAge, type PublicSnapshot } from '@/lib/live';

const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;

const kindLabel: Record<string, string> = {
  'trend-daily': 'Daily trend',
  'htf-rsi': 'Intraday futures',
  residual: 'Residual pairs',
  momentum: 'Momentum book',
};

function Positions({ engine }: { engine: PublicSnapshot['engines'][number] }) {
  if (!engine.positions.length)
    return <span className="rs-live-flat">nothing open</span>;
  return (
    <ul className="rs-live-positions">
      {engine.positions.slice(0, 4).map((p) => (
        <li key={`${engine.id}-${p.symbol}-${p.side ?? 'long'}`}>
          <b>{p.symbol.replace(/USDT$/, '')}</b>
          <span>{p.side ?? 'long'}</span>
          <em>{pct(p.markBps)}</em>
        </li>
      ))}
    </ul>
  );
}

export function LiveRecord({ snapshot }: { snapshot: PublicSnapshot | null }) {
  if (!snapshot)
    return (
      <section className="rs-live" data-reveal>
        <p className="rs-live-offline">
          The live record could not be read just now. The signal log and the
          changelog still hold every published result.
        </p>
      </section>
    );
  const now = Date.now(),
    age = relativeAge(snapshot.collector.lastMessageAt, now);
  return (
    <section className="rs-live" data-reveal>
      <div className="rs-live-head">
        <h2>Where the record stands</h2>
        <p>
          Read from the running engines at {clock(snapshot.generatedAt)}.
          {snapshot.collector.connected
            ? ` Market data is connected, last message ${age ?? 'just now'}.`
            : ' The market feed is not connected right now.'}{' '}
          Every position below is paper.
        </p>
      </div>
      <div className="rs-live-grid">
        {snapshot.engines.map((engine) => (
          <article key={engine.id} className="rs-live-card">
            <header>
              <b>{engine.version}</b>
              <span>{kindLabel[engine.kind] ?? engine.kind}</span>
            </header>
            <dl>
              {engine.regimeOn !== null && (
                <>
                  <dt>Bitcoin filter</dt>
                  <dd>{engine.regimeOn ? 'on' : 'off'}</dd>
                </>
              )}
              <dt>Open paper</dt>
              <dd>
                <Positions engine={engine} />
              </dd>
              {engine.stats?.trades ? (
                <>
                  <dt>Closed so far</dt>
                  <dd>
                    {engine.stats.trades} · avg {pct(engine.stats.netExpectancyBps)}
                  </dd>
                </>
              ) : null}
              <dt>Channel</dt>
              <dd>{engine.telegram ? 'posts to Telegram' : 'dashboard only'}</dd>
            </dl>
          </article>
        ))}
      </div>
      {snapshot.events.length ? (
        <div className="rs-live-activity">
          <h3>Most recent activity</h3>
          <ul>
            {snapshot.events.slice(0, 6).map((event) => (
              <li key={event.id}>
                <time dateTime={event.at}>{event.at.slice(0, 10)}</time>
                <span className="rs-live-kind">{event.kind}</span>
                <b>{event.symbol.replace(/USDT$/, '')}</b>
                <span>{event.engine}</span>
                <em>{event.netBps === null ? '' : `${pct(event.netBps)} net`}</em>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
