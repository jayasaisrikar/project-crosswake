import { referencePrice, type Snapshot } from '../../domain/src/index.js';
import type { Candidate, StrategyConfig } from '../../signals/src/index.js';
export interface PaperTrade {
  signalId: string;
  btcImpulseId: string;
  symbol: string;
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  grossReturnBps: number;
  feeBps: number;
  slippageBps: number;
  netReturnBps: number;
  maeBps: number;
  mfeBps: number;
  observedGapMs?: number;
  /** Funding received (+) or paid (-) while held; already included in netReturnBps. */
  fundingBps?: number;
  costModel?: string;
  exitReason: 'target' | 'stop' | 'time';
}
interface Position {
  signal: Candidate;
  entryTs: number;
  entryPrice: number;
  mae: number;
  mfe: number;
  entrySlippageBps: number;
  lastObservedTs: number;
  observedGapMs: number;
}
export class PaperBacktester {
  private pending: Candidate[] = [];
  private liquidity = new Map<
    string,
    {
      ts: number;
      price: number | null;
      volume: number;
      returns: number[];
      volumes: number[];
    }
  >();
  private fillCost(symbol: string, ts: number) {
    const model = this.config.executionCost;
    if (!model) return this.config.slippageBpsPerSide;
    const h = this.liquidity.get(symbol);
    if (
      !h ||
      h.returns.length < 30 ||
      (this.config.forward !== undefined && h.ts !== ts - 1000)
    )
      return null;
    const volume = h.volumes.reduce((a, b) => a + b, 0);
    const participation = model.notionalUsdt / Math.max(volume, 1e-12);
    if (participation > model.maxParticipation) return null;
    const avg = h.returns.reduce((a, b) => a + b, 0) / h.returns.length;
    const vol =
      Math.sqrt(
        h.returns.reduce((a, b) => a + (b - avg) ** 2, 0) / h.returns.length,
      ) * 10000;
    return (
      this.config.slippageBpsPerSide +
      model.impactCoefficientBps * Math.sqrt(participation) +
      model.volatilityMultiplier * vol
    );
  }
  checkpoint() {
    return {
      pending: this.pending,
      positions: [...this.positions],
      usedEvents: [...this.usedEvents],
    };
  }

  private positions = new Map<string, Position>();
  private usedEvents = new Set<string>();
  readonly trades: PaperTrade[] = [];
  readonly entries: {
    signalId: string;
    btcImpulseId: string;
    symbol: string;
    entryTs: number;
    entryPrice: number;
    quoteTs: number;
  }[] = [];
  readonly rejections: { signalId: string; reason: string }[] = [];
  constructor(
    private config: StrategyConfig,
    private fixedHorizonBaseline = false,
  ) {}
  submit(candidates: Candidate[]) {
    this.pending.push(
      ...candidates
        .filter((c) => c.executable && c.accepted && c.side === 'LONG')
        .sort(
          (a, b) =>
            (this.config.forward
              ? (b.predictedNetBps ?? -Infinity) -
                (a.predictedNetBps ?? -Infinity)
              : b.confidence - a.confidence) ||
            a.symbol.localeCompare(b.symbol),
        ),
    );
  }
  update(rows: Snapshot[]) {
    if (!rows.length) return;
    const ts = rows[0]!.ts,
      map = new Map(rows.map((r) => [r.symbol, r]));
    for (const [symbol, p] of this.positions) {
      const row = map.get(symbol);
      if (
        !row?.isComplete ||
        row.bestBid === null ||
        row.quoteTs == null ||
        row.quoteTs <= p.entryTs ||
        (this.config.forward !== undefined &&
          (row.quoteTs > ts || ts - row.quoteTs > 1000))
      )
        continue;
      const exitSlippage = this.fillCost(symbol, ts);
      if (exitSlippage === null) continue;
      p.observedGapMs += Math.max(0, ts - p.lastObservedTs - 1000);
      p.lastObservedTs = ts;
      const gross = (row.bestBid / p.entryPrice - 1) * 10000;
      p.mae = Math.min(p.mae, gross);
      p.mfe = Math.max(p.mfe, gross);
      let reason: PaperTrade['exitReason'] | undefined;
      if (!this.fixedHorizonBaseline && gross <= -this.config.stopLossBps)
        reason = 'stop';
      else if (
        !this.fixedHorizonBaseline &&
        row.bestBid >=
          (p.signal.targetPrice ??
            p.signal.decisionPrice *
              Math.exp(
                p.signal.reactionGap * this.config.takeProfitGapFraction,
              ))
      )
        reason = 'target';
      else if (ts - p.entryTs >= this.config.maxHoldMs) reason = 'time';
      if (reason) {
        const fee = 2 * this.config.feeBpsPerSide,
          slippage = p.entrySlippageBps + exitSlippage;
        this.trades.push({
          signalId: p.signal.id,
          btcImpulseId: p.signal.btcImpulseId,
          symbol,
          entryTs: p.entryTs,
          entryPrice: p.entryPrice,
          exitTs: ts,
          exitPrice: row.bestBid,
          grossReturnBps: gross,
          feeBps: fee,
          slippageBps: slippage,
          netReturnBps: gross - fee - slippage,
          maeBps: p.mae,
          mfeBps: p.mfe,
          exitReason: reason,
          observedGapMs: p.observedGapMs,
          costModel: this.config.executionCost
            ? 'SIZE_VOLATILITY_PROXY'
            : 'FIXED_SLIPPAGE',
        });
        this.positions.delete(symbol);
      }
    }
    const remaining: Candidate[] = [];
    for (const signal of this.pending) {
      const eligibleAt = signal.entryEligibleTs ?? signal.decisionTs;
      if (signal.expiresAt !== undefined && ts >= signal.expiresAt) {
        this.rejections.push({ signalId: signal.id, reason: 'signal_expired' });
        continue;
      }
      if (ts <= eligibleAt) {
        remaining.push(signal);
        continue;
      }
      if (ts - eligibleAt > this.config.maxEntryWaitMs) {
        this.rejections.push({
          signalId: signal.id,
          reason: 'entry_quote_timeout',
        });
        continue;
      }
      if (
        this.usedEvents.has(signal.btcImpulseId) ||
        this.positions.has(signal.symbol) ||
        (this.config.forward !== undefined &&
          this.positions.size >= this.config.forward.maxConcurrentPositions)
      ) {
        this.rejections.push({ signalId: signal.id, reason: 'exposure_limit' });
        continue;
      }
      const btc = map.get('BTCUSDT');
      if (!btc?.isComplete || referencePrice(btc) === null) {
        remaining.push(signal);
        continue;
      }
      if (
        !this.fixedHorizonBaseline &&
        Math.log(referencePrice(btc)! / signal.btcDecisionPrice) <
          -Math.abs(signal.btcImpulseReturn) *
            this.config.btcRetraceInvalidation
      ) {
        this.rejections.push({
          signalId: signal.id,
          reason: 'btc_impulse_retraced',
        });
        continue;
      }
      const row = map.get(signal.symbol);
      if (
        !row?.isComplete ||
        row.bestAsk === null ||
        row.bestBid === null ||
        row.quoteTs == null ||
        row.quoteTs <= eligibleAt ||
        (this.config.forward !== undefined &&
          (row.quoteTs > ts || ts - row.quoteTs > 1000)) ||
        row.spreadBps === null ||
        row.spreadBps > this.config.maxSpreadBps
      ) {
        remaining.push(signal);
        continue;
      }
      if (
        !this.fixedHorizonBaseline &&
        row.bestAsk >=
          (signal.targetPrice ??
            signal.decisionPrice *
              Math.exp(signal.reactionGap * this.config.takeProfitGapFraction))
      ) {
        this.rejections.push({
          signalId: signal.id,
          reason: 'target_reached_before_entry',
        });
        continue;
      }
      if (
        !this.fixedHorizonBaseline &&
        signal.entryPriceLimit !== undefined &&
        row.bestAsk > signal.entryPriceLimit
      ) {
        this.rejections.push({
          signalId: signal.id,
          reason: 'entry_price_limit',
        });
        continue;
      }
      const entrySlippage = this.fillCost(signal.symbol, ts);
      if (entrySlippage === null) {
        this.rejections.push({
          signalId: signal.id,
          reason: 'capacity_or_volatility_evidence_unavailable',
        });
        continue;
      }
      const remainingEdge =
        (signal.reactionGap - Math.log(row.bestAsk / signal.decisionPrice)) *
        10000;
      const entryCost =
        row.spreadBps + 2 * (this.config.feeBpsPerSide + entrySlippage);
      if (this.config.forward && !this.fixedHorizonBaseline) {
        const target = signal.targetPrice;
        if (
          target === undefined ||
          signal.expiresAt === undefined ||
          signal.entryEligibleTs === undefined ||
          signal.entryPriceLimit === undefined
        ) {
          this.rejections.push({
            signalId: signal.id,
            reason: 'missing_forward_execution_contract',
          });
          continue;
        }
        const grossReward = (target / row.bestAsk - 1) * 10000;
        // Ask-to-target-bid reward already embeds spread. Fees and slippage are charged once.
        const costs = 2 * (this.config.feeBpsPerSide + entrySlippage);
        const netReward = grossReward - costs,
          netLoss = this.config.stopLossBps + costs;
        if (
          grossReward < costs * this.config.costSafetyMultiple ||
          netReward / netLoss < this.config.forward.minNetRewardRisk
        ) {
          this.rejections.push({
            signalId: signal.id,
            reason: 'entry_net_reward_risk_too_low',
          });
          continue;
        }
      }
      if (
        !this.fixedHorizonBaseline &&
        !this.config.forward &&
        remainingEdge < entryCost * this.config.costSafetyMultiple
      ) {
        this.rejections.push({
          signalId: signal.id,
          reason: 'gap_closed_before_entry',
        });
        continue;
      }
      this.positions.set(signal.symbol, {
        signal,
        entryTs: ts,
        entryPrice: row.bestAsk,
        mae: 0,
        mfe: 0,
        entrySlippageBps: entrySlippage,
        lastObservedTs: ts,
        observedGapMs: 0,
      });
      this.entries.push({
        signalId: signal.id,
        btcImpulseId: signal.btcImpulseId,
        symbol: signal.symbol,
        entryTs: ts,
        entryPrice: row.bestAsk,
        quoteTs: row.quoteTs,
      });
      this.usedEvents.add(signal.btcImpulseId);
    }
    this.pending = remaining;
    // Fill-cost estimates use only prior observed seconds, excluding the fill snapshot.
    for (const row of rows) {
      const prior = this.liquidity.get(row.symbol),
        price = referencePrice(row);
      const continuous =
        prior &&
        row.ts === prior.ts + 1000 &&
        row.isComplete &&
        price !== null &&
        prior.price !== null;
      const returns = continuous
        ? [...prior.returns, Math.log(price! / prior.price!)].slice(-60)
        : [];
      const volumes = continuous
        ? [...prior.volumes, row.quoteVolume].slice(-60)
        : [row.quoteVolume];
      this.liquidity.set(row.symbol, {
        ts: row.ts,
        price: row.isComplete ? price : null,
        volume: row.quoteVolume,
        returns,
        volumes,
      });
    }
  }
  get openState() {
    return {
      pending: this.pending.map((signal) => ({
        signalId: signal.id,
        symbol: signal.symbol,
        decisionTs: signal.decisionTs,
      })),
      positions: [...this.positions.values()].map((p) => ({
        signal: p.signal,
        entryTs: p.entryTs,
        entryPrice: p.entryPrice,
        maeBps: p.mae,
        mfeBps: p.mfe,
      })),
    };
  }
  get unfinished() {
    return { pending: this.pending.length, openPositions: this.positions.size };
  }
}
export function wilson(wins: number, n: number) {
  if (n === 0) return null;
  const z = 1.959963984540054,
    p = wins / n,
    denom = 1 + (z * z) / n,
    center = (p + (z * z) / (2 * n)) / denom,
    half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function metrics(trades: PaperTrade[]) {
  const returns = trades.map((t) => t.netReturnBps),
    wins = returns.filter((x) => x > 0),
    losses = returns.filter((x) => x < 0),
    sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  return {
    closedTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    flat: returns.filter((x) => x === 0).length,
    winRate: trades.length ? wins.length / trades.length : null,
    wilson95: wilson(wins.length, trades.length),
    netExpectancyBps: trades.length ? sum(returns) / trades.length : null,
    averageNetWinBps: wins.length ? sum(wins) / wins.length : null,
    averageNetLossBps: losses.length ? -sum(losses) / losses.length : null,
    netPayoffRatio:
      wins.length && losses.length
        ? sum(wins) / wins.length / (-sum(losses) / losses.length)
        : null,
    breakevenWinRate:
      wins.length && losses.length
        ? -sum(losses) /
          losses.length /
          (sum(wins) / wins.length + -sum(losses) / losses.length)
        : null,
    profitFactor: losses.length ? sum(wins) / -sum(losses) : null,
    btcEventCount: new Set(trades.map((t) => t.btcImpulseId)).size,
    eventClusterBootstrap: clusterBootstrap(trades),
    validationStatus: 'EXPLORATORY_NOT_OUT_OF_SAMPLE',
  };
}

/** Resample BTC events, preserving all trades belonging to each event. */
export function clusterBootstrap(
  trades: PaperTrade[],
  resamples = 500,
  seed = 17,
) {
  if (
    !Number.isInteger(resamples) ||
    resamples < 100 ||
    seed <= 0 ||
    seed >= 2147483647
  )
    throw new Error('Invalid bootstrap settings');
  const grouped = new Map<string, number[]>();
  for (const trade of trades) {
    const values = grouped.get(trade.btcImpulseId) ?? [];
    values.push(trade.netReturnBps);
    grouped.set(trade.btcImpulseId, values);
  }
  const groups = [...grouped.values()];
  if (groups.length < 2) return null;
  const means: number[] = [],
    rates: number[] = [];
  for (let sample = 0; sample < resamples; sample++) {
    let n = 0,
      wins = 0,
      total = 0;
    for (let event = 0; event < groups.length; event++) {
      seed = (seed * 16807) % 2147483647;
      for (const value of groups[
        Math.floor((seed / 2147483647) * groups.length)
      ]!) {
        n++;
        total += value;
        wins += Number(value > 0);
      }
    }
    means.push(total / n);
    rates.push(wins / n);
  }
  means.sort((a, b) => a - b);
  rates.sort((a, b) => a - b);
  const bounds = (values: number[]) => [
    values[Math.floor(0.025 * (resamples - 1))]!,
    values[Math.ceil(0.975 * (resamples - 1))]!,
  ];
  return {
    eventCount: groups.length,
    resamples,
    netExpectancyBps95: bounds(means),
    winRate95: bounds(rates),
  };
}
