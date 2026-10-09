import { describe, expect, it } from 'vitest';
import {
  checkDraft,
  coinFacts,
  factSheet,
  postToHtml,
  slotOf,
  templatePost,
} from '../packages/context/src/digest.js';

const payload = {
  content: [
    {
      symbol: 'BTC',
      lastPrice: '81730.9157',
      additionalData: {
        RSI14: '30.981',
        MACD: '-897.96',
        MACD_SIGNAL_LINE: '-580.23',
      },
    },
    {
      symbol: 'SOL',
      lastPrice: '142.5',
      additionalData: { RSI14: '61.2', MACD: '1.2', MACD_SIGNAL_LINE: '0.8' },
    },
  ],
};
const facts = factSheet(
  coinFacts(payload),
  [{ version: 'trend-daily-v005', open: [], regimeOn: false, closedTrades: 0 }],
  Date.UTC(2026, 9, 9, 4, 5),
);

describe('digest', () => {
  it('builds facts from altFINS rows and our engines', () => {
    expect(facts.lines[0]).toBe(
      'BTC 81,731, 4h RSI 31.0 (soft), MACD below signal (momentum fading)',
    );
    expect(facts.lines[1]).toContain('firm');
    expect(facts.breadth).toBe('1 of 2 coins have 4h RSI above 50');
    expect(facts.engineLines[0]).toContain(
      'v005: no open positions, daily BTC trend filter off',
    );
  });
  it('the template passes its own check', () => {
    expect(checkDraft(templatePost(facts), facts)).toEqual({ ok: true });
  });
  it('rejects invented numbers, advice and a missing disclaimer', () => {
    const tail =
      'Source: altFINS 4h indicators. Market context, not financial advice.';
    expect(
      checkDraft(`BTC at 81,731 could reach 90,000. ${tail}`, facts),
    ).toMatchObject({ ok: false, reason: 'unsourced_numbers:90000' });
    expect(checkDraft(`BTC will hit new highs. ${tail}`, facts)).toMatchObject({
      ok: false,
      reason: 'advice_language',
    });
    expect(checkDraft('BTC 81,731 looks soft.', facts)).toMatchObject({
      ok: false,
      reason: 'missing_disclaimer',
    });
    expect(
      checkDraft(`BTC 81,731 looks soft, RSI 31.0. ${tail}`, facts),
    ).toEqual({ ok: true });
  });
  it('formats a post as Telegram HTML and escapes anything a draft might contain', () => {
    const html = postToHtml(
      '📊 Market check\n\n• BTC 82,727: RSI 42.7 (soft)\n\nSource: altFINS 4h indicators. Not advice.',
    );
    expect(html).toContain('<b>📊 Market check</b>');
    expect(html).toContain('<i>Source: altFINS 4h indicators. Not advice.</i>');
    // A draft carrying markup must arrive as literal text, not as markup.
    expect(postToHtml('Head\n\n<b>not bold</b> & more')).toBe(
      '<b>Head</b>\n\n&lt;b&gt;not bold&lt;/b&gt; &amp; more',
    );
  });

  it('slots posts on 4h boundaries', () => {
    expect(slotOf(Date.UTC(2026, 9, 9, 7, 59))).toBe(Date.UTC(2026, 9, 9, 4));
  });
});
