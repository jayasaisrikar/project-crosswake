// Deterministic v004 run on synthetic perp bars. Its trade digest was recorded before the v009
// simulator changes (per-signal hold, per-event cap) and must never change.
import { createHash } from 'node:crypto';
import { BarStore, MINUTE } from '../../packages/quant/src/residual.js';
import { residualSchema } from '../../packages/signals/src/residual.js';
import { runResidual } from '../../packages/backtest/src/residual.js';
import v004 from '../../configs/catchdown-perp-v004.json' with { type: 'json' };

const HOUR = 3600000,
  DAY = 86400000,
  start = Date.UTC(2026, 0, 1),
  symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
export const V004_REGRESSION_DIGEST =
  'a961251ffb7e1835d976511e524f8cdd4bee2eba043ba325fd000bf5d683400a';

const quantize = (v: unknown): unknown =>
  typeof v === 'number'
    ? Number(v.toPrecision(10))
    : Array.isArray(v)
      ? v.map(quantize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [k, quantize(x)]),
          )
        : v;

export function v004RegressionRun() {
  let seed = 11;
  const u = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647),
    normal = () =>
      Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u()),
    store = new BarStore(start, symbols),
    residual: Record<string, number> = { ETHUSDT: 0, SOLUSDT: 0 },
    betas: Record<string, number> = { ETHUSDT: 1.2, SOLUSDT: 1.6 };
  let btc = 0;
  for (let i = 0; i < (16 * DAY) / MINUTE; i++) {
    const ts = start + i * MINUTE;
    btc += 0.0012 * normal();
    store.set('BTCUSDT', {
      ts,
      close: 50000 * Math.exp(btc),
      quoteVolume: 1e6,
    });
    for (const s of ['ETHUSDT', 'SOLUSDT']) {
      residual[s] = residual[s]! * (1 - Math.LN2 / 120) + 0.0012 * normal();
      store.set(s, {
        ts,
        close: 100 * Math.exp(betas[s]! * btc + residual[s]!),
        quoteVolume: 1e6,
      });
    }
  }
  const config = residualSchema.parse({
      ...v004,
      symbols,
      estimationWindowMs: 3 * DAY,
      minFitSamples: 100,
      minReversionSamples: 20,
      minQuoteVolume24h: 0,
    }),
    funding = new Map(
      symbols.map((s, k) => [
        s,
        Array.from({ length: 48 }, (_, j) => ({
          ts: start + j * 8 * HOUR,
          rate: 1e-4 * (k + 1),
        })),
      ]),
    ),
    run = runResidual(
      store,
      config,
      { startTs: start + 4 * DAY, endTs: start + 16 * DAY },
      funding,
    );
  return {
    trades: run.trades.length,
    digest: createHash('sha256')
      .update(JSON.stringify(quantize(run.trades)))
      .digest('hex'),
  };
}
