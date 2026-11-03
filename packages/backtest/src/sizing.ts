export type SizingRules = {
  volLookbackDays: number;
  targetVolAnnual: number;
  maxWeightPerCoin: number;
  grossCap: number;
};

export type SizedPosition = { symbol: string; weight: number };

const DAYS_PER_YEAR = 365;

/** Daily close-to-close returns from the closes that exist, ignoring gaps rather than filling them. */
export function dailyReturns(closes: number[]) {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const previous = closes[i - 1]!,
      current = closes[i]!;
    if (previous > 0 && current > 0) out.push(current / previous - 1);
  }
  return out;
}

export function annualVol(closes: number[], lookbackDays: number) {
  const recent = closes.slice(-(lookbackDays + 1)),
    returns = dailyReturns(recent);
  if (returns.length < 20) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(DAYS_PER_YEAR);
  return vol > 0 ? vol : null;
}

/**
 * Inverse-volatility weights for an open book, scaled to a portfolio volatility target and capped
 * per coin. The portfolio volatility is the weighted sum of the individual volatilities: that
 * ignores the diversification benefit, so it sizes conservatively rather than optimistically.
 * A coin without enough history is left out instead of being guessed at.
 */
export function inverseVolWeights(
  books: Map<string, number[]>,
  rules: SizingRules,
): { positions: SizedPosition[]; bookVol: number | null } {
  const vols = new Map<string, number>();
  for (const [symbol, closes] of books) {
    const vol = annualVol(closes, rules.volLookbackDays);
    if (vol) vols.set(symbol, vol);
  }
  if (!vols.size) return { positions: [], bookVol: null };

  const inverse = [...vols].map(([symbol, vol]) => ({
    symbol,
    raw: 1 / vol,
  }));
  const rawSum = inverse.reduce((a, b) => a + b.raw, 0);
  if (!rawSum) return { positions: [], bookVol: null };

  let weights = inverse.map(({ symbol, raw }) => ({
    symbol,
    weight: raw / rawSum,
  }));
  const bookVolAtFullWeight = weights.reduce(
    (sum, { symbol, weight }) => sum + weight * vols.get(symbol)!,
    0,
  );
  const scale =
    bookVolAtFullWeight > 0 ? rules.targetVolAnnual / bookVolAtFullWeight : 0;
  weights = weights.map(({ symbol, weight }) => ({
    symbol,
    weight: Math.min(weight * scale, rules.maxWeightPerCoin),
  }));

  const gross = weights.reduce((a, b) => a + b.weight, 0);
  const cap = Math.min(rules.grossCap, 1);
  if (gross > cap)
    weights = weights.map(({ symbol, weight }) => ({
      symbol,
      weight: (weight / gross) * cap,
    }));

  return {
    positions: weights
      .filter((position) => position.weight > 0)
      .sort((a, b) => b.weight - a.weight),
    bookVol: bookVolAtFullWeight,
  };
}
