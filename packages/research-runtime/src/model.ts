import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import { randomUUID } from 'node:crypto';

export const OPENCODE_GATEWAY_URL = 'https://opencode.ai/zen/go/v1';

/**
 * The Go gateway serves its families on different endpoints, and the model id is the only signal we
 * have: DeepSeek, GLM, Kimi, MiMo, LongCat and the stealth ids answer on `/chat/completions`, while
 * GPT, Grok and Muse answer on `/responses`. Anthropic-protocol ids (Claude, MiniMax, Qwen) need
 * `/messages` and are deliberately not selectable here.
 */
const CHAT_PROTOCOL =
  /^(?:glm-|kimi-|deepseek-|mimo-|longcat-|hy3|hy4-|space-bunny|step-|big-pickle)/;

export const usesChatProtocol = (name: string) =>
  name.endsWith('-free') || CHAT_PROTOCOL.test(name);

export function resolveModel(modelId: string): string | MastraModelConfig {
  const match = /^opencode\/(.+)$/.exec(modelId);
  const name = match?.[1];
  if (!match || !name) return modelId;
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey)
    throw new Error('OPENCODE_API_KEY is required for opencode/ models');
  const provider = createOpenAI({
    baseURL: OPENCODE_GATEWAY_URL,
    apiKey,
    headers: { 'x-opencode-session': randomUUID() },
  });
  return usesChatProtocol(name)
    ? provider.chat(name)
    : provider.responses(name);
}
