import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Agent } from '@mastra/core/agent';
import { createAskAgent, runAskTurn, type AskTurnResult } from './agent.js';
import type { RuntimePaths } from './experiments.js';
import { resolveModel } from './model.js';

export interface AskRouterOptions {
  paths: RuntimePaths;
  model?: string;
  token?: string;
  now?: () => number;
  limits?: Partial<AskLimits>;
  turnTimeoutMs?: number;
  turn?: (input: z.infer<typeof askInput>) => Promise<AskTurnResult>;
}

export interface AskLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
  globalPerDay: number;
  maxConcurrent: number;
}

const DEFAULT_LIMITS: AskLimits = {
  perMinute: 4,
  perHour: 20,
  perDay: 60,
  globalPerDay: 400,
  maxConcurrent: 2,
};

const askInput = z
  .object({
    question: z.string().trim().min(3).max(600),
    history: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(1000),
          })
          .strict(),
      )
      .max(6)
      .optional(),
  })
  .strict();

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status;
  response.end(JSON.stringify(body));
};

async function readBody(request: IncomingMessage, limit: number) {
  if (!/^application\/json\b/.test(request.headers['content-type'] ?? ''))
    throw Object.assign(new Error('json_required'), { status: 415 });
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit)
      throw Object.assign(new Error('body_too_large'), { status: 413 });
  }
  try {
    return askInput.parse(body ? JSON.parse(body) : {});
  } catch (error) {
    if (error instanceof z.ZodError)
      throw Object.assign(new Error('invalid_request'), { status: 400 });
    throw Object.assign(new Error('invalid_request'), { status: 400 });
  }
}

/**
 * `POST /research/chat`: the public question surface over the live record.
 *
 * The route only ever calls read-only tools, and it is bounded on four axes - request size,
 * per-caller rate, concurrency and wall-clock time - so a public caller cannot use it to
 * exhaust model quota or hold the process open.
 */
export function createAskRouter(options: AskRouterOptions) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits },
    now = options.now ?? Date.now,
    turnTimeoutMs = options.turnTimeoutMs ?? 120_000,
    windows = new Map<string, number[]>(),
    global: { at: number; count: number } = { at: 0, count: 0 };
  let inFlight = 0;
  let agent: Agent | null = null;
  let agentError: string | null = null;

  const within = (key: string, ms: number, max: number) => {
    const cutoff = now() - ms,
      stamps = (windows.get(key) ?? []).filter((t) => t > cutoff);
    windows.set(key, stamps);
    return stamps.length < max;
  };
  const record = (key: string) => {
    const stamps = windows.get(key) ?? [];
    stamps.push(now());
    windows.set(key, stamps);
  };
  const caller = (request: IncomingMessage) => {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim();
    return (
      first ||
      request.headers['x-real-ip']?.toString() ||
      request.socket.remoteAddress ||
      'unknown'
    );
  };
  const agentOrNull = () => {
    if (agent) return agent;
    if (agentError) return null;
    if (!options.model) return null;
    try {
      agent = createAskAgent({
        model: resolveModel(options.model),
        paths: options.paths,
      });
    } catch (error) {
      agentError = String(error instanceof Error ? error.message : error);
    }
    return agent;
  };

  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
  ): Promise<boolean> {
    if (segments[0] !== 'research' || segments[1] !== 'chat') return false;
    if (segments.length !== 2) {
      send(response, 404, { error: 'not_found' });
      return true;
    }
    if ((request.method ?? 'GET') !== 'POST') {
      send(response, 405, { error: 'post_only' });
      return true;
    }
    if (!options.model) {
      send(response, 503, {
        error: 'chat_model_unconfigured',
        detail: 'RESEARCH_MODEL is not set on this host.',
      });
      return true;
    }
    const key = caller(request);
    for (const [label, ms, max] of [
      ['minute', 60_000, limits.perMinute],
      ['hour', 3_600_000, limits.perHour],
      ['day', 86_400_000, limits.perDay],
    ] as const)
      if (!within(`${key}:${label}`, ms, max)) {
        send(response, 429, {
          error: 'rate_limited',
          window: label,
          retryAfterSeconds: Math.ceil(ms / 1000),
        });
        return true;
      }
    if (global.at < now() - 86_400_000) global.count = 0;
    if (global.count >= limits.globalPerDay) {
      send(response, 429, { error: 'chat_budget_exhausted', window: 'day' });
      return true;
    }
    if (inFlight >= limits.maxConcurrent) {
      send(response, 429, { error: 'chat_busy', retryAfterSeconds: 10 });
      return true;
    }
    let input: z.infer<typeof askInput>;
    try {
      input = await readBody(request, 8192);
    } catch (error) {
      send(response, (error as { status?: number }).status ?? 400, {
        error: String((error as Error).message),
      });
      return true;
    }
    const run =
      options.turn ??
      (async (body: z.infer<typeof askInput>) => {
        const active = agentOrNull();
        if (!active)
          throw Object.assign(
            new Error(agentError ?? 'chat_model_unconfigured'),
            { status: 503 },
          );
        return runAskTurn(active, body);
      });
    for (const label of ['minute', 'hour', 'day']) record(`${key}:${label}`);
    global.at = now();
    global.count++;
    inFlight++;
    const started = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        run(input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Object.assign(new Error('chat_timeout'), { status: 504 })),
            turnTimeoutMs,
          );
        }),
      ]);
      if (!result.answer)
        throw Object.assign(new Error('chat_empty_answer'), { status: 502 });
      console.log(
        `chat turn ok in ${now() - started}ms: steps=${result.steps} tools=${result.sources.join(',') || 'none'} tokens=${result.usage.totalTokens ?? '?'}`,
      );
      send(response, 200, {
        answer: result.answer,
        sources: result.sources,
        steps: result.steps,
        model: options.model,
        usage: result.usage,
        latencyMs: now() - started,
      });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 502;
      console.warn(
        `chat turn failed after ${now() - started}ms: ${status} ${String((error as Error).message).slice(0, 120)}`,
      );
      send(response, status, {
        error:
          status === 502
            ? 'chat_model_failed'
            : String((error as Error).message),
        detail: String((error as Error).message).slice(0, 200),
      });
    } finally {
      if (timer) clearTimeout(timer);
      inFlight--;
    }
    return true;
  };
}
