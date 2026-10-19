import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { resolve } from 'node:path';
import { z } from 'zod';
import { createEvidenceServer } from '../../../packages/research-runtime/src/evidence-api.js';
import { createAskRouter } from '../../../packages/research-runtime/src/ask-api.js';
import { createCommerceRouter } from '../../../packages/commerce/src/api.js';
import { createCommerceServices } from '../../../packages/commerce/src/services.js';
import { crosswakeEvidenceSource } from '../../../packages/commerce/src/crosswake-source.js';
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.RESEARCH_API_PORT ?? 4112);
const token = process.env.RESEARCH_API_TOKEN?.trim();
const dataDir = resolve(process.env.DATA_DIR ?? './data');
const commerce = await createCommerceServices({
  dataDir,
  source: crosswakeEvidenceSource({
    dataDir,
    asset: z
      .string()
      .regex(/^[A-Z0-9]{2,20}$/)
      .parse(process.env.COMMERCE_ASSET ?? 'SOLUSDT'),
    market: 'spot',
  }),
}).catch((error) => {
  console.warn(
    `Commerce routes disabled: ${String(error instanceof Error ? error.message : error)}`,
  );
  return null;
});
const model = process.env.RESEARCH_MODEL?.trim();
const paths = {
  dataDir,
  protocolDir: resolve('research/frozen'),
};
const server = createEvidenceServer(paths, {
  token,
  ask: createAskRouter({ paths, model, token }),
  ...(commerce
    ? { commerce: createCommerceRouter({ services: commerce, token }) }
    : {}),
});
if (!token)
  console.warn(
    'RESEARCH_API_TOKEN is unset: this server is unauthenticated. That is fine on loopback; set it before exposing the port. Commerce mutations refuse to run without it.',
  );
if (commerce)
  console.log(
    `Commerce: mode=${commerce.env.mode} mainnetEnabled=${commerce.env.mainnetEnabled} caps=${commerce.policy.maxPerPaymentUsdc}/${commerce.policy.maxPerResearchRunUsdc}/${commerce.policy.maxDailyUsdc} USDC`,
  );
console.log(
  model
    ? `Record agent: POST /research/chat using ${model}`
    : 'Record agent disabled: RESEARCH_MODEL is unset, so POST /research/chat answers 503.',
);

const host = process.env.RESEARCH_API_HOST ?? '127.0.0.1';
if (!token && host !== '127.0.0.1' && host !== '::1')
  throw new Error(
    `RESEARCH_API_HOST=${host} binds beyond loopback, which requires RESEARCH_API_TOKEN to be set.`,
  );
server.listen(port, host, () =>
  console.log(`Crosswake read-only evidence: http://${host}:${port}`),
);
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
// A deploy sends SIGTERM and systemd escalates to SIGKILL if the process is still up when its stop
// timeout expires. `close()` alone waits for every open socket, and the Funnel keeps keep-alive
// connections to this port, so a restart stalled for a minute and left the API refusing requests.
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
