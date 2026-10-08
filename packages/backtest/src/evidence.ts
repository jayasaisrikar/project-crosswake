import { riskReport } from './reports.js';
import { metrics, type PaperTrade } from './index.js';
import type { ResearchPlan } from './research-plan.js';
export function evidenceGate(
  trades: PaperTrade[],
  criteria: ResearchPlan['acceptance'],
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
  if (m.btcEventCount < criteria.minEvents)
    reasons.push('insufficient_btc_events');
  if (
    new Set(trades.map((t) => t.symbol)).size < Math.max(2, criteria.minAssets)
  )
    reasons.push('asset_concentration');
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
  return { passed: reasons.length === 0, reasons, metrics: m };
}
