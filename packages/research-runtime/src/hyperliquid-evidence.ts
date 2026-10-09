/**
 * Read-only Hyperliquid view for the dashboard: the latest venue price check,
 * live funding / open interest for the covered coins, and HYPE's data source.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fetchHlCandles,
  fetchHlContexts,
  hlCoin,
} from '../../market-data/src/hyperliquid.js';

const DAY = 86_400_000;
/** Hourly funding × 24 × 365. */
const annualise = (hourly: number) => hourly * 24 * 365;

async function latestVenueCheck(dataDir: string) {
  const dir = join(dataDir, 'venue');
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^price-check-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (!files.length) return null;
  return JSON.parse(await readFile(join(dir, files.at(-1)!), 'utf8'));
}

export async function hyperliquidEvidence(dataDir: string, planPath: string) {
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as {
    version: string;
    symbols: string[];
    priceSources?: Record<string, { venue: string; coin: string; market: string; pair: string }>;
    amendments?: { date: string; change: string; reason: string }[];
  };
  const [venueCheck, contexts] = await Promise.all([
    latestVenueCheck(dataDir),
    fetchHlContexts().catch(() => null),
  ]);
  const markets = plan.symbols.map((symbol) => {
    const c = contexts?.get(hlCoin(symbol));
    return c
      ? {
          symbol,
          coin: c.coin,
          listed: true,
          markPx: c.markPx,
          fundingAprPct: annualise(c.funding) * 100,
          openInterestUsd: c.openInterest * c.markPx,
          dayVolumeUsd: c.dayNtlVlm,
        }
      : { symbol, coin: hlCoin(symbol), listed: false };
  });

  const hypeSource = plan.priceSources?.HYPEUSDT ?? null;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const hypeBars = hypeSource
    ? await fetchHlCandles(hypeSource.coin, '1d', today - 120 * DAY, today, {}).catch(
        () => [],
      )
    : [];
  // Same rule as the live engine: breakout above the prior 20 closes.
  const closes = hypeBars.map((b) => b.close),
    last = closes.at(-1),
    prior = closes.slice(-21, -1),
    breakoutHigh = prior.length === 20 ? Math.max(...prior) : null;
  let liveState: Record<string, any> | null = null;
  try {
    liveState = JSON.parse(
      await readFile(join(dataDir, 'trend', 'live', plan.version, 'state.json'), 'utf8'),
    );
  } catch {}
  const hypeOpen = (liveState?.open ?? []).find((o: any) => o.symbol === 'HYPEUSDT') ?? null;

  return {
    asOf: Date.now(),
    contextsAvailable: contexts !== null,
    plan: plan.version,
    venueCheck,
    markets,
    hype: {
      source: hypeSource,
      amendment:
        plan.amendments?.find((a) => a.change.includes('HYPEUSDT')) ?? null,
      bars: hypeBars,
      lastClose: last ?? null,
      breakoutHigh,
      toHighBps:
        last && breakoutHigh ? (last / breakoutHigh - 1) * 10_000 : null,
      perp: markets.find((m) => m.symbol === 'HYPEUSDT') ?? null,
      openPosition: hypeOpen,
      liveEngineReporting: liveState !== null,
    },
  };
}
