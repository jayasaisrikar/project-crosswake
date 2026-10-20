import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Agent } from '@mastra/core/agent';
import {
  checkArticle,
  factSheet,
  factsHash,
  instruction,
  liveLines,
  planSchema,
  retryInstruction,
  templateBody,
  type Plan,
  type Topic,
} from '../../../packages/research-runtime/src/article-draft.js';
import {
  readArticle,
  readArticleIndex,
  upsertIndexEntry,
  writeArticle,
  type Article,
  type ArticleIndexEntry,
} from '../../../packages/research-runtime/src/articles.js';
import { resolveModel } from '../../../packages/research-runtime/src/model.js';
import {
  publicSnapshot,
  type PublicSnapshot,
} from '../../../packages/research-runtime/src/public-snapshot.js';

const num = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
};

const dataDir = resolve(process.env.CROSSWAKE_DATA ?? 'data'),
  topicsPath = process.env.RESEARCH_TOPICS ?? 'configs/research-topics.json',
  once = process.argv.includes('--once'),
  dryRun = process.argv.includes('--dry-run'),
  force = process.argv.includes('--force'),
  slugFlag = process.argv.indexOf('--slug'),
  onlySlug = slugFlag > 0 ? process.argv[slugFlag + 1] : undefined,
  intervalMs = num(
    process.env.RESEARCH_WRITER_INTERVAL_MS,
    6 * 3_600_000,
    600_000,
    7 * 86_400_000,
  ),
  cooldownMs = num(
    process.env.RESEARCH_WRITER_COOLDOWN_MS,
    3_600_000,
    60_000,
    86_400_000,
  ),
  timeoutMs = num(
    process.env.RESEARCH_WRITER_TIMEOUT_MS,
    90_000,
    10_000,
    300_000,
  ),
  attempts = num(process.env.RESEARCH_WRITER_ATTEMPTS, 2, 1, 3),
  maxCallsPerPass = num(
    process.env.RESEARCH_WRITER_MAX_CALLS_PER_PASS,
    3,
    1,
    40,
  ),
  statePath = join(dataDir, 'public', 'writer-state.json');

type State = {
  lastPassAt: number;
  cooldownUntil: number;
  lastError: string | null;
  lastCalls: number;
};
type Draft = {
  body: string | null;
  gate: 'model' | 'template';
  reason: string | null;
};

/** Provider throttling, an auth failure or a lapsed subscription: stop touching the gateway. */
const THROTTLED =
  /\b(429|rate.?limit|too many requests|quota|free ?tier|cooldown|payment|insufficient|402|401|403|unauthor|forbidden)\b/i;

const isThrottle = (error: unknown) =>
  error instanceof Error
    ? THROTTLED.test(error.message)
    : THROTTLED.test(String(error));

class Throttled extends Error {}

class Budget {
  calls = 0;
  spent() {
    return this.calls;
  }
  exhausted(limit: number) {
    return this.calls >= limit;
  }
}

async function readState(): Promise<State> {
  try {
    const parsed = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as Partial<State>;
    return {
      lastPassAt: Number(parsed.lastPassAt) || 0,
      cooldownUntil: Number(parsed.cooldownUntil) || 0,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      lastCalls: Number(parsed.lastCalls) || 0,
    };
  } catch {
    return { lastPassAt: 0, cooldownUntil: 0, lastError: null, lastCalls: 0 };
  }
}

async function writeState(state: State) {
  await mkdir(join(dataDir, 'public'), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function compose(
  topic: Topic,
  sheet: string,
  model: string,
  budget: Budget,
): Promise<Draft> {
  if (!model) return { body: null, gate: 'template', reason: 'no_model' };
  const agent = new Agent({
    id: 'crosswake-research-writer',
    name: 'Crosswake Research Writer',
    model: resolveModel(model),
    instructions:
      'You write evidence-led research notes about quantitative trading strategies. You never give advice or predictions, and you never introduce a number that was not handed to you.',
  });
  let prompt = instruction(topic, sheet),
    lastReason = 'unknown';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (budget.exhausted(maxCallsPerPass))
      return { body: null, gate: 'template', reason: 'call_budget_reached' };
    budget.calls += 1;
    try {
      const r = await agent.generate(prompt, {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      const check = checkArticle(r.text ?? '', sheet);
      if (check.ok) return { body: r.text.trim(), gate: 'model', reason: null };
      lastReason = check.reason;
      prompt = retryInstruction(prompt, check.reason);
    } catch (error) {
      if (isThrottle(error)) throw new Throttled(String(error));
      return {
        body: null,
        gate: 'template',
        reason: `model_error:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { body: null, gate: 'template', reason: `failed_gate:${lastReason}` };
}

async function buildTopic(
  topic: Topic,
  plan: Plan,
  snapshot: PublicSnapshot,
  index: ArticleIndexEntry[],
  model: string,
  budget: Budget,
): Promise<void> {
  const live = topic.engines ? liveLines(snapshot, topic.engines) : [],
    sheet = factSheet(topic, live),
    hash = factsHash(sheet),
    existing = await readArticle(dataDir, topic.slug);
  if (
    !force &&
    existing &&
    existing.generator.factsHash === hash &&
    existing.generator.model === (model || 'template')
  ) {
    console.log({ slug: topic.slug, action: 'unchanged' });
    return;
  }
  const draft = await compose(topic, sheet, model, budget),
    body = draft.gate === 'model' ? draft.body! : templateBody(topic, live),
    guard = checkArticle(body, sheet);
  if (!guard.ok) throw new Error(`draft failed its own gate: ${guard.reason}`);
  const now = new Date().toISOString();
  const article: Article = {
    slug: topic.slug,
    title: topic.title,
    description: topic.description,
    status: topic.status,
    tags: topic.tags,
    publishedAt: existing?.publishedAt ?? now,
    updatedAt: now,
    body,
    evidence: topic.facts.map((f) => ({ label: f.label, value: f.value })),
    sources: topic.sources ?? plan.defaults?.sources ?? [],
    generator: {
      model: model || 'template',
      factsHash: hash,
      gate: draft.gate,
    },
  };
  if (dryRun) {
    console.log(
      `--- ${topic.slug} gate=${draft.gate} reason=${String(draft.reason)}\n${body.slice(0, 500)}...`,
    );
    return;
  }
  await writeArticle(dataDir, article, upsertIndexEntry(index, article));
  console.log({
    slug: topic.slug,
    action: 'written',
    gate: draft.gate,
    reason: draft.reason ?? undefined,
    words: body.split(/\s+/).length,
  });
}

async function pass(plan: Plan, snapshot: PublicSnapshot, model: string) {
  const index = await readArticleIndex(dataDir),
    budget = new Budget();
  for (const topic of plan.topics) {
    if (onlySlug && topic.slug !== onlySlug) continue;
    if (budget.exhausted(maxCallsPerPass)) break;
    try {
      await buildTopic(topic, plan, snapshot, index, model, budget);
    } catch (error) {
      if (error instanceof Throttled) throw error;
      console.error({
        slug: topic.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return budget.spent();
}

const plan = planSchema.parse(JSON.parse(await readFile(topicsPath, 'utf8'))),
  model =
    process.env.RESEARCH_WRITER_MODEL?.trim() ||
    plan.defaults?.model?.trim() ||
    '';
if (!plan.defaults?.sources && plan.topics.some((topic) => !topic.sources))
  throw new Error(
    `${topicsPath}: every topic needs its own sources, or a defaults.sources block`,
  );

console.log(
  `Research writer: ${plan.topics.length} topics, model ${model || 'none (deterministic template only)'}, ` +
    `pass every ${Math.round(intervalMs / 60_000)} min, at most ${maxCallsPerPass} model calls per pass`,
);

let state = await readState(),
  stop = false,
  skipLoggedAt = 0;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stop = true;
  });

for (;;) {
  const now = Date.now(),
    sincePass = now - state.lastPassAt,
    cooling = now < state.cooldownUntil;
  if (!force && (cooling || sincePass < intervalMs)) {
    if (now - skipLoggedAt > intervalMs) {
      skipLoggedAt = now;
      console.log({
        action: 'pass_skipped',
        reason: cooling
          ? `throttled until ${new Date(state.cooldownUntil).toISOString()}`
          : `last pass ${Math.round(sincePass / 60_000)} min ago`,
        lastError: state.lastError ?? undefined,
      });
    }
  } else {
    let calls = 0,
      throttled: string | null = null;
    try {
      calls = await pass(plan, await publicSnapshot(dataDir), model);
    } catch (error) {
      throttled = error instanceof Error ? error.message : String(error);
    }
    state = {
      lastPassAt: Date.now(),
      cooldownUntil: throttled ? Date.now() + cooldownMs : state.cooldownUntil,
      lastError: throttled,
      lastCalls: calls,
    };
    skipLoggedAt = 0;
    if (!dryRun) await writeState(state);
    if (throttled)
      console.error({
        action: 'throttled',
        error: throttled,
        cooldownMinutes: cooldownMs / 60_000,
      });
  }
  if (once || stop) break;
  // Sleep in short chunks so a SIGTERM is honoured well inside systemd's stop timeout.
  await new Promise((r) => setTimeout(r, Math.min(intervalMs, 30_000)));
  if (stop) break;
}
