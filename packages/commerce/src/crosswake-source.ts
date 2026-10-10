import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { epochMs } from '../../domain/src/index.js';
import { measureBook } from '../../market-data/src/depth.js';
import { fetchHlBook } from '../../market-data/src/hyperliquid.js';
import { regress } from '../../quant/src/index.js';
import type { EvidenceRef } from './types.js';
import type { ResearchEvidenceSource, ResearchGap } from './need.js';

/**
 * A liquidity measurement the pipeline produced itself, from a venue it can
 * read for free. `venue` is recorded because a perp book is a cross-venue proxy
 * for spot, not a measurement of the spot venue.
 */
export interface DepthEvidence {
  venue: string;
  ts: number;
  spreadBps: number;
  bidDepthUsdt: number;
  askDepthUsdt: number;
  impact: {
    notionalUsdt: number;
    buyBps: number | null;
    sellBps: number | null;
  }[];
}

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

interface DailyBar {
  ts: number;
  close: number;
  quantity: number;
}

/**
 * Reads Binance daily klines already on disk (`data/daily/<SYMBOL>/*.csv`), the
 * same layout `apps/trend` consumes. No network access: this is point-in-time
 * local evidence.
 */
async function readDaily(root: string, symbol: string): Promise<DailyBar[]> {
  const dir = join(root, 'daily', symbol),
    bars: DailyBar[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith('.csv')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!/^\d/.test(line)) continue;
      const columns = line.split(','),
        // Older Binance archives are microseconds; a present-day asset universe
        // must not be misread as a future timestamp.
        ts = epochMs(Number(columns[0])),
        close = Number(columns[4]),
        quantity = Number(columns[5]);
      if (!(close > 0) || !Number.isFinite(ts)) continue;
      if (bars.length && ts <= bars.at(-1)!.ts) continue;
      bars.push({
        ts,
        close,
        quantity: Number.isFinite(quantity) ? quantity : 0,
      });
    }
  }
  return bars;
}

/**
 * Crosswake evidence source: what the pipeline already holds for one asset, and
 * the metrics it genuinely cannot produce locally.
 *
 * It is the only Crosswake-aware file in `packages/commerce`, so the commerce
 * core (registry, policy, payments, ledger, validation) stays portable.
 */
export function crosswakeEvidenceSource(options: {
  dataDir: string;
  asset: string;
  market: 'spot' | 'usdm';
  windowDays?: number;
  /**
   * A live liquidity measurement. Omitted by default so the research run stays
   * offline and deterministic; when it yields a snapshot the pipeline no longer
   * declares depth as missing, so it is not bought.
   */
  depth?: (now: number) => Promise<DepthEvidence | null>;
}): ResearchEvidenceSource {
  const windowDays = options.windowDays ?? 180,
    btc = options.asset === 'BTCUSDT' ? null : 'BTCUSDT';

  return {
    asset: options.asset,
    market: options.market,
    async inventory(now: number) {
      const assetBars = await readDaily(options.dataDir, options.asset),
        btcBars = btc ? await readDaily(options.dataDir, btc) : [],
        items: EvidenceRef[] = [],
        provenance: string[] = [];
      if (assetBars.length) {
        const last = assetBars.at(-1)!,
          first = assetBars[0]!,
          count = assetBars.length,
          ageMs = now - last.ts,
          hash = digest(`${options.asset}:${first.ts}:${last.ts}:${count}`);
        provenance.push(`data/daily/${options.asset} (${count} bars)`);
        items.push({
          id: `${options.asset}-price-history`,
          dataType: 'market_price_history',
          classification: 'measured',
          source: `data/daily/${options.asset}`,
          asOf: last.ts,
          freshnessMs: 86_400_000,
          digest: hash,
          summary: `${count} daily closes from ${new Date(first.ts).toISOString().slice(0, 10)} to ${new Date(last.ts).toISOString().slice(0, 10)}; newest bar is ${Math.round(ageMs / 3_600_000)}h old`,
        });
        items.push({
          id: `${options.asset}-volume-history`,
          dataType: 'market_volume_history',
          classification: 'measured',
          source: `data/daily/${options.asset}`,
          asOf: last.ts,
          freshnessMs: 86_400_000,
          digest: hash,
          summary: `daily base-asset volume series over the same window`,
        });
        if (btcBars.length) {
          const btcByTs = new Map(btcBars.map((bar) => [bar.ts, bar.close])),
            sample = assetBars
              .filter((bar) => btcByTs.has(bar.ts))
              .slice(-windowDays),
            x: number[] = [],
            y: number[] = [];
          for (let i = 1; i < sample.length; i++) {
            const previous = sample[i - 1]!,
              current = sample[i]!,
              btcPrevious = btcByTs.get(previous.ts)!,
              btcCurrent = btcByTs.get(current.ts)!;
            if (btcPrevious > 0 && btcCurrent > 0 && previous.close > 0)
              x.push(Math.log(btcCurrent / btcPrevious));
            y.push(Math.log(current.close / previous.close));
          }
          const aligned = Math.min(x.length, y.length),
            fit =
              aligned >= 3
                ? regress(x.slice(0, aligned), y.slice(0, aligned))
                : null;
          if (fit) {
            const asOf = sample.at(-1)?.ts ?? last.ts;
            items.push({
              id: `${options.asset}-btc-correlation`,
              dataType: 'btc_correlation_metrics',
              classification: 'measured',
              source: `data/daily/${options.asset} vs data/daily/BTCUSDT`,
              asOf,
              freshnessMs: 86_400_000,
              digest: digest(
                `${options.asset}-corr:${aligned}:${fit.correlation.toFixed(6)}`,
              ),
              summary: `log-return correlation ${fit.correlation.toFixed(4)} over n=${fit.n} aligned daily returns, beta ${fit.beta.toFixed(4)}, residual vol ${fit.residualVol.toFixed(5)}`,
            });
            provenance.push(`data/daily/${btc} (${btcBars.length} bars)`);
          }
        }
      }
      try {
        const context = JSON.parse(
          await readFile(
            join(options.dataDir, 'context', 'altfins', 'latest.json'),
            'utf8',
          ),
        ) as { availableAt?: number; expiresAt?: number };
        if (typeof context.availableAt === 'number') {
          provenance.push('data/context/altfins/latest.json');
          items.push({
            id: `${options.asset}-sentiment`,
            dataType: 'sentiment_indicators',
            classification: 'measured',
            source: 'altFINS screener snapshot',
            asOf: context.availableAt,
            freshnessMs:
              typeof context.expiresAt === 'number'
                ? Math.max(0, context.expiresAt - context.availableAt)
                : 900_000,
            digest: digest(`altfins:${context.availableAt}`),
            summary:
              'altFINS higher-timeframe indicators (RSI/MACD/market cap) for the universe',
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const assetPrefix = `data/normalized/.../symbol=${options.asset}`;
      try {
        await readdir(join(options.dataDir, 'normalized'));
        provenance.push('data/normalized (1s research data)');
        items.push({
          id: `${options.asset}-research-data`,
          dataType: 'market_price_history',
          classification: 'measured',
          source: `${assetPrefix} (1s traded price and quote volume)`,
          asOf: now,
          freshnessMs: 60_000,
          digest: digest(`normalized:${options.asset}`),
          summary:
            'second-resolution traded price, quote volume and top-of-book quotes collected live',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const snapshot = options.depth
          ? await options.depth(now).catch(() => null)
          : null,
        freshnessMs = 300_000;
      if (snapshot) {
        const measured = `spread ${snapshot.spreadBps.toFixed(2)} bps, bid depth ${Math.round(snapshot.bidDepthUsdt).toLocaleString('en-US')} USDT, ask depth ${Math.round(snapshot.askDepthUsdt).toLocaleString('en-US')} USDT`,
          roundTrip = snapshot.impact
            .filter((i) => i.buyBps !== null && i.sellBps !== null)
            .map(
              (i) =>
                `${i.notionalUsdt.toLocaleString('en-US')} USDT ${(i.buyBps! + i.sellBps!).toFixed(2)} bps round trip`,
            )
            .join(', ');
        provenance.push(
          `${snapshot.venue} level-2 snapshot at ${new Date(snapshot.ts).toISOString()}`,
        );
        items.push({
          id: `${options.asset}-order-book-depth`,
          dataType: 'order_book_depth',
          classification: 'measured',
          source: `${snapshot.venue} level-2 order book`,
          asOf: snapshot.ts,
          freshnessMs,
          digest: digest(`${options.asset}-depth:${snapshot.ts}:${measured}`),
          summary: `${measured}. Cross-venue proxy: this is a perpetuals book, so it indicates rather than measures ${options.asset} spot depth.`,
        });
        items.push({
          id: `${options.asset}-market-impact`,
          dataType: 'market_impact_liquidity',
          classification: 'measured',
          source: `${snapshot.venue} level-2 order book`,
          asOf: snapshot.ts,
          freshnessMs,
          digest: digest(`${options.asset}-impact:${snapshot.ts}:${roundTrip}`),
          summary: `Round-trip market impact from the same snapshot: ${roundTrip || 'no notionals were sweepable'}. Same cross-venue caveat as the depth measurement.`,
        });
      }
      const liquidityGaps: ResearchGap[] = [
        {
          dataType: 'order_book_depth',
          reason: `Crosswake stores top-of-book quotes only. Full order-book depth for ${options.asset} is fetched on demand by packages/market-data/src/depth.ts and never persisted, so no depth history exists for this research run.`,
          expectedResearchBenefit:
            'Depth history would let the pipeline estimate whether a signalled entry is executable at the quoted price or only on paper.',
          desiredFreshnessMs: 86_400_000,
          maxCostUsdc: '0.25',
          priority: 'high',
        },
        {
          dataType: 'market_impact_liquidity',
          reason: `Round-trip market-impact curves are only computed transiently by the depth CLI; nothing is stored, so impact cannot be compared across time for ${options.asset}.`,
          expectedResearchBenefit:
            'Impact curves convert a signal into a realistic cost estimate instead of a flat fee assumption.',
          desiredFreshnessMs: 3 * 86_400_000,
          maxCostUsdc: '0.25',
          priority: 'high',
        },
      ];
      // A gap is only a gap while the pipeline cannot produce it. A live
      // snapshot of the same metric removes it, so it is not bought.
      const gaps: ResearchGap[] = [
        ...(snapshot ? [] : liquidityGaps),
        {
          dataType: 'holder_concentration',
          reason:
            'No holder-distribution source is integrated anywhere in the repository.',
          expectedResearchBenefit:
            'Concentration is a risk input: a concentrated asset is more exposed to single-actor flow.',
          desiredFreshnessMs: 7 * 86_400_000,
          maxCostUsdc: '0.25',
          priority: 'medium',
        },
        {
          dataType: 'token_flow_metrics',
          reason: 'No exchange-flow or on-chain transfer source is integrated.',
          expectedResearchBenefit:
            'Exchange net flow is corroborating context for a directional signal.',
          desiredFreshnessMs: 86_400_000,
          maxCostUsdc: '0.25',
          priority: 'medium',
        },
      ];
      return { items, gaps, provenance };
    },
  };
}

/**
 * A free, live liquidity measurement from Hyperliquid's public level-2 endpoint.
 * No key, no signing, no cost, so it is evidence the pipeline produces rather
 * than buys. Failures return null: the declared gap then stays open, which is
 * the honest fallback rather than a silent substitution.
 */
export function hyperliquidDepth(
  coin: string,
  options: {
    fetcher?: typeof fetch;
    notionals?: number[];
  } = {},
): (now: number) => Promise<DepthEvidence | null> {
  return async () => {
    try {
      // Bounded retries: a research run must not wait out a venue outage, and a
      // failure only means the declared gap stays open.
      const { book, ts } = await fetchHlBook(coin, {
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          attempts: 2,
        }),
        measured = measureBook(
          book,
          options.notionals ?? [10_000, 50_000, 250_000],
        );
      return {
        venue: 'Hyperliquid perps',
        ts,
        spreadBps: measured.spreadBps,
        bidDepthUsdt: measured.bidDepthUsdt,
        askDepthUsdt: measured.askDepthUsdt,
        impact: measured.impact,
      };
    } catch {
      return null;
    }
  };
}
