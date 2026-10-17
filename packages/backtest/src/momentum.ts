/** Two-sleeve momentum book on perps (v008). Pure and causal: weights use closes up to day t, held from the day t+1 open.
 * Trend: mean sign of 20/60/120-day returns per coin, inverse-vol, long/short.
 * Cross-sectional: weekly, rank by 30-day return skipping the last day, long top third / short bottom third, dollar neutral.
 * Each sleeve is scaled to a portfolio vol target using its trailing returns, then capped per coin and in gross. */
import type { DailyBar } from './trend.js';

export interface MomentumRules {
  trend: { lookbacksDays: number[] };
  xsmom: { formationDays: number; skipDays: number; rebalanceDays: number };
  volTargetAnnual: number;
  volLookbackDays: number;
  maxWeightPerAsset: number;
  maxGrossLeverage: number;
  allocation: { trend: number; xsmom: number };
  costBpsPerSide: number;
}
export type Weights = Float64Array<ArrayBuffer>;
export interface MomentumRun {
  days: number[];
  symbols: string[];
  /** Weights decided at day i's close (combined book; sleeves before allocation). */
  weights: { trend: Weights[]; xsmom: Weights[]; book: Weights[] };
  /** Net return earned from day i+1's open to day i+2's open by the weights decided at day i. Index aligned to `days`. */
  returns: {
    trend: number[];
    xsmom: number[];
    book: number[];
    equalWeight: number[];
  };
}
const DAY = 86_400_000,
  YEAR = 365;

/** Aligns bars on a shared day grid; missing days are NaN. */
export function align(bars: Map<string, DailyBar[]>) {
  const symbols = [...bars.keys()],
    days = [
      ...new Set([...bars.values()].flatMap((b) => b.map((x) => x.ts))),
    ].sort((a, b) => a - b),
    at = new Map(days.map((d, i) => [d, i])),
    close = days.map(() => new Float64Array(symbols.length).fill(NaN)),
    open = days.map(() => new Float64Array(symbols.length).fill(NaN));
  symbols.forEach((s, j) => {
    for (const b of bars.get(s)!) {
      const i = at.get(b.ts)!;
      close[i]![j] = b.close;
      open[i]![j] = b.open;
    }
  });
  return { symbols, days, close, open };
}

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Daily close-to-close returns; NaN where either close is missing or days are not consecutive. */
function dailyReturns(days: number[], close: Float64Array[]) {
  return close.map((row, i) =>
    row.map((c, j) =>
      i > 0 && days[i]! - days[i - 1]! === DAY
        ? c / close[i - 1]![j]! - 1
        : NaN,
    ),
  );
}

function trailingVol(rets: Float64Array[], i: number, j: number, n: number) {
  let s = 0,
    s2 = 0,
    k = 0;
  for (let t = Math.max(1, i - n + 1); t <= i; t++) {
    const r = rets[t]![j]!;
    if (Number.isFinite(r)) ((s += r), (s2 += r * r), k++);
  }
  if (k < Math.ceil(n / 2)) return NaN;
  const m = s / k;
  return (
    Math.sqrt(Math.max(0, s2 / k - m * m) * (k / (k - 1))) * Math.sqrt(YEAR)
  );
}

/** Scales raw weights to the vol target using the last n days of returns of held coins, then caps. */
export function volTargetAndCap(
  raw: Weights,
  rets: Float64Array[],
  i: number,
  rules: MomentumRules,
): Weights {
  const held = [...raw.keys()].filter((j) => raw[j] !== 0);
  if (!held.length) return raw;
  const hist: number[] = [];
  for (let t = Math.max(1, i - rules.volLookbackDays + 1); t <= i; t++) {
    let p = 0,
      ok = true;
    for (const j of held) {
      const r = rets[t]![j]!;
      if (!Number.isFinite(r)) ok = false;
      else p += r * raw[j]!;
    }
    if (ok) hist.push(p);
  }
  const m = hist.reduce((a, b) => a + b, 0) / (hist.length || 1),
    sd =
      hist.length > 1
        ? Math.sqrt(
            hist.reduce((a, b) => a + (b - m) ** 2, 0) / (hist.length - 1),
          )
        : 0,
    pvol = sd * Math.sqrt(YEAR),
    w = raw.map((x) =>
      pvol > 0
        ? Math.max(
            -rules.maxWeightPerAsset,
            Math.min(
              rules.maxWeightPerAsset,
              (x * rules.volTargetAnnual) / pvol,
            ),
          )
        : 0,
    ),
    gross = w.reduce((a, b) => a + Math.abs(b), 0);
  return gross > rules.maxGrossLeverage
    ? w.map((x) => (x * rules.maxGrossLeverage) / gross)
    : w;
}

export function trendRaw(
  close: Float64Array[],
  rets: Float64Array[],
  i: number,
  rules: MomentumRules,
): Weights {
  const L = rules.trend.lookbacksDays,
    maxL = Math.max(...L);
  return close[i]!.map((c, j) => {
    if (
      i < maxL ||
      !Number.isFinite(c) ||
      !Number.isFinite(close[i - maxL]![j]!)
    )
      return 0;
    const vol = trailingVol(rets, i, j, rules.volLookbackDays);
    if (!(vol > 0)) return 0;
    const score =
      L.reduce((a, l) => a + sign(c / close[i - l]![j]! - 1), 0) / L.length;
    return score / vol;
  });
}

export function xsmomRaw(
  close: Float64Array[],
  rets: Float64Array[],
  i: number,
  rules: MomentumRules,
): Weights {
  const { formationDays: f, skipDays: k } = rules.xsmom,
    raw = new Float64Array(close[i]!.length);
  if (i < f + k) return raw;
  const ranked = [...raw.keys()]
      .map((j) => ({ j, m: close[i - k]![j]! / close[i - k - f]![j]! - 1 }))
      .filter(
        ({ j, m }) =>
          Number.isFinite(m) &&
          Number.isFinite(close[i]![j]!) &&
          trailingVol(rets, i, j, rules.volLookbackDays) > 0,
      )
      .sort((a, b) => a.m - b.m || a.j - b.j),
    n = Math.floor(ranked.length / 3);
  if (!n) return raw;
  for (const { j } of ranked.slice(0, n)) raw[j] = -1 / n;
  for (const { j } of ranked.slice(-n)) raw[j] = 1 / n;
  return raw;
}

/** Weekly rebalance aligned to the epoch (like the engine: days since 1970 divisible by rebalanceDays). */
const isRebalanceDay = (ts: number, every: number) =>
  Math.round(ts / DAY) % every === 0;

export function runMomentum(
  bars: Map<string, DailyBar[]>,
  rules: MomentumRules,
): MomentumRun {
  const { symbols, days, close, open } = align(bars),
    rets = dailyReturns(days, close),
    zero = () => new Float64Array(symbols.length),
    trend: Weights[] = [],
    xsmom: Weights[] = [],
    book: Weights[] = [];
  let xs = zero();
  days.forEach((ts, i) => {
    const t = volTargetAndCap(trendRaw(close, rets, i, rules), rets, i, rules);
    if (isRebalanceDay(ts, rules.xsmom.rebalanceDays))
      xs = volTargetAndCap(xsmomRaw(close, rets, i, rules), rets, i, rules);
    // A coin with no bar today cannot be held into tomorrow.
    xs = xs.map((w, j) => (Number.isFinite(close[i]![j]!) ? w : 0));
    const b = t.map(
        (w, j) => rules.allocation.trend * w + rules.allocation.xsmom * xs[j]!,
      ),
      gross = b.reduce((a, x) => a + Math.abs(x), 0);
    trend.push(t);
    xsmom.push(xs);
    book.push(
      gross > rules.maxGrossLeverage
        ? b.map((x) => (x * rules.maxGrossLeverage) / gross)
        : b,
    );
  });
  // Open-to-open return of coin j from day i+1 to day i+2; 0 if either open is missing (halt/delisting).
  const oo = (i: number, j: number) => {
    const a = open[i + 1]?.[j],
      b = open[i + 2]?.[j];
    return a! > 0 && b! > 0 && days[i + 2]! - days[i + 1]! === DAY
      ? b! / a! - 1
      : 0;
  };
  const sleeve = (w: Weights[]) =>
    days.map((_, i) => {
      if (i + 2 >= days.length) return NaN;
      const prev = w[i - 1] ?? zero();
      let r = 0,
        turnover = 0;
      for (let j = 0; j < symbols.length; j++)
        ((r += w[i]![j]! * oo(i, j)),
          (turnover += Math.abs(w[i]![j]! - prev[j]!)));
      return r - (turnover * rules.costBpsPerSide) / 10_000;
    });
  const equalWeight = days.map((_, i) => {
    if (i + 2 >= days.length) return NaN;
    const live = [...symbols.keys()].filter(
      (j) => Number.isFinite(close[i]![j]!) && open[i + 2]?.[j]! > 0,
    );
    return live.length
      ? live.reduce((a, j) => a + oo(i, j), 0) / live.length
      : 0;
  });
  return {
    days,
    symbols,
    weights: { trend, xsmom, book },
    returns: {
      trend: sleeve(trend),
      xsmom: sleeve(xsmom),
      book: sleeve(book),
      equalWeight,
    },
  };
}

export interface MomentumStats {
  days: number;
  totalReturn: number;
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
}

/** Stats over returns whose decision day is in [from, to). */
export function momentumStats(
  run: MomentumRun,
  series: number[],
  from = -Infinity,
  to = Infinity,
): MomentumStats | null {
  const r = series.filter(
    (x, i) => Number.isFinite(x) && run.days[i]! >= from && run.days[i]! < to,
  );
  if (r.length < 2) return null;
  let eq = 1,
    peak = 1,
    dd = 0;
  for (const x of r)
    ((eq *= 1 + x),
      (peak = Math.max(peak, eq)),
      (dd = Math.max(dd, 1 - eq / peak)));
  const m = r.reduce((a, b) => a + b, 0) / r.length,
    sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return {
    days: r.length,
    totalReturn: eq - 1,
    cagr: eq ** (YEAR / r.length) - 1,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(YEAR) : 0,
    maxDrawdown: dd,
  };
}

export interface MomentumAcceptance {
  minDays: number;
  minSharpe: number;
  minSleeveSharpe: number;
  maxDrawdown: number;
  /** Annualised OLS alpha of the book on equal-weight buy-and-hold must exceed this. */
  minAlphaVsEqualWeight: number;
}

/** Annualised intercept and slope of book daily returns regressed on benchmark daily returns. */
export function alphaBeta(run: MomentumRun, from: number, to = Infinity) {
  const pairs = run.days
    .map(
      (d, i) => [d, run.returns.book[i]!, run.returns.equalWeight[i]!] as const,
    )
    .filter(
      ([d, y, x]) =>
        d >= from && d < to && Number.isFinite(y) && Number.isFinite(x),
    );
  if (pairs.length < 2) return null;
  const n = pairs.length,
    mx = pairs.reduce((a, p) => a + p[2], 0) / n,
    my = pairs.reduce((a, p) => a + p[1], 0) / n,
    vx = pairs.reduce((a, p) => a + (p[2] - mx) ** 2, 0),
    beta =
      vx > 0
        ? pairs.reduce((a, p) => a + (p[2] - mx) * (p[1] - my), 0) / vx
        : 0;
  return { alphaAnnual: (my - beta * mx) * YEAR, beta };
}

/** Pass/fail on a window; PENDING until minDays of returns exist. */
export function momentumVerdict(
  run: MomentumRun,
  a: MomentumAcceptance,
  from: number,
  to = Infinity,
) {
  const s = (x: number[]) => momentumStats(run, x, from, to),
    book = s(run.returns.book),
    trend = s(run.returns.trend),
    xsmom = s(run.returns.xsmom),
    ew = s(run.returns.equalWeight),
    reasons: string[] = [];
  if (!book || book.days < a.minDays)
    return {
      verdict: 'PENDING' as const,
      reasons: ['insufficient_days'],
      book,
      trend,
      xsmom,
      equalWeight: ew,
    };
  if (book.maxDrawdown > a.maxDrawdown) reasons.push('drawdown_above_limit');
  if (book.sharpe <= a.minSharpe) reasons.push('sharpe_below_target');
  if ((trend?.sharpe ?? 0) <= a.minSleeveSharpe)
    reasons.push('trend_sleeve_not_positive');
  if ((xsmom?.sharpe ?? 0) <= a.minSleeveSharpe)
    reasons.push('xsmom_sleeve_not_positive');
  const ab = alphaBeta(run, from, to);
  if ((ab?.alphaAnnual ?? 0) <= a.minAlphaVsEqualWeight)
    reasons.push('no_alpha_vs_equal_weight');
  return {
    verdict: reasons.length ? ('FAIL' as const) : ('PASS' as const),
    reasons,
    book,
    trend,
    xsmom,
    equalWeight: ew,
    ...ab,
  };
}
