import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import {
  fetchContext,
  persistContext,
} from '../../../packages/context/src/index.js';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((x) => x !== '--'),
  options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR ?? './data' },
    watch: { type: 'boolean', default: false },
  },
});
const key = process.env.ALTFINS_API_KEY;
if (!key)
  throw new Error(
    'Configure ALTFINS_API_KEY locally; never paste keys into research conversations',
  );
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopped = true;
  });
do {
  try {
    const snapshot = await fetchContext(
      key,
      (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
        .split(',')
        .map((s) => s.replace(/USDT$/, '')),
    );
    await persistContext(values['data-dir']!, snapshot);
    console.log({
      provider: snapshot.provider,
      availableAt: snapshot.availableAt,
      expiresAt: snapshot.expiresAt,
      payloadHash: snapshot.payloadHash,
    });
  } catch (error) {
    console.error(String(error));
    if (!values.watch) {
      process.exitCode = 1;
      break;
    }
  }
  if (!values.watch) break;
  for (let second = 0; second < 300 && !stopped; second++)
    await new Promise((resolve) => setTimeout(resolve, 1000));
} while (!stopped);
