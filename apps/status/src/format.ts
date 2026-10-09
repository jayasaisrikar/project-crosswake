// Daily status post and weekly scorecard for the Telegram channel. Pure functions over the
// trend engines' state files, so quiet days still show what the strategies are doing.
import { escapeHtml } from '../../../packages/notify/src/index.js';

export const DAY = 86_400_000;

export interface TrendState {
  version: string;
  lastDailyClose: number;
  forwardStart: number;
  regime?: { on: boolean };
  open: { symbol: string; entryTs: number; markBps?: number }[];
  closed: { symbol: string; entryTs: number; exitTs: number; netBps: number }[];
  events: { id: string; kind: 'entry' | 'exit'; symbol: string; decidedAt: number; fillAt: number; netBps?: number }[];
  watch?: { symbol: string; toHighBps: number }[];
}
export interface LogHead {
  version: string;
  seq: number;
  hash: string;
}

const coin = (s: string) => escapeHtml(s.replace(/USDT$/, ''));
const short = (v: string) => v.replace(/^trend-daily-/, '');
export const pct = (bps: number) => `${bps >= 0 ? '+' : '−'}${Math.abs(bps / 100).toFixed(1)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const date = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
export const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;
/** Monday 00:00 UTC of the week containing `ms`. */
export const weekStart = (ms: number) => {
  const d = utcDay(ms);
  return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
};

function record(closed: TrendState['closed']) {
  if (!closed.length) return 'no closed trades yet';
  const wins = closed.filter((t) => t.netBps > 0).length;
  const avg = closed.reduce((a, t) => a + t.netBps, 0) / closed.length;
  return `${closed.length} closed · ${wins} won · avg ${pct(avg)} per trade`;
}

function logLine(heads: LogHead[]) {
  return heads.length
    ? `<code>${heads.map((h) => `${short(h.version)} log #${h.hash.slice(0, 12)} · seq ${h.seq}`).join('\n')}</code>`
    : null;
}

/** Every state must reflect the close at `today` before the post is written. */
export const isFresh = (states: TrendState[], today: number) =>
  states.length > 0 && states.every((s) => s.lastDailyClose >= today);

export function dailyPost(states: TrendState[], heads: LogHead[], today: number): string {
  const filterOn = states.some((s) => s.regime?.on);
  // The same coin can fire in both versions; list it once with every version that sent it.
  const fresh = new Map<string, string[]>();
  for (const s of states)
    for (const e of s.events.filter((e) => e.decidedAt >= today - DAY)) {
      const label = `${e.kind === 'entry' ? '🟢 BUY' : e.netBps! >= 0 ? '✅ SELL' : '❌ SELL'} ${coin(e.symbol)}`;
      fresh.set(label, [...(fresh.get(label) ?? []), short(s.version)]);
    }
  const unique = [...fresh].map(([label, versions]) => `${label} <i>(${versions.join(', ')})</i>`);
  // The widest universe has the most complete watchlist; holdings are excluded.
  const holding = new Set(states.flatMap((s) => s.open.map((o) => o.symbol)));
  const watch = [...states]
    .sort((a, b) => (b.watch?.length ?? 0) - (a.watch?.length ?? 0))[0]
    ?.watch?.filter((w) => w.toHighBps < 0 && !holding.has(w.symbol))
    .slice(0, 3);
  const lines = [
    `📋 <b>Daily status · ${date(today)}</b>`,
    '',
    `<b>Market filter</b>  ${filterOn ? 'ON · Bitcoin trend supports new entries' : 'OFF · staying in cash until Bitcoin recovers'}`,
    `<b>New signals</b>  ${unique.length ? unique.join(', ') : 'none today'}`,
  ];
  if (filterOn && watch?.length)
    lines.push(
      `<b>Closest to a breakout</b>  ${watch.map((w) => `${coin(w.symbol)} ${(Math.abs(w.toHighBps) / 100).toFixed(1)}%`).join(' · ')}`,
    );
  for (const s of states) {
    lines.push('', `<b>${short(s.version)}</b>`);
    lines.push(
      s.open.length
        ? `Open: ${s.open
            .map((o) => `${coin(o.symbol)} ${pct(o.markBps ?? 0)} (day ${Math.max(1, Math.round((today - o.entryTs) / DAY) + 1)})`)
            .join(' · ')}`
        : 'Open: none',
    );
    lines.push(`Since ${date(s.forwardStart)}: ${record(s.closed)}`);
  }
  const log = logLine(heads);
  if (log) lines.push('', log);
  lines.push('', '<i>Paper signals, not advice. Full record: the signal log.</i>');
  return lines.join('\n');
}

export function weeklyPost(
  states: TrendState[],
  heads: LogHead[],
  week: number,
  btcWeekBps: number | null,
): string {
  const end = week + 7 * DAY;
  const lines = [
    `📊 <b>Weekly scorecard · ${date(week)} – ${date(end - DAY)}</b>`,
  ];
  for (const s of states) {
    const signals = s.events.filter((e) => e.kind === 'entry' && e.fillAt >= week && e.fillAt < end);
    const closed = s.closed.filter((t) => t.exitTs >= week && t.exitTs < end);
    lines.push('', `<b>${short(s.version)}</b>`);
    lines.push(`New entries: ${signals.length ? signals.map((e) => coin(e.symbol)).join(', ') : 'none'}`);
    lines.push(
      closed.length
        ? `Closed: ${closed.map((t) => `${t.netBps >= 0 ? '✅' : '❌'} ${coin(t.symbol)} ${pct(t.netBps)}`).join(' · ')}`
        : 'Closed: none',
    );
    lines.push(`Open now: ${s.open.length ? s.open.map((o) => `${coin(o.symbol)} ${pct(o.markBps ?? 0)}`).join(' · ') : 'none'}`);
    lines.push(`Since ${date(s.forwardStart)}: ${record(s.closed)}`);
  }
  if (btcWeekBps !== null)
    lines.push('', `<b>BTC this week</b>  ${pct(btcWeekBps)} <i>(market context, not a like-for-like benchmark)</i>`);
  const log = logLine(heads);
  if (log) lines.push('', log);
  lines.push('', '<i>Every signal and result, losses included. Paper signals, not advice.</i>');
  return lines.join('\n');
}
