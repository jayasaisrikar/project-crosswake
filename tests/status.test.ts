import { describe, expect, it } from 'vitest';
import {
  DAY,
  dailyPost,
  isFresh,
  weekStart,
  weeklyPost,
  type TrendState,
} from '../apps/status/src/format.js';

const today = Date.UTC(2026, 9, 12); // Monday
const state = (over: Partial<TrendState> = {}): TrendState => ({
  version: 'trend-daily-v005',
  lastDailyClose: today,
  forwardStart: Date.UTC(2026, 9, 1),
  regime: { on: true },
  open: [{ symbol: 'INJUSDT', entryTs: today - 8 * DAY, markBps: 1140 }],
  closed: [
    { symbol: 'TIAUSDT', entryTs: today - 9 * DAY, exitTs: today - 3 * DAY, netBps: 1860 },
    { symbol: 'OPUSDT', entryTs: today - 12 * DAY, exitTs: today - 10 * DAY, netBps: -610 },
  ],
  events: [
    { id: 'a', kind: 'entry', symbol: 'SOLUSDT', decidedAt: today - DAY, fillAt: today },
    { id: 'b', kind: 'exit', symbol: 'TIAUSDT', decidedAt: today - 4 * DAY, fillAt: today - 3 * DAY, netBps: 1860 },
  ],
  watch: [
    { symbol: 'SOLUSDT', toHighBps: 40 },
    { symbol: 'LINKUSDT', toHighBps: -60 },
    { symbol: 'INJUSDT', toHighBps: -80 },
    { symbol: 'AVAXUSDT', toHighBps: -190 },
  ],
  ...over,
});
const heads = [{ version: 'trend-daily-v005', seq: 7, hash: 'ab'.repeat(32) }];

describe('daily status', () => {
  it('waits until every engine has the day’s close', () => {
    expect(isFresh([state(), state({ lastDailyClose: today - DAY })], today)).toBe(false);
    expect(isFresh([state()], today)).toBe(true);
    expect(isFresh([], today)).toBe(false);
  });

  it('reports filter, new signals, watchlist, positions, record and log head', () => {
    const t = dailyPost([state()], heads, today);
    expect(t).toContain('Daily status · 12 Oct');
    expect(t).toContain('Market filter</b>  ON');
    expect(t).toContain('🟢 BUY SOL');
    // Breakouts and held coins are not "close to a breakout".
    expect(t).toContain('Closest to a breakout</b>  LINK 0.6% · AVAX 1.9%');
    expect(t).toContain('INJ +11.4% (day 9)');
    expect(t).toContain('2 closed · 1 won · avg +6.3% per trade');
    expect(t).toContain('v005 log #abababababab · seq 7');
  });

  it('says so plainly on a quiet, risk-off day', () => {
    const t = dailyPost([state({ regime: { on: false }, events: [], open: [], closed: [] })], [], today);
    expect(t).toContain('OFF · staying in cash');
    expect(t).toContain('none today');
    expect(t).toContain('Open: none');
    expect(t).toContain('no closed trades yet');
    expect(t).not.toContain('Closest to a breakout');
    expect(t).not.toContain('log #');
  });
});

describe('weekly scorecard', () => {
  it('starts weeks on Monday UTC', () => {
    expect(weekStart(today + 5 * 3_600_000)).toBe(today);
    expect(weekStart(today + 6 * DAY)).toBe(today);
  });

  it('covers only the finished week and states BTC as context', () => {
    const week = today - 7 * DAY;
    const t = weeklyPost([state()], heads, week, -230);
    expect(t).toContain('Weekly scorecard · 5 Oct – 11 Oct');
    expect(t).toContain('✅ TIA +18.6%');
    expect(t).not.toContain('OP −6.1%'); // closed the week before
    expect(t).toContain('New entries: none'); // SOL fills on the 12th, next week
    expect(t).toContain('BTC this week</b>  −2.3%');
  });
});

describe('cross-version signals', () => {
  it('lists a coin once with every version that sent it', () => {
    const t = dailyPost([state(), state({ version: 'trend-daily-v006' })], [], today);
    expect(t).toContain('🟢 BUY SOL <i>(v005, v006)</i>');
    expect(t.match(/BUY SOL/g)).toHaveLength(1);
  });
});
