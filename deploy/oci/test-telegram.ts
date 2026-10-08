/**
 * End-to-end Telegram delivery check, using the application's own sink and deliver() path.
 *
 *   cd /opt/crosswake && node --import tsx deploy/oci/test-telegram.ts
 *
 * Sends one message clearly marked as a self-test, so the channel can be verified on demand
 * rather than waiting for a real signal. Reads its own credentials from .env.local; no secret
 * is ever passed as an argument or printed.
 */
import { existsSync } from 'node:fs';
import { sinksFromEnv, deliver } from '../../packages/notify/src/index.js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const { sinks, channels } = sinksFromEnv(process.env);
console.log(
  'channels:',
  channels.map((c) => `${c.name}=${c.enabled ? 'on' : 'off'}`).join(', '),
);

if (sinks.length === 0) {
  console.error(
    'No sinks enabled. Run deploy/oci/set-telegram.sh first (TELEGRAM_ENABLED not set).',
  );
  process.exit(1);
}

const deliveries = await deliver(sinks, {
  kind: 'signal',
  id: `self-test-${Date.now()}`,
  at: Date.now(),
  text: 'Crosswake self-test: delivery check, not a trading signal.',
});

for (const d of deliveries)
  console.log(
    `  ${d.sink}: ok=${d.ok} latencyMs=${d.latencyMs}${d.error ? ` error=${d.error}` : ''}`,
  );

process.exit(deliveries.every((d) => d.ok) ? 0 : 1);
