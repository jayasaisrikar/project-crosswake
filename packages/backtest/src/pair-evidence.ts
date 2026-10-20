import { metrics, type PaperTrade } from './index.js';
import { riskReport } from './reports.js';

/** ResearchPlan['acceptance'] shape; typed structurally so this module does not import the plan schema. */
export type AcceptanceCriteria = {
  policy?: 'legacy-win-rate' | 'net-expectancy';
  minClosedTrades: number;
  minWinRate: number;
  minProfitFactor: number;
  minEvents: number;
  minAssets: number;
  maxDrawdownBps?: number;
  maxAssetPnlShare?: number;
};

export interface PairGateCriteria extends AcceptanceCriteria {
  /** Minimum distinct symbols a passing trade set must span (pairs evidence, not one lucky horse). */
  minProfitPairs?: number;
  /** Maximum share of total absolute PnL one BTC event may carry; clustered trades are one observation. */
  maxEventPnlShare?: number;
}

/** Per-symbol pair evidence: a pair is tradable only if its own net is positive. */
export function pairReport(trades: PaperTrade[]) {
  const bySymbol = new Map<
    string,
    { trades: number; netBps: number; wins: number }
  >();
  for (const t of trades) {
    const row = bySymbol.get(t.symbol) ?? { trades: 0, netBps: 0, wins: 0 };
    row.trades++;
    row.netBps += t.netReturnBps;
    if (t.netReturnBps > 0) row.wins++;
    bySymbol.set(t.symbol, row);
  }
  const pairs = [...bySymbol.entries()]
    .map(([symbol, s]) => ({
      symbol,
      trades: s.trades,
      netBps: s.netBps,
      winRate: s.trades ? s.wins / s.trades : null,
    }))
    .sort((a, b) => b.netBps - a.netBps);
  return {
    pairs,
    profitablePairs: pairs.filter((p) => p.netBps > 0).length,
  };
}

/**
 * Clusters trades into the events that produced them and reports per-event
 * concentration: for pairs strategies the event, not the trade, is the unit
 * of risk - several symbols firing on one BTC impulse share its outcome.
 */
export function eventConcentration(trades: PaperTrade[]) {
  const byEvent = new Map<string, { events: number; netBps: number }>();
  for (const t of trades) {
    const row = byEvent.get(t.btcImpulseId) ?? { events: 0, netBps: 0 };
    row.events++;
    row.netBps += t.netReturnBps;
    byEvent.set(t.btcImpulseId, row);
  }
  const nets = [...byEvent.values()].map((e) => e.netBps);
  const absoluteEventTotal = nets.reduce((n, x) => n + Math.abs(x), 0);
  return {
    eventCount: byEvent.size,
    positiveEvents: nets.filter((n) => n > 0).length,
    largestEventAbsolutePnlShare: absoluteEventTotal
      ? Math.max(...nets.map((n) => Math.abs(n))) / absoluteEventTotal
      : null,
  };
}

/**
 * The pairs evidence gate. Same statistical floor as evidenceGate, but the
 * independence checks are pair-aware: breadth is measured in symbols with
 * their own positive net (not just assets touched) and concentration in BTC
 * events (not just trades), because pairs trades cluster on impulses.
 */
export function pairEvidenceGate(
  trades: PaperTrade[],
  criteria: PairGateCriteria,
  unfinished = 0,
) {
  const m = metrics(trades);
  const reasons: string[] = [];
  if (m.closedTrades < Math.max(500, criteria.minClosedTrades))
    reasons.push('insufficient_closed_trades');
  const legacy = criteria.policy !== 'net-expectancy';
  if (
    legacy
      ? (m.winRate ?? 0) <= Math.max(0.55, criteria.minWinRate)
      : (m.winRate ?? 0) < criteria.minWinRate
  )
    reasons.push('win_rate_below_target');
  if (legacy && (m.wilson95?.[0] ?? 0) <= 0.55)
    reasons.push('win_rate_confidence_inconclusive');
  if ((m.profitFactor ?? 0) < Math.max(1.3, criteria.minProfitFactor))
    reasons.push('profit_factor_below_target');
  if (
    (m.netExpectancyBps ?? -Infinity) <= 0 ||
    (m.eventClusterBootstrap?.netExpectancyBps95[0] ?? -Infinity) <= 0
  )
    reasons.push('expectancy_inconclusive');
  const events = eventConcentration(trades);
  if (events.eventCount < criteria.minEvents)
    reasons.push('insufficient_btc_events');
  if (
    new Set(trades.map((t) => t.symbol)).size < Math.max(2, criteria.minAssets)
  )
    reasons.push('asset_concentration');
  const pairs = pairReport(trades);
  if (pairs.profitablePairs < (criteria.minProfitPairs ?? 0))
    reasons.push('insufficient_profitable_pairs');
  if (
    criteria.maxEventPnlShare !== undefined &&
    (events.largestEventAbsolutePnlShare ?? 1) > criteria.maxEventPnlShare
  )
    reasons.push('event_concentration');
  if (unfinished) reasons.push('unfinished_positions');
  if (trades.some((t) => (t.observedGapMs ?? 0) > 0))
    reasons.push('unobserved_position_path');
  if (!legacy) {
    const risk = riskReport(trades);
    if (
      criteria.maxDrawdownBps === undefined ||
      risk.equalNotionalMaxDrawdownBps > criteria.maxDrawdownBps
    )
      reasons.push('drawdown_limit');
    if (
      criteria.maxAssetPnlShare === undefined ||
      (risk.largestAssetAbsolutePnlShare ?? 1) > criteria.maxAssetPnlShare
    )
      reasons.push('pnl_concentration_limit');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    metrics: m,
    pairs,
    events,
  };
}
