import { epochMs, tradeSchema } from '../../domain/src/index.js';
export function parseArchiveTrade(line: string, symbol: string) {
  const c = line.split(',');
  return tradeSchema.parse({
    kind: 'trade',
    symbol,
    id: Number(c[0]),
    price: Number(c[1]),
    quantity: Number(c[2]),
    ts: epochMs(Number(c[4])),
    buyerMaker:
      c[5]?.toLowerCase() === 'true'
        ? true
        : c[5]?.toLowerCase() === 'false'
          ? false
          : undefined,
    receivedAt: null,
  });
}
