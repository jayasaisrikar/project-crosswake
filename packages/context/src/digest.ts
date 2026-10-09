/**
 * 4-hourly market digest for the Telegram channel. Facts are computed here from altFINS and the
 * engines' own state; a model may only rephrase them, and any number it invents rejects its draft.
 */
import { escapeHtml } from '../../notify/src/index.js';

export interface CoinFact {
  symbol: string;
  price: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
}
export interface EngineFact {
  version: string;
  open: { symbol: string; side?: string }[];
  regimeOn?: boolean;
  closedTrades: number;
}

const num = (x: unknown) => {
  const n = Number(String(x ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** Rows from an altFINS screener payload (contract validated by fetchContext). */
export function coinFacts(payload: any): CoinFact[] {
  return (payload?.content ?? []).map((r: any) => ({
    symbol: String(r.symbol),
    price: num(r.lastPrice) ?? NaN,
    rsi: num(r.additionalData?.RSI14),
    macd: num(r.additionalData?.MACD),
    macdSignal: num(r.additionalData?.MACD_SIGNAL_LINE),
  }));
}

export const fmtPrice = (p: number) =>
  p >= 1000
    ? Math.round(p).toLocaleString('en-US')
    : p >= 1
      ? p.toFixed(2)
      : p.toPrecision(4);
const zone = (rsi: number) =>
  rsi >= 70
    ? 'overbought'
    : rsi <= 30
      ? 'oversold'
      : rsi >= 55
        ? 'firm'
        : rsi <= 45
          ? 'soft'
          : 'neutral';

/** One line per coin plus our engines; every number a post may contain appears here. */
export function factSheet(
  coins: CoinFact[],
  engines: EngineFact[],
  at: number,
) {
  const lines = coins
    .filter((c) => Number.isFinite(c.price))
    .map((c) => {
      const parts = [`${c.symbol} ${fmtPrice(c.price)}`];
      if (c.rsi !== null)
        parts.push(`4h RSI ${c.rsi.toFixed(1)} (${zone(c.rsi)})`);
      if (c.macd !== null && c.macdSignal !== null)
        parts.push(
          `MACD ${c.macd > c.macdSignal ? 'above' : 'below'} signal (momentum ${c.macd > c.macdSignal ? 'improving' : 'fading'})`,
        );
      return parts.join(', ');
    });
  const rsis = coins.map((c) => c.rsi).filter((x): x is number => x !== null),
    breadth = rsis.length
      ? `${rsis.filter((r) => r > 50).length} of ${rsis.length} coins have 4h RSI above 50`
      : null,
    engineLines = engines.map((e) => {
      const name = e.version.replace(/^.*-(v\d+)$/, '$1');
      const open = e.open.length
        ? `holding ${e.open.map((o) => `${o.symbol.replace(/USDT$/, '')}${o.side ? ` ${o.side}` : ''}`).join(', ')}`
        : 'no open positions';
      const regime =
        e.regimeOn === undefined
          ? ''
          : e.regimeOn
            ? ', daily BTC trend filter on (BTC above its 100-day average, so new entries are allowed)'
            : ', daily BTC trend filter off (BTC below its 100-day average, so no new entries)';
      return `Crosswake ${name}: ${open}${regime}`;
    });
  const stamp =
    new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return { stamp, lines, breadth, engineLines };
}
export type Facts = ReturnType<typeof factSheet>;

const DISCLAIMER = 'Market context, not financial advice.';

/** The fallback post, and the reference the model rewrites. */
export function templatePost(f: Facts) {
  return [
    `📊 Market check · ${f.stamp}`,
    '',
    ...f.lines.map((l) => `• ${l}`),
    ...(f.breadth ? ['', `Breadth: ${f.breadth}.`] : []),
    ...(f.engineLines.length
      ? ['', ...f.engineLines.map((l) => `🤖 ${l}`)]
      : []),
    '',
    `Source: altFINS 4h indicators. ${DISCLAIMER}`,
  ].join('\n');
}

export const digestPrompt = (f: Facts) =>
  `Write a short Telegram market update (under 900 characters) from these facts only.

FACTS
${templatePost(f)}

RULES
- Use only numbers that appear in FACTS, written exactly as they appear. Add no new numbers, percentages, targets or dates.
- Say what the indicators show (strength, weakness, mixed). No buy/sell calls, no predictions, no price targets.
- Open with a one-line headline, then 3-6 short lines. Plain prose, a few emoji at most: no markdown, no asterisks, no hashes.
- Mention what the Crosswake engines are doing in one line, in plain words.
- If the daily BTC trend filter is on while 4h RSI readings are weak or oversold, say plainly that the longer daily trend is still up while short-term 4h momentum is weak. Do not present the two as contradicting each other.
- End with exactly: "Source: altFINS 4h indicators. ${DISCLAIMER}"`;

const numbersIn = (s: string) =>
  (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ''));
const BANNED =
  /\b(buy now|sell now|price target|will (?:hit|reach|pump|dump)|guarantee|100x|moon)\b/i;

/** Accepts a model draft only if every number in it came from the facts and it carries the disclaimer. */
export function checkDraft(
  draft: string,
  f: Facts,
): { ok: true } | { ok: false; reason: string } {
  const text = draft.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > 1500) return { ok: false, reason: 'too_long' };
  if (!text.includes(DISCLAIMER))
    return { ok: false, reason: 'missing_disclaimer' };
  if (BANNED.test(text)) return { ok: false, reason: 'advice_language' };
  const allowed = new Set(numbersIn(templatePost(f)));
  const stray = numbersIn(text).filter((n) => !allowed.has(n));
  if (stray.length)
    return {
      ok: false,
      reason: `unsourced_numbers:${stray.slice(0, 5).join(',')}`,
    };
  return { ok: true };
}

/** Start of the 4h slot a post belongs to; posts go out a few minutes after each 4h close. */
export const slotOf = (ts: number, hours = 4) =>
  Math.floor(ts / (hours * 3_600_000)) * hours * 3_600_000;

/**
 * Telegram HTML card for an analysis post. The model writes plain prose, so the markup stays ours:
 * bold the headline, italicise the source line, escape the rest. A draft therefore cannot produce
 * malformed HTML, which Telegram rejects outright instead of rendering.
 */
export function postToHtml(text: string) {
  const lines = text.split('\n').map((l) => l.trimEnd()),
    head = lines.findIndex((l) => l.trim().length > 0);
  return lines
    .map((line, i) => {
      const body = escapeHtml(line);
      if (i === head) return `<b>${body}</b>`;
      if (/^Source:/i.test(line.trim())) return `<i>${body}</i>`;
      return body;
    })
    .join('\n');
}
