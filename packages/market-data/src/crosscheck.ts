/**
 * Compares daily closes from two venues. Binance spot and Hyperliquid perps
 * normally sit within a few basis points of each other (the perp's basis);
 * a larger gap points at bad data, a delisting, or a wrong symbol mapping.
 */
export interface DailyClose {
  ts: number;
  close: number;
}
export interface CloseGap {
  symbol: string;
  ts: number;
  binance: number;
  hyperliquid: number;
  /** (hyperliquid / binance - 1) in basis points. */
  gapBps: number;
}
export interface SymbolCheck {
  symbol: string;
  status: 'ok' | 'flagged' | 'missing';
  days: number;
  maxAbsGapBps: number;
  medianGapBps: number;
  worst?: CloseGap;
  /** Days Binance has but Hyperliquid doesn't (or the reverse). */
  unmatchedDays: number;
}

export function compareCloses(
  symbol: string,
  binance: DailyClose[],
  hyperliquid: DailyClose[] | undefined,
  thresholdBps: number,
): SymbolCheck {
  if (!hyperliquid?.length)
    return {
      symbol,
      status: 'missing',
      days: 0,
      maxAbsGapBps: 0,
      medianGapBps: 0,
      unmatchedDays: binance.length,
    };
  const hl = new Map(hyperliquid.map((b) => [b.ts, b.close]));
  const gaps: CloseGap[] = [];
  for (const b of binance) {
    const h = hl.get(b.ts);
    if (h === undefined || !(b.close > 0) || !(h > 0)) continue;
    gaps.push({
      symbol,
      ts: b.ts,
      binance: b.close,
      hyperliquid: h,
      gapBps: (h / b.close - 1) * 1e4,
    });
  }
  const unmatchedDays = binance.length + hyperliquid.length - 2 * gaps.length;
  if (!gaps.length)
    return {
      symbol,
      status: 'missing',
      days: 0,
      maxAbsGapBps: 0,
      medianGapBps: 0,
      unmatchedDays,
    };
  const worst = gaps.reduce((a, g) =>
    Math.abs(g.gapBps) > Math.abs(a.gapBps) ? g : a,
  );
  const sorted = gaps.map((g) => g.gapBps).sort((a, b) => a - b),
    mid = sorted.length >> 1,
    median =
      sorted.length % 2 ? sorted.at(mid)! : (sorted.at(mid - 1)! + sorted.at(mid)!) / 2;
  return {
    symbol,
    status: Math.abs(worst.gapBps) > thresholdBps ? 'flagged' : 'ok',
    days: gaps.length,
    maxAbsGapBps: Math.abs(worst.gapBps),
    medianGapBps: median,
    worst,
    unmatchedDays,
  };
}
