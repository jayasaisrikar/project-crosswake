import { metrics, type PaperTrade } from './index.js';
import { riskReport } from './reports.js';
import { costStress } from './robustness.js';
import { MINUTE, type BarStore } from '../../quant/src/residual.js';
import type { FundingEvent } from '../../market-data/src/klines.js';
import {
  ResidualEngine,
  roundTripCostBps,
  type ResidualConfig,
  type ResidualSignal,
  type Side,
} from '../../signals/src/residual.js';

export interface ResidualTrade extends PaperTrade {
  side: Side;
  instrument: ResidualConfig['instrument'];
  executable: boolean;
  decisionTs: number;
  beta: number;
  btcEntryPrice: number;
  btcExitPrice: number;
  btcReturnBps: number;
  /** Alt return minus beta x BTC return over the holding period, before costs. */
  hedgedGrossBps: number;
  residualZ: number;
  lagBps: number;
  expectedNetBps: number;
  targetBps: number;
  stopBps: number;
  entryDriftBps: number;
}
export interface PendingEntry {
  signal: ResidualSignal;
}
export interface OpenPosition {
  signal: ResidualSignal;
  entryTs: number;
  entryPrice: number;
  btcEntryPrice: number;
  /** Log distances from the actual entry, in the position's favour. */
  target: number;
  stop: number;
  entryDriftBps: number;
  maeBps: number;
  mfeBps: number;
  lastObservedTs: number;
  observedGapMs: number;
}
export interface SimulatorState {
  configHash: string;
  lastCloseTs: number;
  pending: PendingEntry[];
  open: OpenPosition[];
  cooldownUntil: [string, number][];
}
export interface StepResult {
  signals: ResidualSignal[];
  queued: ResidualSignal[];
  opened: OpenPosition[];
  closed: ResidualTrade[];
}
const key = (side: Side, symbol: string) => `${side}|${symbol}`;

/**
 * Bar-by-bar paper simulation shared by research runs and live paper.
 * Decisions use bar closes; entries fill at the close of the bar ending at
 * decision + entry delay; exits are checked on later one-minute closes. Stops
 * fill at the observed close (adverse slippage kept); targets fill at the
 * target, never better. Costs are charged on every leg.
 */
export class ResidualSimulator {
  readonly trades: ResidualTrade[] = [];
  readonly rejections: Record<string, number> = {};
  private pending: PendingEntry[] = [];
  private open: OpenPosition[] = [];
  private cooldownUntil = new Map<string, number>();
  private lastCloseTs = -Infinity;
  constructor(
    readonly engine: ResidualEngine,
    private window: { startTs: number; endTs: number } = {
      startTs: -Infinity,
      endTs: Infinity,
    },
    /** Settled funding per symbol; required for usdm. Live mode may append to it. */
    readonly funding?: Map<string, FundingEvent[]>,
  ) {
    if (engine.config.market === 'usdm' && !funding)
      throw new Error('Perpetual simulation requires funding history');
  }
  private fundingRate(symbol: string, from: number, to: number) {
    let total = 0;
    for (const e of this.funding?.get(symbol) ?? [])
      if (e.ts > from && e.ts <= to) total += e.rate;
    return total;
  }
  private reject(reason: string) {
    this.rejections[reason] = (this.rejections[reason] ?? 0) + 1;
  }
  get unfinished() {
    return { pending: this.pending.length, openPositions: this.open.length };
  }
  get positions() {
    return [...this.open];
  }
  get state(): SimulatorState {
    return structuredClone({
      configHash: this.engine.configHash,
      lastCloseTs: this.lastCloseTs,
      pending: this.pending,
      open: this.open,
      cooldownUntil: [...this.cooldownUntil],
    });
  }
  restore(state: SimulatorState) {
    if (state.configHash !== this.engine.configHash)
      throw new Error('Simulator state belongs to another configuration');
    this.lastCloseTs = state.lastCloseTs;
    this.pending = structuredClone(state.pending);
    this.open = structuredClone(state.open);
    this.cooldownUntil = new Map(state.cooldownUntil);
  }
  /**
   * Advances one closed bar. `publish` may veto queuing a signal (live mode
   * drops signals that could not reach users in time).
   */
  step(
    store: BarStore,
    i: number,
    publish: (s: ResidualSignal) => boolean = () => true,
  ): StepResult {
    const c = this.engine.config,
      now = store.closeTimeAt(i);
    if (now <= this.lastCloseTs)
      throw new Error('Simulator requires chronological bars');
    this.lastCloseTs = now;
    const closed = this.exits(store, i, now),
      opened = this.entries(store, i, now);
    let signals: ResidualSignal[] = [];
    const queued: ResidualSignal[] = [];
    if (
      now >= this.window.startTs &&
      now + c.entryDelayMs + c.holdMs <= this.window.endTs &&
      this.engine.isEvaluationBar(store, i)
    ) {
      signals = this.engine.evaluate(store, i);
      for (const signal of signals) {
        if (!signal.accepted) continue;
        const k = key(signal.side, signal.symbol),
          busy =
            this.open.some((p) => key(p.signal.side, p.signal.symbol) === k) ||
            this.pending.some((p) => key(p.signal.side, p.signal.symbol) === k);
        if (busy) this.reject('symbol_busy');
        else if ((this.cooldownUntil.get(k) ?? -Infinity) > now)
          this.reject('cooldown');
        else if (
          this.open.filter((p) => p.signal.side === signal.side).length +
            this.pending.filter((p) => p.signal.side === signal.side).length >=
          c.maxConcurrentPositions
        )
          this.reject('capacity');
        else if (!publish(signal)) this.reject('not_published');
        else {
          this.pending.push({ signal });
          queued.push(signal);
        }
      }
    }
    return { signals, queued, opened, closed };
  }
  private entries(store: BarStore, i: number, now: number) {
    const opened: OpenPosition[] = [],
      hedged = this.engine.config.instrument === 'hedged';
    const remaining: PendingEntry[] = [];
    for (const p of this.pending) {
      const s = p.signal;
      if (s.entryAtTs > now) {
        remaining.push(p);
        continue;
      }
      if (s.entryAtTs < now) {
        this.reject('entry_window_missed');
        continue;
      }
      const price = store.close(s.symbol, i),
        btc = store.close('BTCUSDT', i);
      if (!Number.isFinite(price) || !Number.isFinite(btc)) {
        this.reject('missing_entry_bar');
        continue;
      }
      const direction = s.side === 'LONG' ? 1 : -1,
        drift =
          direction *
          (Math.log(price / s.referencePrice) -
            (hedged ? s.beta * Math.log(btc / s.btcReferencePrice) : 0));
      if (drift * 1e4 > this.engine.config.maxEntryDriftBps) {
        this.reject('entry_drift');
        continue;
      }
      const target = Math.min(s.targetBps, s.targetBps - drift * 1e4) / 1e4;
      if (target * 1e4 <= s.costBps) {
        this.reject('remaining_target_below_cost');
        continue;
      }
      const position: OpenPosition = {
        signal: s,
        entryTs: now,
        entryPrice: price,
        btcEntryPrice: btc,
        target,
        stop: s.stopBps / 1e4,
        entryDriftBps: drift * 1e4,
        maeBps: 0,
        mfeBps: 0,
        lastObservedTs: now,
        observedGapMs: 0,
      };
      this.open.push(position);
      opened.push(position);
    }
    this.pending = remaining;
    return opened;
  }
  private exits(store: BarStore, i: number, now: number) {
    const c = this.engine.config,
      hedged = c.instrument === 'hedged',
      closed: ResidualTrade[] = [],
      remaining: OpenPosition[] = [];
    for (const p of this.open) {
      const s = p.signal,
        price = store.close(s.symbol, i),
        btc = store.close('BTCUSDT', i);
      if (!Number.isFinite(price) || !Number.isFinite(btc)) {
        remaining.push(p);
        continue;
      }
      p.observedGapMs += Math.max(0, now - p.lastObservedTs - MINUTE);
      p.lastObservedTs = now;
      const direction = s.side === 'LONG' ? 1 : -1,
        altLog = Math.log(price / p.entryPrice),
        btcLog = Math.log(btc / p.btcEntryPrice),
        move = direction * (altLog - (hedged ? s.beta * btcLog : 0));
      p.maeBps = Math.min(p.maeBps, move * 1e4);
      p.mfeBps = Math.max(p.mfeBps, move * 1e4);
      const reason: PaperTrade['exitReason'] | null =
        move <= -p.stop
          ? 'stop'
          : move >= p.target
            ? 'target'
            : now - p.entryTs >= c.holdMs
              ? 'time'
              : null;
      if (!reason) {
        remaining.push(p);
        continue;
      }
      const altSimple = Math.expm1(altLog),
        btcSimple = Math.expm1(btcLog),
        hedgedGross = direction * (altSimple - s.beta * btcSimple) * 1e4,
        gross =
          reason === 'target'
            ? Math.expm1(p.target) * 1e4
            : hedged
              ? hedgedGross
              : direction * altSimple * 1e4,
        exitPrice =
          reason === 'target' && !hedged
            ? p.entryPrice * Math.exp(direction * p.target)
            : price,
        legs = hedged ? 1 + Math.abs(s.beta) : 1,
        feeBps = 2 * c.feeBpsPerSide * legs,
        slippageBps = roundTripCostBps(c, s.beta) - feeBps,
        // Longs pay positive funding and shorts receive it; the hedge leg is the opposite side, sized by beta.
        fundingBps =
          c.market === 'usdm'
            ? 1e4 *
              (-direction * this.fundingRate(s.symbol, p.entryTs, now) +
                (hedged
                  ? direction *
                    s.beta *
                    this.fundingRate('BTCUSDT', p.entryTs, now)
                  : 0))
            : 0;
      closed.push({
        signalId: s.id,
        btcImpulseId: s.eventId,
        symbol: s.symbol,
        entryTs: p.entryTs,
        entryPrice: p.entryPrice,
        exitTs: now,
        exitPrice,
        grossReturnBps: gross,
        feeBps,
        slippageBps,
        netReturnBps: gross - feeBps - slippageBps + fundingBps,
        fundingBps,
        maeBps: p.maeBps,
        mfeBps: p.mfeBps,
        observedGapMs: p.observedGapMs,
        costModel: `assumed-spread-${c.spreadBps}bps-${c.instrument}`,
        exitReason: reason,
        side: s.side,
        instrument: c.instrument,
        executable: s.executable,
        decisionTs: s.decisionTs,
        beta: s.beta,
        btcEntryPrice: p.btcEntryPrice,
        btcExitPrice: btc,
        btcReturnBps: btcSimple * 1e4,
        hedgedGrossBps: hedgedGross,
        residualZ: s.residualZ,
        lagBps: s.lagBps,
        expectedNetBps: s.expectedNetBps,
        targetBps: p.target * 1e4,
        stopBps: p.stop * 1e4,
        entryDriftBps: p.entryDriftBps,
      });
      this.cooldownUntil.set(key(s.side, s.symbol), now + c.cooldownMs);
    }
    this.open = remaining;
    this.trades.push(...closed);
    return closed;
  }
}

/** Runs decisions inside [startTs, endTs); bars before startTs serve only as fit history. */
export function runResidual(
  store: BarStore,
  config: ResidualConfig,
  range: { startTs: number; endTs: number },
  funding?: Map<string, FundingEvent[]>,
) {
  const engine = new ResidualEngine(config),
    sim = new ResidualSimulator(engine, range, funding),
    first = Math.max(
      0,
      store.indexClosingAt(Math.max(range.startTs, store.closeTimeAt(0))),
    ),
    last = Math.min(store.length - 1, store.indexClosingAt(range.endTs));
  let signals = 0;
  for (let i = first; i <= last; i++)
    signals += sim.step(store, i).signals.length;
  return {
    trades: sim.trades,
    signals,
    unfinished: sim.unfinished,
    rejections: sim.rejections,
    diagnostics: engine.diagnostics.funnel,
    configHash: engine.configHash,
  };
}

export function residualReport(
  trades: ResidualTrade[],
  unfinished = { pending: 0, openPositions: 0 },
) {
  const executable = trades.filter((t) => t.executable),
    research = trades.filter((t) => !t.executable),
    exits = (list: ResidualTrade[]) =>
      list.reduce<Record<string, number>>(
        (n, t) => ((n[t.exitReason] = (n[t.exitReason] ?? 0) + 1), n),
        {},
      );
  const hedgedView = (list: ResidualTrade[]) =>
    list.map((t) => ({
      ...t,
      netReturnBps:
        t.hedgedGrossBps -
        (t.feeBps + t.slippageBps) *
          (t.instrument === 'hedged' ? 1 : 1 + Math.abs(t.beta)) +
        (t.instrument === 'hedged' ? (t.fundingBps ?? 0) : 0),
    }));
  return {
    executable: { ...metrics(executable), exitReasons: exits(executable) },
    researchOnly: { ...metrics(research), exitReasons: exits(research) },
    bySide: Object.fromEntries(
      (['LONG', 'SHORT'] as const).map((side) => [
        side,
        metrics(trades.filter((t) => t.side === side)),
      ]),
    ),
    risk: riskReport(executable),
    costStress: costStress(executable),
    hedgedEquivalent: metrics(hedgedView(executable)),
    unfinished,
    limitations: [
      'Kline closes only: no bid/ask, depth or queue data; spread is an assumed constant',
      'Stops fill at the observed one-minute close; targets fill exactly at target',
      'Spot configs price both hedge legs on spot and ignore funding and borrow; usdm configs use perp closes and settled funding',
      'Equal-notional trade units, not a capital-weighted portfolio',
    ],
  };
}
