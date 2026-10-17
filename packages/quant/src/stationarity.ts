export type Significance = 0.01 | 0.05 | 0.1;

const DICKEY_FULLER: Record<Significance, number> = {
  0.01: -3.43,
  0.05: -2.86,
  0.1: -2.57,
};

const ENGLE_GRANGER: Record<Significance, number> = {
  0.01: -3.9,
  0.05: -3.34,
  0.1: -3.04,
};

export const dickeyFullerCritical = (alpha: Significance): number =>
  DICKEY_FULLER[alpha];
export const engleGrangerCritical = (alpha: Significance): number =>
  ENGLE_GRANGER[alpha];

export function asSignificance(alpha: number): Significance {
  if (alpha <= 0.01) return 0.01;
  if (alpha <= 0.05) return 0.05;
  return 0.1;
}

export function normCdf(x: number): number {
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

const TAU_MAX_C = [2.74, 0.92, 0.55, 0.61, 0.79, 1];
const TAU_MIN_C = [-18.83, -18.86, -23.48, -28.07, -25.96, -23.27];
const TAU_STAR_C = [-1.61, -2.62, -3.13, -3.47, -3.78, -3.93];

const TAU_SMALLP_C = [
  [2.1659, 1.4412, 0.038269],
  [2.92, 1.5012, 0.039796],
  [3.4699, 1.4856, 0.03164],
  [3.9673, 1.4777, 0.026315],
  [4.5509, 1.5338, 0.029545],
  [5.1399, 1.6036, 0.034445],
];

const TAU_LARGEP_C = [
  [1.7339, 0.93202, -0.12745, -0.010368],
  [2.1945, 0.64695, -0.29198, -0.04004],
  [2.5893, 0.45168, -0.36529, -0.050074],
  [3.0387, 0.45452, -0.33666, -0.041921],
  [3.5049, 0.52098, -0.29158, -0.033468],
  [3.9489, 0.58933, -0.25359, -0.02721],
];

export function macKinnonPValue(tau: number, n = 2): number {
  const i = n - 1;
  if (i < 0 || i >= TAU_MAX_C.length)
    throw new RangeError(
      `macKinnonPValue: n=${n} out of tabulated range (1..${TAU_MAX_C.length})`,
    );
  if (tau > TAU_MAX_C[i]!) return 1;
  if (tau < TAU_MIN_C[i]!) return 0;
  const coef = tau <= TAU_STAR_C[i]! ? TAU_SMALLP_C[i]! : TAU_LARGEP_C[i]!;
  let arg = 0;
  for (let k = 0; k < coef.length; k++) arg += coef[k]! * tau ** k;
  return normCdf(arg);
}

type Matrix = number[][];

function transpose(m: Matrix): Matrix {
  const rows = m.length,
    cols = m[0]!.length;
  const out: Matrix = Array.from({ length: cols }, () =>
    new Array<number>(rows).fill(0),
  );
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) out[j]![i] = m[i]![j]!;
  return out;
}

function invert(m: Matrix): Matrix {
  const n = m.length;
  const a = m.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) < 1e-12) throw new Error('singular matrix');
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const pv = a[col]![col]!;
    for (let j = 0; j < 2 * n; j++) a[col]![j] = a[col]![j]! / pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++)
        a[r]![j] = a[r]![j]! - factor * a[col]![j]!;
    }
  }
  return a.map((row) => row.slice(n));
}

interface MultiReg {
  coefficients: number[];
  stdErrors: number[];
  residuals: number[];
}

function multipleRegression(y: number[], X: Matrix): MultiReg {
  const n = X.length,
    k = X[0]!.length;
  if (n !== y.length) throw new Error('length mismatch');
  if (n <= k) throw new Error('not enough observations');
  const Xt = transpose(X);
  const k_ = Xt.length;
  const XtX: Matrix = Array.from({ length: k_ }, () =>
    new Array<number>(k_).fill(0),
  );
  for (let i = 0; i < k_; i++)
    for (let j = 0; j < k_; j++)
      for (let r = 0; r < n; r++)
        XtX[i]![j] = XtX[i]![j]! + Xt[i]![r]! * X[r]![j]!;
  const XtXinv = invert(XtX);
  const Xty = new Array<number>(k_).fill(0);
  for (let i = 0; i < k_; i++)
    for (let r = 0; r < n; r++) Xty[i]! += Xt[i]![r]! * y[r]!;
  const coefficients = XtXinv.map((row) =>
    row.reduce((s, x, j) => s + x * Xty[j]!, 0),
  );
  const residuals = y.map(
    (yi, i) => yi - X[i]!.reduce((s, x, j) => s + x * coefficients[j]!, 0),
  );
  const rss = residuals.reduce((s, e) => s + e * e, 0);
  const sigma2 = rss / (n - k);
  const stdErrors = XtXinv.map((row, j) => Math.sqrt(sigma2 * row[j]!));
  return { coefficients, stdErrors, residuals };
}

export interface AdfResult {
  tStat: number;
  lagsUsed: number;
  nobs: number;
  critical: number;
}

export function adfTest(
  series: number[],
  alpha: Significance = 0.05,
  maxLag?: number,
): AdfResult | null {
  const n = series.length;
  const p = maxLag ?? Math.floor(Math.cbrt(n - 1));
  const dy: number[] = [];
  for (let i = 1; i < n; i++) dy.push(series[i]! - series[i - 1]!);
  const Y: number[] = [];
  const X: Matrix = [];
  for (let t = p; t < dy.length; t++) {
    const row: number[] = [1, series[t]!];
    for (let k = 1; k <= p; k++) row.push(dy[t - k]!);
    X.push(row);
    Y.push(dy[t]!);
  }
  if (X.length === 0 || X.length <= X[0]!.length) return null;
  let regression: MultiReg;
  try {
    regression = multipleRegression(Y, X);
  } catch (error) {
    if (error instanceof Error && error.message === 'singular matrix')
      return null;
    throw error;
  }
  const { coefficients, stdErrors } = regression;
  const gamma = coefficients[1]!,
    seGamma = stdErrors[1]!;
  if (!(seGamma > 0)) return null;
  return {
    tStat: gamma / seGamma,
    lagsUsed: p,
    nobs: Y.length,
    critical: DICKEY_FULLER[alpha],
  };
}

export interface CointResult {
  beta: number;
  alpha: number;
  adfStat: number;

  pValue: number;
  critical: number;
  cointegrated: boolean;
  spread: number[];
}

function olsLevels(y: number[], x: number[]) {
  const n = x.length;
  if (n === 0 || n !== y.length) throw new Error('length mismatch');
  const mx = x.reduce((a, b) => a + b, 0) / n,
    my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  if (sxx <= Number.EPSILON) return null;
  const beta = sxy / sxx,
    alpha = my - beta * mx;
  return {
    beta,
    alpha,
    residuals: y.map((yi, i) => yi - (beta * x[i]! + alpha)),
  };
}

export function engleGranger(
  pricesA: number[],
  pricesB: number[],
  alpha: Significance = 0.05,
): CointResult | null {
  const fit = olsLevels(pricesA, pricesB);
  if (!fit) return null;
  const adf = adfTest(fit.residuals, alpha);
  if (!adf) return null;
  const critical = ENGLE_GRANGER[alpha];
  return {
    beta: fit.beta,
    alpha: fit.alpha,
    adfStat: adf.tStat,
    pValue: macKinnonPValue(adf.tStat, 2),
    critical,
    cointegrated: adf.tStat < critical,
    spread: fit.residuals,
  };
}

export function halfLife(spread: number[]): number {
  if (spread.length < 3) return Infinity;
  const lagged = spread.slice(0, -1);
  const delta = spread.slice(1).map((v, i) => v - lagged[i]!);
  const mx = lagged.reduce((a, b) => a + b, 0) / lagged.length,
    my = delta.reduce((a, b) => a + b, 0) / delta.length;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < lagged.length; i++) {
    sxy += (lagged[i]! - mx) * (delta[i]! - my);
    sxx += (lagged[i]! - mx) ** 2;
  }
  if (sxx <= Number.EPSILON) return Infinity;
  const lambda = sxy / sxx;
  if (lambda >= 0) return Infinity;
  return -Math.LN2 / lambda;
}

export function isTradeableHalfLife(
  spread: number[],
  minBars: number,
  maxBars: number,
): boolean {
  const hl = halfLife(spread);
  return Number.isFinite(hl) && hl >= minBars && hl <= maxBars;
}

export interface BHResult {
  rejected: boolean[];

  threshold: number;
  count: number;
}

export function benjaminiHochberg(pValues: number[], q: number): BHResult {
  const m = pValues.length;
  const rejected = new Array<boolean>(m).fill(false);
  if (m === 0) return { rejected, threshold: 0, count: 0 };
  const order = pValues
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p || a.i - b.i);
  let kMax = 0;
  for (let rank = 1; rank <= m; rank++)
    if (order[rank - 1]!.p <= (rank / m) * q) kMax = rank;
  if (kMax === 0) return { rejected, threshold: 0, count: 0 };
  const threshold = order[kMax - 1]!.p;
  for (let rank = 0; rank < kMax; rank++) rejected[order[rank]!.i] = true;
  return { rejected, threshold, count: kMax };
}
