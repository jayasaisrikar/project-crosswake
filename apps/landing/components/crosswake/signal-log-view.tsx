'use client';
import { useEffect, useState } from 'react';
import { CircleAlert, ExternalLink, ShieldCheck, ShieldX } from 'lucide-react';
import {
  fingerprint,
  parseLog,
  verify,
  type SignalLogEntry,
  type Verification,
} from '../../../../packages/signal-log/src/index';
import { SiteFooter, SiteHeader } from './site-shell';
import { signalLogBase, signalLogRepo, signalLogs } from '@/lib/site';

type Loaded =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error'; message: string }
  | { state: 'ready'; log: SignalLogEntry[]; check: Verification };

const asset = (s: string) => s.replace(/USDT$/, '');
const pct = (bps?: number) =>
  typeof bps === 'number'
    ? `${bps >= 0 ? '+' : '−'}${Math.abs(bps / 100).toFixed(1)}%`
    : '—';
const utc = (ms: number) =>
  new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function useLog(file: string): Loaded {
  const [s, set] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    if (!signalLogBase) return set({ state: 'missing' });
    let live = true;
    fetch(`${signalLogBase}/${file}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 404) return live && set({ state: 'missing' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const log = parseLog(await r.text());
        const check = await verify(log);
        if (live) set({ state: 'ready', log, check });
      })
      .catch(
        (e) => live && set({ state: 'error', message: String(e.message ?? e) }),
      );
    return () => {
      live = false;
    };
  }, [file]);
  return s;
}

function Strategy({ file, label }: { file: string; label: string }) {
  const s = useLog(file);
  return (
    <section className="sl-strategy">
      <header>
        <h2>{label}</h2>
        {s.state === 'ready' &&
          (s.check.ok ? (
            <span className="sl-badge is-ok">
              <ShieldCheck size={15} aria-hidden="true" /> Chain verified in
              your browser · {s.check.count} entries · head #
              {fingerprint(s.check.head)}
            </span>
          ) : (
            <span className="sl-badge is-bad">
              <ShieldX size={15} aria-hidden="true" /> Chain broken at entry{' '}
              {s.check.brokenAt}: {s.check.problem}
            </span>
          ))}
      </header>
      {s.state === 'loading' && <p className="sl-quiet">Loading the log…</p>}
      {s.state === 'missing' && (
        <p className="sl-quiet">
          No public entries yet. The first signal will appear here the moment
          it is sent.
        </p>
      )}
      {s.state === 'error' && (
        <p className="sl-quiet">
          <CircleAlert size={14} aria-hidden="true" /> Could not load the log (
          {s.message}). Try again shortly.
        </p>
      )}
      {s.state === 'ready' && s.log.length === 0 && (
        <p className="sl-quiet">No entries yet.</p>
      )}
      {s.state === 'ready' && s.log.length > 0 && (
        <div className="sl-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Published</th>
                <th>Side</th>
                <th>Coin</th>
                <th className="num">Ref. price</th>
                <th className="num">Result</th>
                <th>Fingerprint</th>
              </tr>
            </thead>
            <tbody>
              {[...s.log].reverse().map((e) => (
                <tr key={e.hash}>
                  <td className="num">{e.seq}</td>
                  <td>
                    {utc(e.publishedAt)}
                    {e.backfill && (
                      <span
                        className="sl-tag"
                        title="Sent before the log existed; added when logging began"
                      >
                        backfill
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`sl-side is-${e.kind}`}>
                      {e.kind === 'entry' ? 'BUY' : 'SELL'}
                    </span>
                  </td>
                  <td>
                    <b>{asset(e.symbol)}</b>
                  </td>
                  <td className="num">{e.price}</td>
                  <td
                    className={`num ${typeof e.netBps === 'number' ? (e.netBps >= 0 ? 'up' : 'down') : ''}`}
                  >
                    {e.kind === 'exit' ? pct(e.netBps) : '—'}
                  </td>
                  <td>
                    <code>#{fingerprint(e.hash)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function SignalLogView() {
  return (
    <div className="cw-site cw-docs-site">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="sl-page">
        <p className="sl-eyebrow">Public record</p>
        <h1>The signal log.</h1>
        <p className="sl-lead">
          Every signal Crosswake sends is written to an append-only log before
          it reaches Telegram. Each entry’s fingerprint covers the entry before
          it, so no past signal can be edited, reordered or deleted without
          breaking every fingerprint after it.
        </p>
        {signalLogRepo && (
          <a className="sl-repo" href={signalLogRepo} target="_blank" rel="noreferrer">
            Full commit history on GitHub <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
        {signalLogs.map((l) => (
          <Strategy key={l.file} {...l} />
        ))}
        <section className="sl-how">
          <h2>Check it yourself</h2>
          <ol>
            <li>
              <b>Match the post.</b> Every Telegram signal ends with{' '}
              <code>log #fingerprint · seq n</code>. The same fingerprint
              appears in this table, and the Telegram post’s timestamp shows
              when it was committed.
            </li>
            <li>
              <b>Check the timeline.</b> Each entry is also committed to a public
              Git repository the moment it is sent. The commit history is an
              independent, timestamped record.
            </li>
            <li>
              <b>Re-run the maths.</b> This page re-computes every SHA-256
              fingerprint in your browser. To do it offline, download a{' '}
              <code>.jsonl</code> file and run{' '}
              <code>node verify.mjs &lt;file&gt;</code>, the dependency-free
              checker published next to the logs.
            </li>
          </ol>
          <p className="sl-quiet">
            Entries marked <span className="sl-tag">backfill</span> were sent
            before logging began on 9 October 2026 and were added once, in
            order, when it started. Paper signals only; not financial advice.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
