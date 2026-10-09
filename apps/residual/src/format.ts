import type {
  ResidualConfig,
  ResidualSignal,
} from '../../../packages/signals/src/residual.js';
import { escapeHtml } from '../../../packages/notify/src/index.js';

const iso = (ts: number) => new Date(ts).toISOString().replace('.000Z', 'Z');
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
export const px = (p: number) => Number(p.toPrecision(6)).toString();
export function describeSignal(s: ResidualSignal, c: ResidualConfig) {
  const alt = s.symbol.replace(/USDT$/, ''),
    exitBy = iso(s.entryAtTs + s.holdMs).slice(11, 16),
    head =
      s.instrument === 'outright'
        ? `${s.side} ${alt} (spot) ref ${px(s.referencePrice)} | enter at ~${iso(s.entryAtTs).slice(11, 16)} UTC, skip above ${px(s.entryPriceLimit!)} | target ${px(s.targetPrice!)} (+${pct(s.targetBps)}) | stop ${px(s.stopPrice!)} (-${pct(s.stopBps)}) | exit by ${exitBy} UTC`
        : `PAIR ${s.side} ${alt} / ${s.side === 'LONG' ? 'SHORT' : 'LONG'} ${s.beta.toFixed(2)}x BTC per 1x ${alt} | target spread +${pct(s.targetBps)} | stop -${pct(s.stopBps)} | exit by ${exitBy} UTC`;
  return `${head}\n  why: BTC ${s.btcMoveBps >= 0 ? '+' : ''}${pct(s.btcMoveBps)} over ${c.lookbackMs / 3600000}h; ${alt} ${s.altMoveBps >= 0 ? '+' : ''}${pct(s.altMoveBps)}, lagging its ${s.beta.toFixed(2)} beta by ${pct(s.lagBps)} (z ${s.residualZ.toFixed(2)}); recent catch-up ${(s.fit.reversion * 100).toFixed(0)}% (t ${s.fit.reversionT.toFixed(1)}); expected net ${s.expectedNetBps.toFixed(0)}bps after ${s.costBps.toFixed(0)}bps costs; score ${s.score} (heuristic, not a win probability)`;
}

/** Telegram HTML card for a signal; describeSignal stays the plain ledger/console text. */
export function telegramSignal(s: ResidualSignal, c: ResidualConfig) {
  const alt = escapeHtml(s.symbol.replace(/USDT$/, '')),
    hhmm = (ts: number) => iso(ts).slice(11, 16),
    sign = (bps: number) => `${bps >= 0 ? '+' : ''}${pct(bps)}`,
    long = s.side === 'LONG';
  const body =
    s.instrument === 'outright'
      ? [
          `${long ? '🟢' : '🔴'} <b>${s.side} ${alt}</b> · spot`,
          '',
          `▸ <b>Ref</b>      <code>${px(s.referencePrice)}</code>`,
          `▸ <b>Enter</b>    ~${hhmm(s.entryAtTs)} UTC, skip above <code>${px(s.entryPriceLimit!)}</code>`,
          `▸ <b>Target</b>   <code>${px(s.targetPrice!)}</code>  (+${pct(s.targetBps)})`,
          `▸ <b>Stop</b>     <code>${px(s.stopPrice!)}</code>  (-${pct(s.stopBps)})`,
          `▸ <b>Exit by</b>  ${hhmm(s.entryAtTs + s.holdMs)} UTC`,
        ]
      : [
          `⚖️ <b>PAIR ${s.side} ${alt}</b> / ${long ? 'SHORT' : 'LONG'} BTC`,
          '',
          `▸ <b>Size</b>     ${s.beta.toFixed(2)}x BTC per 1x ${alt}`,
          `▸ <b>Target</b>   spread +${pct(s.targetBps)}`,
          `▸ <b>Stop</b>     spread -${pct(s.stopBps)}`,
          `▸ <b>Exit by</b>  ${hhmm(s.entryAtTs + s.holdMs)} UTC`,
        ];
  return [
    ...body,
    '',
    '<b>Why</b>',
    `• BTC ${sign(s.btcMoveBps)} over ${c.lookbackMs / 3600000}h, ${alt} ${sign(s.altMoveBps)}`,
    `• Lagging its ${s.beta.toFixed(2)} beta by ${pct(s.lagBps)} (z ${s.residualZ.toFixed(2)})`,
    `• Recent catch-up ${(s.fit.reversion * 100).toFixed(0)}% (t ${s.fit.reversionT.toFixed(1)})`,
    `• Expected net ${s.expectedNetBps.toFixed(0)}bps after ${s.costBps.toFixed(0)}bps costs`,
    '',
    `<i>${escapeHtml(c.version)} · score ${s.score} (heuristic) · paper signal, not advice</i>`,
  ].join('\n');
}
