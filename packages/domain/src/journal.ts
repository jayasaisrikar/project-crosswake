import { z } from 'zod';
import { tradeSchema, symbolSchema } from './index.js';
export const quoteSchema = z
  .object({
    kind: z.literal('quote'),
    symbol: symbolSchema,
    bid: z.number().positive(),
    ask: z.number().positive(),
    ts: z.number().int().positive(),
    clock: z.literal('receipt'),
  })
  .refine((q) => q.ask >= q.bid, 'Crossed quote');
export const journalSchema = z.discriminatedUnion('kind', [
  tradeSchema,
  z.object({
    kind: z.literal('health'),
    ts: z.number().int().positive(),
    memoryBytes: z.number().nonnegative(),
    late: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }),
  quoteSchema,
  z.object({
    kind: z.literal('session'),
    ts: z.number().int().positive(),
    symbols: z.array(symbolSchema).min(1),
    quoteMaxAge: z.number().nonnegative(),
    latenessMs: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal('connection'),
    ts: z.number().int().positive(),
    connected: z.boolean(),
  }),
  z.object({
    kind: z.literal('flush'),
    ts: z.number().int().positive(),
    watermark: z.number().int().positive(),
    connected: z.boolean(),
  }),
]);
export type JournalRecord = z.infer<typeof journalSchema>;
