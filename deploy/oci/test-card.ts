/**
 * Sends one real Telegram HTML card through the application's own formatter and delivery path,
 * so the visual result can be checked without waiting for a live signal.
 *
 *   cd /opt/crosswake && node --import tsx deploy/oci/test-card.ts
 *
 * Credentials come from .env.local, so no token is ever typed, passed as an argument, or printed.
 * The chat is whatever TELEGRAM_CHAT_ID is configured to.
 */
import { existsSync } from 'node:fs';
import { sinksFromEnv, deliver } from '../../packages/notify/src/index.js';
import { telegramSignal } from '../../apps/residual/src/format.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const signal = {
  symbol: 'SOLUSDT',
  instrument: 'outright',
  side: 'LONG',
  referencePrice: 142.31,
  entryAtTs: Date.now() + 300_000,
  entryPriceLimit: 142.9,
  targetPrice: 144.1,
  targetBps: 126,
  stopPrice: 141.2,
  stopBps: 78,
  holdMs: 3 * 3_600_000,
  btcMoveBps: 180,
  altMoveBps: 40,
  beta: 1.2,
  lagBps: 176,
  residualZ: 2.31,
  fit: { reversion: 0.42, reversionT: 2.8 },
  expectedNetBps: 31,
  costBps: 12,
  score: 74,
} as never;
const config = { lookbackMs: 2 * 3_600_000, version: 'residual-v003' } as never;

const { sinks, channels } = sinksFromEnv(process.env);
console.log(
  'channels:',
  channels.map((c) => `${c.name}=${c.enabled ? 'on' : 'off'}`).join(', '),
);
if (sinks.length === 0) {
  console.error('No sinks enabled — run deploy/oci/set-telegram.sh first.');
  process.exit(1);
}

const text =
  '🧪 <b>Test card, not a real signal</b>\n\n' +
  telegramSignal(signal, config);

const deliveries = await deliver(sinks, {
  kind: 'signal',
  id: `test-card-${Date.now()}`,
  at: Date.now(),
  text,
  html: true,
});

for (const d of deliveries)
  console.log(
    `  ${d.sink}: ok=${d.ok} latencyMs=${d.latencyMs}${d.error ? ` error=${d.error}` : ''}`,
  );

process.exit(deliveries.every((d) => d.ok) ? 0 : 1);
