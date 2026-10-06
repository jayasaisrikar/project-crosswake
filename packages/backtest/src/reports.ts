import type { PaperTrade } from './index.js';
export function riskReport(trades: PaperTrade[]) {
  const ordered = [...trades].sort(
    (a, b) => a.exitTs - b.exitTs || a.signalId.localeCompare(b.signalId),
  );
  let curve = 0,
    peak = 0,
    maxDrawdownBps = 0,
    streak = 0,
    maxLosingStreak = 0;
  const asset = new Map<string, { trades: number; netBps: number }>(),
    month = new Map<string, { trades: number; netBps: number }>();
  for (const t of ordered) {
    curve += t.netReturnBps;
    peak = Math.max(peak, curve);
    maxDrawdownBps = Math.max(maxDrawdownBps, peak - curve);
    streak = t.netReturnBps < 0 ? streak + 1 : 0;
    maxLosingStreak = Math.max(maxLosingStreak, streak);
    for (const [map, key] of [
      [asset, t.symbol],
      [month, new Date(t.exitTs).toISOString().slice(0, 7)],
    ] as const) {
      const row = map.get(key) ?? { trades: 0, netBps: 0 };
      row.trades++;
      row.netBps += t.netReturnBps;
      map.set(key, row);
    }
  }
  const absoluteTotal = trades.reduce(
    (n, t) => n + Math.abs(t.netReturnBps),
    0,
  );
  return {
    equalNotionalCumulativeBps: curve,
    equalNotionalMaxDrawdownBps: maxDrawdownBps,
    maxLosingStreak,
    byAsset: Object.fromEntries(asset),
    byMonth: Object.fromEntries(month),
    largestAssetAbsolutePnlShare: absoluteTotal
      ? Math.max(
          ...[...asset.keys()].map((symbol) =>
            trades
              .filter((t) => t.symbol === symbol)
              .reduce((n, t) => n + Math.abs(t.netReturnBps), 0),
          ),
        ) / absoluteTotal
      : null,
    limitations: [
      'Equal-notional trade units; this is not a capital-weighted portfolio equity curve',
      'Open positions are reported separately and are not marked to market here',
    ],
  };
}
