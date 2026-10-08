import { mean, variance, regress, type PriceSeries } from './index.js';

export interface ForwardSettings {
  entryDelayMs: number;
  dataLatencyBudgetMs: number;
  outcomeHorizonMs: number;
  minValidationSamples: number;
  minIncrementalSkill: number;
  minNetRewardRisk: number;
  maxEntryDriftBps: number;
  signalTtlMs: number;
  universeWindowMs: number;
  minAssetQuoteVolume: number;
  minQuoteCoverage: number;
  maxConcurrentPositions: number;
}
interface Observation {
  ts: number;
  labelEnd: number;
  btc: number;
  alt: number;
  future: number;
}
export interface ForwardModel {
  asOf: number;
  lastLabelTs: number;
  delayMs: number;
  horizonMs: number;
  trainingSamples: number;
  validationSamples: number;
  alpha: number;
  btcBeta: number;
  altBeta: number;
  residualVol: number;
  btcVol: number;
  validationCorrelation: number;
  incrementalSkill: number;
  constantSkill: number;
  btcOnlyMse: number;
  altOnlyMse: number;
  modelMse: number;
}
/** Two-feature OLS; reject unidentified coefficients rather than add arbitrary regularization. */
function fit(rows: Observation[]) {
  if (rows.length < 6) return null;
  const bx = mean(rows.map((r) => r.btc)),
    ax = mean(rows.map((r) => r.alt)),
    y = mean(rows.map((r) => r.future));
  let bb = 0,
    aa = 0,
    ba = 0,
    by = 0,
    ay = 0;
  for (const r of rows) {
    const b = r.btc - bx,
      a = r.alt - ax,
      f = r.future - y;
    bb += b * b;
    aa += a * a;
    ba += b * a;
    by += b * f;
    ay += a * f;
  }
  const det = bb * aa - ba * ba;
  if (bb <= 0 || aa <= 0 || det <= bb * aa * 1e-8) return null;
  const btcBeta = (by * aa - ay * ba) / det,
    altBeta = (ay * bb - by * ba) / det;
  return { alpha: y - btcBeta * bx - altBeta * ax, btcBeta, altBeta };
}
export const predictForward = (
  m: Pick<ForwardModel, 'alpha' | 'btcBeta' | 'altBeta'>,
  btc: number,
  alt: number,
) => m.alpha + m.btcBeta * btc + m.altBeta * alt;

/** All labels end by asOf. Feature and outcome intervals never overlap. Validation is later than training. */
export function forwardModel(
  btc: PriceSeries,
  alt: PriceSeries,
  asOf: number,
  windowMs: number,
  featureMs: number,
  delayMs: number,
  outcomeMs: number,
  minSamples: number,
  minValidationSamples: number,
): ForwardModel | null {
  const rows: Observation[] = [];
  // Disjoint full observation spans, anchored to absolute time, not the last fit clock.
  const stride = featureMs + delayMs + outcomeMs;
  const first = Math.ceil((asOf - windowMs + featureMs) / stride) * stride;
  for (let ts = first; ts + delayMs + outcomeMs <= asOf; ts += stride) {
    const b = btc.returnAt(ts, featureMs, asOf),
      a = alt.returnAt(ts, featureMs, asOf);
    const future = alt.returnAt(ts + delayMs + outcomeMs, outcomeMs, asOf);
    if (b !== null && a !== null && future !== null)
      rows.push({
        ts,
        labelEnd: ts + delayMs + outcomeMs,
        btc: b,
        alt: a,
        future,
      });
  }
  const split = Math.floor(rows.length * 0.75),
    train = rows.slice(0, split),
    validation = rows.slice(split);
  if (train.length < minSamples || validation.length < minValidationSamples)
    return null;
  const model = fit(train),
    altOnly = regress(
      train.map((r) => r.alt),
      train.map((r) => r.future),
    ),
    btcOnly = regress(
      train.map((r) => r.btc),
      train.map((r) => r.future),
    );
  if (!model) return null;
  const constant = mean(train.map((r) => r.future));
  const predictions = validation.map((r) =>
    predictForward(model, r.btc, r.alt),
  );
  const mse = (prediction: (r: Observation, i: number) => number) =>
    mean(validation.map((r, i) => (r.future - prediction(r, i)) ** 2));
  const modelMse = mse((_, i) => predictions[i]!),
    altOnlyMse = mse((r) =>
      altOnly ? altOnly.alpha + altOnly.beta * r.alt : constant,
    ),
    constantMse = mse(() => constant);
  if (altOnlyMse <= 0 || constantMse <= 0) return null;
  return {
    ...model,
    asOf,
    lastLabelTs: rows.at(-1)!.labelEnd,
    delayMs,
    horizonMs: outcomeMs,
    trainingSamples: train.length,
    validationSamples: validation.length,
    residualVol: Math.sqrt(modelMse),
    btcVol: Math.sqrt(variance(train.map((r) => r.btc)) ?? 0),
    validationCorrelation:
      regress(
        predictions,
        validation.map((r) => r.future),
      )?.correlation ?? 0,
    incrementalSkill: 1 - modelMse / altOnlyMse,
    constantSkill: 1 - modelMse / constantMse,
    btcOnlyMse: mse((r) =>
      btcOnly ? btcOnly.alpha + btcOnly.beta * r.btc : constant,
    ),
    altOnlyMse,
    modelMse,
  };
}
