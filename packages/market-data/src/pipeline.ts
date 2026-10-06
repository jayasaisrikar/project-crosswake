import type { JournalRecord } from '../../domain/src/journal.js';
import type { Snapshot } from '../../domain/src/index.js';
import { JournalReplay } from './journal.js';
export class IngestionPipeline {
  private pending: JournalRecord[] = [];
  private draining: Promise<void> | undefined;
  private failure: unknown;
  private rows: Snapshot[] = [];
  readonly replay = new JournalReplay();
  constructor(
    private journal: (records: JournalRecord[]) => Promise<void>,
    private snapshots: (rows: Snapshot[]) => Promise<void>,
    private capacity = 10000,
    private batchSize = 256,
    private onClosed: (rows: Snapshot[]) => Promise<void> = async () => {},
  ) {}
  push(record: JournalRecord) {
    if (this.failure) throw this.failure;
    if (this.pending.length >= this.capacity) {
      this.failure = new Error('Ingestion queue capacity exceeded');
      throw this.failure;
    }
    this.pending.push(record);
    if (!this.draining) this.draining = this.drain();
  }
  private async drain() {
    try {
      while (this.pending.length) {
        if (this.failure) throw this.failure;
        const batch = this.pending.splice(0, this.batchSize);
        await this.journal(batch);
        for (const record of batch)
          for (const rows of this.replay.applyBatches(record)) {
            await this.onClosed(rows);
            this.rows.push(...rows);
            if (this.rows.length >= 180) {
              await this.snapshots(this.rows);
              this.rows = [];
            }
          }
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.draining = undefined;
    }
  }
  async idle() {
    while (this.draining) await this.draining;
    if (this.failure) throw this.failure;
  }
  async close() {
    await this.idle();
    if (this.rows.length) {
      await this.snapshots(this.rows);
      this.rows = [];
    }
  }
  get diagnostics() {
    return {
      pending: this.pending.length,
      bufferedRows: this.rows.length,
      ...this.replay.counters,
      failed: !!this.failure,
    };
  }
}
