import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
import { resolve } from 'node:path';
import { z } from 'zod';
import { createEvidenceServer } from '../../../packages/research-runtime/src/evidence-api.js';
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.RESEARCH_API_PORT ?? 4112);
const token = process.env.RESEARCH_API_TOKEN?.trim();
const server = createEvidenceServer(
  {
    dataDir: resolve(process.env.DATA_DIR ?? './data'),
    protocolDir: resolve('research/frozen'),
  },
  { token },
);
if (!token)
  console.warn(
    'RESEARCH_API_TOKEN is unset: this server is unauthenticated. That is fine on loopback; set it before exposing the port.',
  );
// Binding beyond loopback publishes this API to whatever can reach the port. Without a token
// that is an open door, so refuse to start rather than create one silently.
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
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close());
