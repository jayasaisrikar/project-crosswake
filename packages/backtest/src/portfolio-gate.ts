export type StrategyTrade = {
  symbol: string;
  entryTs: number;
  exitTs: number;
  netBps: number;
};

export type RegimeSegment = { label: string; from: number; to: number };

export type PortfolioCriteria = {
  minClosedTrades: number;
  minNetExpectancyBps: number;
  minCiLowerBps: number;
  minProfitSymbols: number;
  maxSymbolPnlShare: number;
  maxDrawdownBps: number;
  minPositiveSegments: number;
  minPositiveSegmentShare: number;
  /** Capital is split into this many slots, one per coin, so a drawdown is measured against it. */
  capitalSlots?: number;
};

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

const qualified = (trade: StrategyTrade) =>
  Number.isFinite(trade.netBps) && trade.exitTs > trade.entryTs;

/** Resamples whole symbols, so one coin cannot manufacture its own confidence. */
export function symbolClusteredCi(
  trades: StrategyTrade[],
  resamples = 10_000,
  seed = 5,
): [number, number] | null {
  if (
    !Number.isInteger(resamples) ||
    resamples < 100 ||
    seed <= 0 ||
    seed >= 2147483647
  )
    throw new Error('Invalid bootstrap settings');
  const grouped = new Map<string, number[]>();
  for (const trade of trades.filter(qualified)) {
    const values = grouped.get(trade.symbol) ?? [];
    values.push(trade.netBps);
    grouped.set(trade.symbol, values);
  }
  const groups = [...grouped.values()];
  if (groups.length < 3) return null;
  const means: number[] = [];
  for (let sample = 0; sample < resamples; sample++) {
    let n = 0,
      total = 0;
    for (let draw = 0; draw < groups.length; draw++) {
      seed = (seed * 16807) % 2147483647;
      for (const value of groups[
        Math.floor((seed / 2147483647) * groups.length)
      ]!) {
        n += 1;
        total += value;
      }
    }
    means.push(total / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) =>
    means[Math.min(means.length - 1, Math.floor(q * means.length))]!;
  return [at(0.025), at(0.975)];
}

/**
 * Equal-notional equity: each trade takes one slot, so one huge winner cannot hide the rest.
 * The running sum is in slot-returns, so it is divided by the slot count to read as capital.
 */
export function maxDrawdownBps(trades: StrategyTrade[], capitalSlots?: number) {
  const ordered = trades.filter(qualified).sort((a, b) => a.exitTs - b.exitTs);
  let equity = 0,
    peak = 0,
    worst = 0;
  for (const trade of ordered) {
    equity += trade.netBps;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity - peak);
  }
  const slots =
    capitalSlots ?? Math.max(1, new Set(trades.map((t) => t.symbol)).size);
  return Math.abs(worst) / slots;
}

export function segmentStats(
  trades: StrategyTrade[],
  segments: RegimeSegment[],
) {
  const scored = trades.filter(qualified);
  return segments.map((segment) => {
    const inside = scored.filter(
      (trade) => trade.entryTs >= segment.from && trade.entryTs < segment.to,
    );
    return {
      label: segment.label,
      trades: inside.length,
      netExpectancyBps: inside.length
        ? mean(inside.map((t) => t.netBps))
        : null,
      totalBps: inside.reduce((a, t) => a + t.netBps, 0),
    };
  });
}

/**
 * The standard a version has to clear before it is called a strategy: enough trades to say
 * anything, a net expectancy whose confidence interval clears zero, profit spread over many
 * coins rather than one, no single coin driving the result, and the same behaviour in every
 * market regime it was asked to trade. A missing regime split fails the gate; the alternative
 * is reporting a result nobody checked.
 */
export function portfolioGate(
  trades: StrategyTrade[],
  criteria: PortfolioCriteria,
  segments: RegimeSegment[] = [],
) {
  const scored = trades.filter(qualified);
  const reasons: string[] = [];
  const values = scored.map((trade) => trade.netBps);
  const netExpectancyBps = mean(values);
  const ci = symbolClusteredCi(scored);
  const perSymbol = new Map<string, number>();
  for (const trade of scored)
    perSymbol.set(
      trade.symbol,
      (perSymbol.get(trade.symbol) ?? 0) + trade.netBps,
    );
  const profitSymbols = [...perSymbol.values()].filter((net) => net > 0).length;
  const gross = [...perSymbol.values()].reduce(
    (a, net) => a + Math.abs(net),
    0,
  );
  const topShare = gross
    ? Math.max(...[...perSymbol.values()].map(Math.abs)) / gross
    : 1;
  const drawdownBps = maxDrawdownBps(scored, criteria.capitalSlots);
  const regimes = segmentStats(scored, segments);
  const covered = regimes.filter((segment) => segment.trades > 0);

  if (scored.length < criteria.minClosedTrades)
    reasons.push('insufficient_closed_trades');
  if (netExpectancyBps < criteria.minNetExpectancyBps)
    reasons.push('expectancy_below_target');
  if (ci === null || ci[0] < criteria.minCiLowerBps)
    reasons.push('expectancy_confidence_inconclusive');
  if (profitSymbols < criteria.minProfitSymbols) reasons.push('symbol_breadth');
  if (topShare > criteria.maxSymbolPnlShare) reasons.push('pnl_concentration');
  if (drawdownBps > criteria.maxDrawdownBps) reasons.push('drawdown_limit');
  if (!covered.length) reasons.push('regime_split_unavailable');
  else {
    const positive = covered.filter(
      (segment) => (segment.netExpectancyBps ?? -Infinity) > 0,
    ).length;
    const share = positive / covered.length;
    if (
      positive < Math.min(criteria.minPositiveSegments, covered.length) ||
      share < criteria.minPositiveSegmentShare
    )
      reasons.push('regime_instability');
  }
  if (trades.length !== scored.length) reasons.push('unfinished_positions');

  return {
    passed: reasons.length === 0,
    reasons,
    stats: {
      closedTrades: scored.length,
      netExpectancyBps,
      netExpectancyCi95: ci,
      profitSymbols,
      symbols: perSymbol.size,
      topSymbolShare: gross ? topShare : null,
      maxDrawdownBps: drawdownBps,
      regimes,
    },
  };
}
