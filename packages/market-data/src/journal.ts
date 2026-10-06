import { Aggregator } from './aggregator.js';
import type { JournalRecord } from '../../domain/src/journal.js';
import type { Snapshot } from '../../domain/src/index.js';
/** Replays receipt order, including recorded closure and connection boundaries. */
export class JournalReplay {
  private agg: Aggregator | undefined;
  private disconnectedAt = 0;
  private lastWatermark = 0;
  public get counters() {
    return this.agg?.counters ?? { duplicates: 0, late: 0 };
  }
  apply(record: JournalRecord): Snapshot[] {
    return [...this.applyBatches(record)].flat();
  }
  *applyBatches(record: JournalRecord): Generator<Snapshot[]> {
    if (record.kind === 'session') {
      this.agg = new Aggregator(record.symbols, record.ts, record.quoteMaxAge);
      this.disconnectedAt = record.ts;
      this.lastWatermark = 0;
      return;
    }
    if (!this.agg)
      throw new Error(
        'Journal must begin with a session record; legacy journals lack closure metadata',
      );
    if (record.kind === 'health') return;
    if (record.kind === 'connection') {
      if (record.connected) this.agg.invalidate(this.disconnectedAt, record.ts);
      else {
        this.disconnectedAt = record.ts;
        this.agg.invalidate(record.ts, record.ts);
      }
      return;
    }
    if (record.kind === 'trade') {
      this.agg.trade(record);
      return;
    }
    if (record.kind === 'quote') {
      this.agg.quote(record);
      return;
    }
    if (record.watermark < this.lastWatermark)
      throw new Error('Journal watermark moved backwards');
    this.lastWatermark = record.watermark;
    for (const rows of this.agg.flushBatches(
      record.watermark,
      record.connected,
    ))
      yield rows.map((row) => ({ ...row, availableAt: record.ts }));
  }
}
