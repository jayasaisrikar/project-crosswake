/**
 * Online Kalman filter tracking a time-varying hedge ratio for y = β·x + α
 * (Chan, "Algorithmic Trading", Kalman pairs). Ported from stat-arb
 * src/stats/kalman.ts; outputs match it exactly on finite input.
 *
 * Each step exposes the state BEFORE its update (`betaPrior`, `alphaPrior`,
 * i.e. t|t-1). A spread at t must be built from those: the posterior at t has
 * already seen y_t.
 */
export interface KalmanOptions {
  /** Process noise scale: how fast β and α are allowed to drift. */
  delta: number;
  /** Observation noise variance (replaced by the warm-up residual variance with scaleObsVar). */
  obsVar?: number;
  /**
   * Seed [β, α] with an OLS fit on the first `initBars` observations instead of
   * [0, 0]. Without this the filter spends its early life converging from an
   * absurd hedge ratio, polluting the innovation spread. Only bars inside the
   * warm-up window see those observations, and callers never trade there (the
   * rolling z is undefined until `zWindow` bars exist), so it stays causal for
   * every tradeable bar. 0 disables.
   */
  initBars?: number;
  /**
   * With `initBars`, replace `obsVar` by the OLS residual variance of the warm-up
   * fit. A fixed obsVar is scale-blind: on assets priced in the hundreds it is so
   * small relative to the spread that the filter absorbs the spread itself into
   * α, leaving an innovation series with no reversion left to trade.
   */
  scaleObsVar?: boolean;
}
export interface KalmanStep {
  /** State before this step's update (t|t-1). Use these for the spread at t. */
  betaPrior: number;
  alphaPrior: number;
  /** State after the update (t|t). */
  beta: number;
  alpha: number;
  /** Innovation y_t − (betaPrior·x_t + alphaPrior); NaN when the step had no observation. */
  error: number;
  /** Innovation standard deviation sqrt(F·R·Fᵀ + obsVar); NaN without an observation. */
  errorStd: number;
}
export interface KalmanState {
  b0: number;
  b1: number;
  r00: number;
  r01: number;
  r10: number;
  r11: number;
  obsVar: number;
  vw: number;
}

/** Same OLS as stat-arb's `ols(y, x)`: levels, y = βx + α. */
function ols(y: number[], x: number[]) {
  const n = x.length,
    mx = x.reduce((a, b) => a + b, 0) / n,
    my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  const beta = sxy / sxx,
    alpha = my - beta * mx;
  return {
    beta,
    alpha,
    residuals: y.map((yi, i) => yi - (beta * x[i]! + alpha)),
  };
}

/** Initial state; the OLS warm start uses the first `initBars` finite pairs. */
export function kalmanInit(
  y: number[],
  x: number[],
  opts: KalmanOptions,
): KalmanState {
  let b0 = 0,
    b1 = 0,
    obsVar = opts.obsVar ?? 1e-3;
  const ys: number[] = [],
    xs: number[] = [];
  for (let t = 0; t < y.length && ys.length < (opts.initBars ?? 0); t++)
    if (Number.isFinite(y[t]) && Number.isFinite(x[t]))
      (ys.push(y[t]!), xs.push(x[t]!));
  const init = ys.length;
  if (init >= 3) {
    const fit = ols(ys, xs);
    if (Number.isFinite(fit.beta) && Number.isFinite(fit.alpha)) {
      b0 = fit.beta;
      b1 = fit.alpha;
      if (opts.scaleObsVar) {
        const rv =
          fit.residuals.reduce((s, r) => s + r * r, 0) / Math.max(1, init - 2);
        if (rv > 0) obsVar = rv;
      }
    }
  }
  return {
    b0,
    b1,
    r00: 1,
    r01: 0,
    r10: 0,
    r11: 1,
    obsVar,
    vw: opts.delta / (1 - opts.delta),
  };
}

/**
 * One predict(+update) step, mutating `s`. A non-finite x or y gives no update:
 * the covariance still grows by process noise once and the state carries.
 */
export function kalmanStep(s: KalmanState, y: number, x: number): KalmanStep {
  const betaPrior = s.b0,
    alphaPrior = s.b1;
  // Predict: state unchanged, covariance grows by process noise (diagonal).
  s.r00 += s.vw;
  s.r11 += s.vw;
  if (!Number.isFinite(y) || !Number.isFinite(x))
    return {
      betaPrior,
      alphaPrior,
      beta: s.b0,
      alpha: s.b1,
      error: NaN,
      errorStd: NaN,
    };
  const f0 = x,
    f1 = 1,
    error = y - (f0 * s.b0 + f1 * s.b1),
    rf0 = s.r00 * f0 + s.r01 * f1,
    rf1 = s.r10 * f0 + s.r11 * f1,
    q = f0 * rf0 + f1 * rf1 + s.obsVar,
    k0 = rf0 / q,
    k1 = rf1 / q;
  s.b0 += k0 * error;
  s.b1 += k1 * error;
  const fr0 = f0 * s.r00 + f1 * s.r10,
    fr1 = f0 * s.r01 + f1 * s.r11,
    n00 = s.r00 - k0 * fr0,
    n01 = s.r01 - k0 * fr1,
    n10 = s.r10 - k1 * fr0,
    n11 = s.r11 - k1 * fr1;
  s.r00 = n00;
  s.r01 = n01;
  s.r10 = n10;
  s.r11 = n11;
  return {
    betaPrior,
    alphaPrior,
    beta: s.b0,
    alpha: s.b1,
    error,
    errorStd: Math.sqrt(q),
  };
}

/** Runs the filter over a whole series; returns the steps and the final state for carrying forward. */
export function kalmanHedge(y: number[], x: number[], opts: KalmanOptions) {
  if (y.length !== x.length) throw new Error('length mismatch');
  const state = kalmanInit(y, x, opts),
    steps = y.map((yi, t) => kalmanStep(state, yi, x[t]!));
  return { steps, state };
}
