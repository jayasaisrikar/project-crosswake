import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';
import { randomUUID } from 'node:crypto';

export const OPENCODE_GATEWAY_URL = 'https://opencode.ai/zen/go/v1';

export function resolveModel(modelId: string): string | MastraModelConfig {
  const match = /^opencode\/(.+)$/.exec(modelId);
  const name = match?.[1];
  if (!match || !name) return modelId;
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey)
    throw new Error('OPENCODE_API_KEY is required for opencode/ models');
  return createOpenAI({
    baseURL: OPENCODE_GATEWAY_URL,
    apiKey,
    headers: { 'x-opencode-session': randomUUID() },
  }).responses(name);
}
