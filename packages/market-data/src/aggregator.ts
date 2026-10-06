import type { Trade, Quote, Snapshot } from '../../domain/src/index.js';
interface Bucket {
  trades: Trade[];
  ids: Set<number>;
  quote?: Quote;
}
export class Aggregator {
  private buckets = new Map<string, Bucket>();
  private closedThrough: number;
  private invalidEnds = new Set<number>();
  private carriedQuotes = new Map<string, Quote>();
  public counters = { duplicates: 0, late: 0 };
  constructor(
    private symbols: string[],
    start: number,
    private quoteMaxAge = 5000,
    private historical = false,
  ) {
    this.closedThrough = Math.floor(start / 1000) * 1000;
    if (start % 1000) this.invalidEnds.add(this.closedThrough + 1000);
  }
  invalidate(from: number, to: number) {
    for (
      let end = (Math.floor(from / 1000) + 1) * 1000;
      end <= (Math.floor(to / 1000) + 1) * 1000;
      end += 1000
    )
      this.invalidEnds.add(end);
  }
  quote(q: Quote) {
    const end = (Math.floor(q.ts / 1000) + 1) * 1000;
    const key = `${q.symbol}:${end}`;
    const b = this.buckets.get(key) ?? { trades: [], ids: new Set<number>() };
    b.quote = q;
    this.buckets.set(key, b);
  }
  trade(t: Trade) {
    const end = (Math.floor(t.ts / 1000) + 1) * 1000;
    if (end <= this.closedThrough) {
      this.counters.late++;
      return;
    }
    const key = `${t.symbol}:${end}`;
    const b = this.buckets.get(key) ?? { trades: [], ids: new Set<number>() };
    if (b.ids.has(t.id)) {
      this.counters.duplicates++;
      return;
    }
    b.ids.add(t.id);
    b.trades.push(t);
    this.buckets.set(key, b);
  }
  *flushBatches(
    watermark: number,
    connected = true,
    batchSeconds = 60,
  ): Generator<Snapshot[]> {
    if (!Number.isInteger(batchSeconds) || batchSeconds < 1)
      throw new Error('Invalid flush batch size');
    const last = Math.floor(watermark / 1000) * 1000;
    while (this.closedThrough < last)
      yield this.flush(
        Math.min(last, this.closedThrough + batchSeconds * 1000),
        connected,
      );
  }
  flush(watermark: number, connected = true): Snapshot[] {
    const rows: Snapshot[] = [];
    const last = Math.floor(watermark / 1000) * 1000;
    for (let end = this.closedThrough + 1000; end <= last; end += 1000)
      for (const symbol of this.symbols) {
        const key = `${symbol}:${end}`,
          b = this.buckets.get(key);
        const trades = (b?.trades ?? []).sort(
          (a, b) => a.ts - b.ts || a.id - b.id,
        );
        const quote = b?.quote ?? this.carriedQuotes.get(symbol);
        if (b?.quote) this.carriedQuotes.set(symbol, b.quote);
        const q =
          quote && quote.ts < end && end - quote.ts <= this.quoteMaxAge
            ? quote
            : undefined;
        const prices = trades.map((t) => t.price);
        const volume = trades.reduce((v, t) => v + t.price * t.quantity, 0);
        const buy = trades
          .filter((t) => !t.buyerMaker)
          .reduce((v, t) => v + t.price * t.quantity, 0);
        const latencies = trades
          .filter((t) => t.receivedAt !== null)
          .map((t) => t.receivedAt! - t.ts);
        rows.push({
          ts: end,
          symbol,
          open: prices[0] ?? null,
          high: prices.length ? Math.max(...prices) : null,
          low: prices.length ? Math.min(...prices) : null,
          close: prices.at(-1) ?? null,
          baseVolume: trades.reduce((v, t) => v + t.quantity, 0),
          quoteVolume: volume,
          buyQuoteVolume: buy,
          sellQuoteVolume: volume - buy,
          tradeCount: trades.length,
          bestBid: q?.bid ?? null,
          bestAsk: q?.ask ?? null,
          spreadBps: q
            ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10000
            : null,
          sourceLatencyMs: latencies.length
            ? latencies.reduce((a, b) => a + b, 0) / latencies.length
            : null,
          isComplete:
            connected &&
            !this.invalidEnds.has(end) &&
            (this.historical ? trades.length > 0 : !!q),
          quoteTs: q?.ts ?? null,
          quoteClock: q ? 'receipt' : null,
        });
        this.buckets.delete(key);
      }
    for (const end of this.invalidEnds)
      if (end <= last) this.invalidEnds.delete(end);
    this.closedThrough = Math.max(this.closedThrough, last);
    return rows;
  }
}
