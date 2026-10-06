import { z } from 'zod';
export const symbolSchema = z.string().regex(/^[A-Z0-9]{2,24}USDT$/);
export const tradeSchema = z.object({
  kind: z.literal('trade'),
  symbol: symbolSchema,
  id: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  receivedAt: z.number().int().positive().nullable(),
  price: z.number().positive(),
  quantity: z.number().positive(),
  buyerMaker: z.boolean(),
});
export type Trade = z.infer<typeof tradeSchema>;
export interface Quote {
  kind: 'quote';
  symbol: string;
  bid: number;
  ask: number;
  ts: number;
  clock: 'receipt';
}
export interface Snapshot {
  ts: number;
  symbol: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  baseVolume: number;
  quoteVolume: number;
  buyQuoteVolume: number;
  sellQuoteVolume: number;
  tradeCount: number;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  sourceLatencyMs: number | null;
  isComplete: boolean;
  availableAt?: number | null;
  quoteTs?: number | null;
  quoteClock: 'receipt' | null;
}
export function epochMs(value: number): number {
  return value >= 1e14 ? Math.floor(value / 1000) : value;
}
export function parseTrade(payload: unknown, receivedAt: number): Trade {
  const x = z
    .object({
      s: symbolSchema,
      t: z.number(),
      T: z.number(),
      p: z.string(),
      q: z.string(),
      m: z.boolean(),
    })
    .parse(payload);
  return tradeSchema.parse({
    kind: 'trade',
    symbol: x.s,
    id: x.t,
    ts: epochMs(x.T),
    receivedAt,
    price: Number(x.p),
    quantity: Number(x.q),
    buyerMaker: x.m,
  });
}
export function parseQuote(payload: unknown, receivedAt: number): Quote {
  const x = z
    .object({ s: symbolSchema, b: z.string(), a: z.string() })
    .parse(payload);
  const bid = z.number().positive().parse(Number(x.b)),
    ask = z.number().positive().parse(Number(x.a));
  if (ask < bid) throw new Error('Crossed quote');
  return {
    kind: 'quote',
    symbol: x.s,
    bid,
    ask,
    ts: receivedAt,
    clock: 'receipt',
  };
}

/** Quote-backed live reference, with trade-only historical fallback. Not a fill price. */
export function referencePrice(row: Snapshot): number | null {
  return row.bestBid !== null && row.bestAsk !== null
    ? (row.bestBid + row.bestAsk) / 2
    : row.close;
}
