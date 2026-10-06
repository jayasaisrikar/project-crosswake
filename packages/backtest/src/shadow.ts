import type { Snapshot } from '../../domain/src/index.js';
import { SignalEngine, type StrategyConfig } from '../../signals/src/index.js';
import { PaperBacktester } from './index.js';
export interface ShadowEvent {
  kind: string;
  [key: string]: unknown;
}
/** Forward-only paper simulation; no exchange orders or keys. */
export class ShadowRuntime {
  readonly engine: SignalEngine;
  readonly paper: PaperBacktester;
  private candidateCount = 0;
  private closedTrades = 0;
  private stepCount = 0;
  private lastTs = 0;
  private lastDecisionAt = 0;
  constructor(
    config: StrategyConfig,
    private emit: (events: ShadowEvent[]) => Promise<void>,
    private clock: () => number = Date.now,
  ) {
    this.engine = new SignalEngine(config);
    this.paper = new PaperBacktester(this.engine.config);
  }
  async step(rows: Snapshot[]) {
    if (!rows.length) return;
    const ts = rows[0]!.ts;
    this.paper.update(rows);
    const candidates = this.engine.update(rows);
    const decisionAt = this.clock();
    if (
      !Number.isSafeInteger(decisionAt) ||
      decisionAt < Math.max(...rows.map((r) => r.availableAt ?? r.ts)) ||
      decisionAt < this.lastDecisionAt
    )
      throw new Error('Shadow clock precedes availability or moved backwards');
    this.lastDecisionAt = decisionAt;
    for (const candidate of candidates)
      candidate.decisionTs = Math.max(candidate.decisionTs, decisionAt);
    this.paper.submit(candidates);
    this.stepCount++;
    this.lastTs = ts;
    this.candidateCount += candidates.length;
    this.closedTrades += this.paper.trades.length;
    const events: ShadowEvent[] = [
      { kind: 'step', ts, decisionAt },
      { ...this.paper.unfinished, kind: 'state', ts },
    ];
    events.push(
      ...this.paper.entries
        .splice(0)
        .map((entry) => ({ kind: 'entry', ...entry })),
      ...this.paper.trades
        .splice(0)
        .map((trade) => ({ kind: 'trade', ...trade })),
      ...this.paper.rejections
        .splice(0)
        .map((rejection) => ({ kind: 'entry_rejection', ...rejection })),
      ...candidates.map((candidate) => ({ kind: 'candidate', candidate })),
    );
    await this.emit(events);
  }
  async rows(rows: Snapshot[]) {
    let batch: Snapshot[] = [];
    for (const row of rows) {
      if (batch.length && row.ts !== batch[0]!.ts) {
        await this.step(batch);
        batch = [];
      }
      batch.push(row);
    }
    if (batch.length) await this.step(batch);
  }
  async close() {
    await this.emit([
      {
        kind: 'session_end',
        ts: this.clock(),
        configHash: this.engine.configHash,
        unfinished: this.paper.openState,
        researchOnly: true,
      },
    ]);
  }
  get diagnostics() {
    return {
      mode: 'ADAPTIVE_EXPLORATORY_SHADOW',
      configHash: this.engine.configHash,
      steps: this.stepCount,
      lastTs: this.lastTs,
      lastDecisionAt: this.lastDecisionAt,
      candidates: this.candidateCount,
      closedTrades: this.closedTrades,
      ...this.paper.unfinished,
      engine: this.engine.diagnostics,
    };
  }
}
