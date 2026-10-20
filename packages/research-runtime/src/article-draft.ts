import { createHash } from 'node:crypto';
import { z } from 'zod';
import { articleStatus } from './articles.js';
import type { PublicSnapshot } from './public-snapshot.js';

export const MAX_BODY_CHARS = Number(
  process.env.RESEARCH_WRITER_MAX_BODY ?? 14_000,
);
export const MIN_BODY_CHARS = Number(
  process.env.RESEARCH_WRITER_MIN_BODY ?? 900,
);
export const SECTION_FLOOR = Number(
  process.env.RESEARCH_WRITER_SECTION_FLOOR ?? 3,
);

export const sourceLink = z.object({
  label: z.string().min(1).max(80),
  href: z.string().min(1).max(300),
});

export const topicSchema = z.object({
  slug: z.string().min(3).max(80),
  title: z.string().min(8).max(120),
  description: z.string().min(40).max(300),
  status: articleStatus,
  tags: z.array(z.string().min(1).max(32)).min(1).max(8),
  angle: z.string().min(40),
  engines: z.array(z.string().min(1)).max(8).optional(),
  sources: z.array(sourceLink).min(1).max(8).optional(),
  facts: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .min(1)
    .max(40),
});
export type Topic = z.infer<typeof topicSchema>;

export const planSchema = z.object({
  version: z.number().int().positive(),
  defaults: z
    .object({
      model: z.string().min(1).max(120).optional(),
      sources: z.array(sourceLink).min(1).max(8).optional(),
    })
    .optional(),
  topics: z.array(topicSchema).min(1),
});
export type Plan = z.infer<typeof planSchema>;

export function numbersIn(text: string) {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) =>
    x.replace(/,/g, ''),
  );
}

const BANNED =
  /\b(buy now|sell now|price target|will (?:hit|reach|pump|dump)|guarantee|guaranteed|100x|moon|you should (?:buy|sell|invest))\b/i;

const ratio = (bps: number | null) =>
  bps === null ? null : `${(bps / 100).toFixed(2)}%`;

/** The live record for one topic's engines, as fact lines the model may quote. */
export function liveLines(snapshot: PublicSnapshot, ids: string[]): string[] {
  const lines: string[] = [],
    mine = snapshot.engines.filter((engine) => ids.includes(engine.id));
  for (const engine of mine) {
    if (engine.regimeOn !== null)
      lines.push(
        `${engine.version}: the Bitcoin market filter is ${engine.regimeOn ? 'on' : 'off'}.`,
      );
    lines.push(
      `${engine.version}: ${engine.positions.length} position${engine.positions.length === 1 ? '' : 's'} open on paper.`,
    );
    // A running mark is deliberately left out: it drifts with the market, so quoting it would both
    // date the prose and re-trigger a model call on every pass for no new information.
    for (const p of engine.positions)
      lines.push(
        `${engine.version} open: ${p.symbol}${p.side ? ` ${p.side}` : ''} since ${p.since ?? 'an unrecorded date'}.`,
      );
    if (engine.stats?.trades)
      lines.push(
        `${engine.version} closed trades so far: ${engine.stats.trades}, average ${ratio(engine.stats.netExpectancyBps)} net per trade.`,
      );
    for (const w of engine.watch)
      lines.push(
        `${engine.version} closest to its 20-day breakout: ${w.symbol} is ${ratio(w.toHighBps === null ? null : -w.toHighBps)} below its high.`,
      );
    for (const e of snapshot.events.filter(
      (event) => event.engine === engine.id,
    ))
      lines.push(
        `${engine.version} most recent ${e.kind}: ${e.symbol} on ${e.at.slice(0, 10)}${e.netBps === null ? '' : `, ${ratio(e.netBps)} net`}${e.reason ? `, closed on ${e.reason}` : ''}.`,
      );
  }
  if (mine.length)
    lines.push(`This live snapshot was read at ${snapshot.generatedAt}.`);
  return lines;
}

export function factSheet(topic: Topic, live: string[]) {
  return [
    `TITLE ${topic.title}`,
    `ABOUT ${topic.description}`,
    '',
    'FACTS',
    ...topic.facts.map((f) => `- ${f.label}: ${f.value}`),
    ...(live.length ? ['', 'LIVE RECORD', ...live.map((l) => `- ${l}`)] : []),
  ].join('\n');
}

export function instruction(topic: Topic, sheet: string) {
  const allowed = [...new Set(numbersIn(sheet))];
  return `Write one research article for Crosswake's public research page.

FACTS
${sheet}

WHAT THE ARTICLE MUST ARGUE
${topic.angle}

NUMBERS YOU ARE ALLOWED TO USE
${allowed.join(', ')}

RULES
- Every number in your article must be one of the numbers listed above, written exactly as it appears in FACTS. Do not invent, estimate, round, average or otherwise compute a number, and do not write a number that is not in that list.
- If something is not in FACTS, leave it out. Do not fill gaps from memory.
- Target 700 to 1000 words. Open with one short paragraph, then 3 to 5 sections, each starting with "## ".
- Explain cause and effect: what the rule was, what the measurement showed, and why it turned out that way.
- No advice, no predictions, no price targets, no recommendations about any coin or trade.
- State plainly when something is paper, unproven, inconclusive or failed. Never spin a failure into a lesson about future profits.
- Markdown only: "##" headings, short paragraphs and "-" bullets. No tables, no images, no bold headings, and no preamble such as "Here is the article".
- Do not add a disclaimer or a sources list. The page supplies those.`;
}

export function retryInstruction(base: string, reason: string) {
  return `${base}

YOUR PREVIOUS DRAFT WAS REJECTED (${reason}). Rewrite the whole article using only the allowed numbers.`;
}

/** The fallback body: the facts themselves, so it can never carry a number the record lacks. */
export function templateBody(topic: Topic, live: string[]) {
  return [
    topic.description,
    '',
    '## What the record says',
    ...topic.facts.map((f) => `- ${f.label}: ${f.value}`),
    '',
    '## Where the live record stands',
    ...(live.length
      ? live.map((l) => `- ${l}`)
      : [
          '- This note covers a frozen or retired result, and no live engine reports on it.',
        ]),
    '',
    '## How to check it',
    '- Every figure above is taken from the frozen test outputs and the live paper record.',
    '- The changelog dates every version and its result, and the strategy catalog lists the rules as they were frozen.',
    '- Positions described here are paper positions; no order is ever placed.',
  ].join('\n');
}

export const factsHash = (sheet: string) =>
  createHash('sha256').update(sheet).digest('hex').slice(0, 16);

export function checkArticle(
  body: string,
  sheet: string,
): { ok: true } | { ok: false; reason: string } {
  const text = body.trim();
  if (text.length < MIN_BODY_CHARS) return { ok: false, reason: 'too_short' };
  if (text.length > MAX_BODY_CHARS) return { ok: false, reason: 'too_long' };
  if ((text.match(/^## /gm) ?? []).length < SECTION_FLOOR)
    return { ok: false, reason: 'missing_sections' };
  if (BANNED.test(text)) return { ok: false, reason: 'advice_language' };
  const allowed = new Set(numbersIn(sheet)),
    stray = numbersIn(text).filter((n) => !allowed.has(n));
  if (stray.length)
    return {
      ok: false,
      reason: `unsourced_numbers:${stray.slice(0, 5).join(',')}`,
    };
  return { ok: true };
}
