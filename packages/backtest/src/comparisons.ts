import type { Snapshot } from '../../domain/src/index.js';
import type { Candidate, StrategyConfig } from '../../signals/src/index.js';
import { PaperBacktester, metrics } from './index.js';
import { riskReport } from './reports.js';

/** Same selected events and entry clocks; these are attribution controls, not independently optimized strategies. */
export class SameEventBenchmarks {
  private btc: PaperBacktester;
  private alt: PaperBacktester;
  private events = new Set<string>();
  constructor(config: StrategyConfig) {
    this.btc = new PaperBacktester(config, true);
    this.alt = new PaperBacktester(config, true);
  }
  update(rows: Snapshot[]) {
    this.btc.update(rows);
    this.alt.update(rows);
  }
  submit(candidates: Candidate[]) {
    const sorted = candidates
      .filter((c) => c.accepted && c.executable && c.side === 'LONG')
      .sort(
        (a, b) =>
          (b.predictedNetBps ?? b.confidence) -
            (a.predictedNetBps ?? a.confidence) ||
          a.symbol.localeCompare(b.symbol),
      );
    for (const c of sorted) {
      if (this.events.has(c.btcImpulseId)) continue;
      this.events.add(c.btcImpulseId);
      this.btc.submit([
        {
          ...c,
          id: `${c.id}-btc-control`,
          symbol: 'BTCUSDT',
          decisionPrice: c.btcDecisionPrice,
        },
      ]);
      if (c.actualReturn > 0)
        this.alt.submit([{ ...c, id: `${c.id}-alt-momentum-control` }]);
    }
  }
  report() {
    const result = (p: PaperBacktester) => ({
      metrics: metrics(p.trades),
      risk: riskReport(p.trades),
      unfinished: p.unfinished,
      rejections: p.rejections,
    });
    return {
      btc: result(this.btc),
      altMomentum: result(this.alt),
      selectedEvents: this.events.size,
      limitations: [
        'Same-event conditional controls; not unconditional market-wide strategy comparisons',
        'Fixed holding period, executable ask/bid, fees and size-cost proxy; no target, stop, price-limit or BTC-retrace filter',
        'No depth/queue model; incomplete paths and unfinished positions are not successful evidence',
      ],
    };
  }
}
