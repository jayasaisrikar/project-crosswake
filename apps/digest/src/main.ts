import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { fetchContext } from '../../../packages/context/src/index.js';
import {
  checkDraft,
  coinFacts,
  digestPrompt,
  factSheet,
  postToHtml,
  slotOf,
  templatePost,
  type EngineFact,
} from '../../../packages/context/src/digest.js';
import { deliver, sinksFromEnv } from '../../../packages/notify/src/index.js';
import { resolveModel } from '../../../packages/research-runtime/src/model.js';

const root = process.env.CROSSWAKE_DATA ?? 'data',
  out = join(root, 'digest'),
  hours = Number(process.env.DIGEST_HOURS ?? 4),
  symbols = (
    process.env.DIGEST_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,HYPE'
  ).split(','),
  once = process.argv.includes('--once'),
  dryRun = process.argv.includes('--dry-run');

async function engines(): Promise<EngineFact[]> {
  const dir = join(root, 'trend', 'live'),
    out: EngineFact[] = [];
  for (const id of (await readdir(dir).catch(() => [] as string[])).sort())
    try {
      const s = JSON.parse(await readFile(join(dir, id, 'state.json'), 'utf8'));
      out.push({
        version: s.version,
        open: (s.open ?? []).map((o: any) => ({
          symbol: o.symbol,
          side: o.side,
        })),
        regimeOn: s.kind === 'htf-rsi' ? undefined : s.regime?.on,
        closedTrades: s.stats?.trades ?? 0,
      });
    } catch {}
  return out;
}

/** Model draft if it passes the fact check, else the deterministic template. */
async function compose(facts: ReturnType<typeof factSheet>) {
  const model = process.env.RESEARCH_MODEL;
  if (!model)
    return {
      text: templatePost(facts),
      source: 'template',
      reason: 'no_model',
    };
  try {
    const agent = new Agent({
      id: 'crosswake-digest',
      name: 'Crosswake Digest',
      model: resolveModel(model),
      instructions:
        'You write concise, factual crypto market updates. You never give trade advice or predictions and never introduce numbers that are not in the facts you are given.',
    });
    const r = await agent.generate(digestPrompt(facts));
    const check = checkDraft(r.text, facts);
    return check.ok
      ? { text: r.text.trim(), source: model, reason: null }
      : { text: templatePost(facts), source: 'template', reason: check.reason };
  } catch (error) {
    return {
      text: templatePost(facts),
      source: 'template',
      reason: `model_error:${String(error).slice(0, 80)}`,
    };
  }
}

async function main() {
  const key = process.env.ALTFINS_API_KEY;
  if (!key) throw new Error('ALTFINS_API_KEY is not configured');
  const { sinks } = sinksFromEnv(process.env);
  await mkdir(out, { recursive: true });
  const sentPath = join(out, 'delivered.json'),
    sent = new Set<string>(
      existsSync(sentPath) ? JSON.parse(await readFile(sentPath, 'utf8')) : [],
    );
  for (;;) {
    const slot = slotOf(Date.now(), hours),
      id = `digest-${slot}`;
    if (!sent.has(id) || dryRun) {
      try {
        const ctx = await fetchContext(key, symbols),
          facts = factSheet(
            coinFacts(ctx.payload),
            await engines(),
            ctx.availableAt,
          ),
          post = await compose(facts);
        if (dryRun)
          console.log(post.text, '\n', {
            source: post.source,
            reason: post.reason,
          });
        else {
          const d = await deliver(sinks, {
            kind: 'analysis',
            id,
            at: slot,
            text: postToHtml(post.text),
            html: true,
          });
          await writeFile(
            join(out, 'posts.jsonl'),
            JSON.stringify({ id, at: Date.now(), ...post, deliveries: d }) +
              '\n',
            { flag: 'a' },
          );
          if (d.every((x) => x.ok)) sent.add(id);
          await writeFile(sentPath, JSON.stringify([...sent].slice(-500)));
          console.log({
            id,
            source: post.source,
            reason: post.reason,
            delivered: d.map((x) => `${x.sink}:${x.ok}`),
          });
        }
      } catch (error) {
        console.error(String(error));
      }
    }
    if (once || dryRun) return;
    // Post ~5 minutes after each slot opens so the 4h candle has closed on altFINS; retry failures every 10 minutes.
    const next = slotOf(Date.now(), hours) + hours * 3_600_000 + 5 * 60_000,
      wait = sent.has(`digest-${slotOf(Date.now(), hours)}`)
        ? next - Date.now()
        : 10 * 60_000;
    await new Promise((r) => setTimeout(r, Math.max(60_000, wait)));
  }
}
await main();
