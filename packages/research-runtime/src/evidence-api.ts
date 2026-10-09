import { liveEvidence } from './live-evidence.js';
import {
  recordFill,
  residualResearch,
  residualSignals,
} from './residual-evidence.js';
import { latestContext } from '../../context/src/index.js';
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  identifier,
  listExperiments,
  listProtocols,
  readExperiment,
  readProtocol,
  type RuntimePaths,
} from './experiments.js';
import { backtestRuns, datasetInventory } from './dataset-evidence.js';
import { hyperliquidEvidence } from './hyperliquid-evidence.js';
import { listSandboxRuns, runSandbox, sandboxSymbols } from './sandbox.js';
import { launchExperiment, listJobs } from './experiment-jobs.js';
import { resolve } from 'node:path';
/** Dataset sweeps touch thousands of small manifests; they change slowly. */
const CACHE_TTL_MS = 30_000;
export function createEvidenceServer(
  paths: RuntimePaths,
  options: { token?: string } = {},
): Server {
  const cache = new Map<string, { at: number; value: unknown }>();
  const cached = async <T>(key: string, load: () => Promise<T>) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(body));
    };
    // Optional bearer token. Unset means "loopback-only trust", which is the default and is
    // correct while only this host can reach the port. Set RESEARCH_API_TOKEN before this
    // server becomes reachable from anywhere else (a tunnel, a proxy, a public IP): the
    // dashboard proxy sends the matching header, so an unauthenticated caller still gets 401.
    if (options.token) {
      const provided = Buffer.from(request.headers.authorization ?? ''),
        expected = Buffer.from(`Bearer ${options.token}`);
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      ) {
        send(401, { error: 'unauthorized' });
        return;
      }
    }
    // Loopback API. Its mutations: a user's own reported fill for a published paper signal,
    // an exploratory sandbox backtest (stored apart from evidence), and starting a frozen
    // protocol's experiment. It never places orders, returns credentials or serves arbitrary files.
    const url = new URL(request.url ?? '/', 'http://localhost'),
      fillRoute = /^\/signals\/[^/]+\/fills$/.test(url.pathname),
      postRoute =
        fillRoute || url.pathname === '/sandbox' || url.pathname === '/jobs';
    if (request.method !== 'GET' && !(request.method === 'POST' && postRoute)) {
      send(405, { error: 'read_only_api' });
      return;
    }
    try {
      if (url.search) {
        send(400, { error: 'query_parameters_not_supported' });
        return;
      }
      const segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
      if (request.method === 'POST') {
        if (
          !/^application\/json\b/.test(request.headers['content-type'] ?? '')
        ) {
          send(415, { error: 'json_required' });
          return;
        }
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 2048) {
            send(413, { error: 'body_too_large' });
            return;
          }
        }
        let input: unknown;
        try {
          input = JSON.parse(body);
        } catch {
          send(400, { error: 'invalid_request' });
          return;
        }
        if (segments[0] === 'sandbox') send(201, await runSandbox(paths.dataDir, input));
        else if (segments[0] === 'jobs')
          try {
            send(202, await launchExperiment(paths, input));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EBUSY')
              send(409, { error: 'experiment_already_running' });
            else throw error;
          }
        else
          try {
            send(201, await recordFill(paths.dataDir, segments[1]!, input));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
              send(409, { error: 'fill_already_recorded' });
            else throw error;
          }
      } else if (segments.length === 1 && segments[0] === 'health') {
        let collector: unknown = null;
        try {
          collector = JSON.parse(
            await readFile(
              join(paths.dataDir, 'collector-health.json'),
              'utf8',
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        send(200, {
          collector,
          researchStatus: 'UNVALIDATED',
          executionEnabled: false,
        });
      } else if (segments.length === 1 && segments[0] === 'protocols')
        send(200, { protocols: await listProtocols(paths) });
      else if (segments.length === 2 && segments[0] === 'protocols')
        send(200, await readProtocol(paths, identifier.parse(segments[1])));
      else if (segments.length === 1 && segments[0] === 'experiments')
        send(200, { experiments: await listExperiments(paths) });
      else if (segments.length === 2 && segments[0] === 'experiments')
        send(200, await readExperiment(paths, identifier.parse(segments[1])));
      else if (segments.length === 1 && segments[0] === 'live')
        send(200, await liveEvidence(paths.dataDir));
      else if (segments.length === 1 && segments[0] === 'signals')
        send(200, await residualSignals(paths.dataDir));
      else if (segments.length === 1 && segments[0] === 'trend')
        send(200, await trendStrategies(paths.dataDir));
      else if (segments.length === 1 && segments[0] === 'research')
        send(200, await residualResearch(paths.dataDir));
      else if (segments.length === 1 && segments[0] === 'context')
        send(200, await latestContext(paths.dataDir));
      else if (segments.length === 1 && segments[0] === 'data')
        send(200, await cached('data', () => datasetInventory(paths.dataDir)));
      else if (segments.length === 1 && segments[0] === 'backtests')
        send(200, await cached('backtests', () => backtestRuns(paths.dataDir)));
      else if (segments.length === 1 && segments[0] === 'hyperliquid')
        send(
          200,
          await cached('hyperliquid', () =>
            hyperliquidEvidence(
              paths.dataDir,
              resolve(process.env.HL_PLAN ?? 'configs/trend-plan-v006.json'),
            ),
          ),
        );
      else if (segments.length === 1 && segments[0] === 'sandbox')
        send(200, {
          ...(await listSandboxRuns(paths.dataDir)),
          symbols: await sandboxSymbols(paths.dataDir),
        });
      else if (segments.length === 2 && segments[0] === 'sandbox')
        send(
          200,
          JSON.parse(
            await readFile(
              join(paths.dataDir, 'sandbox', `${z.string().regex(/^sandbox-[\w-]+$/).parse(segments[1])}.json`),
              'utf8',
            ),
          ),
        );
      else if (segments.length === 1 && segments[0] === 'jobs')
        send(200, await listJobs(paths));
      else send(404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof URIError)
        send(400, { error: 'invalid_request' });
      else if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        send(404, { error: 'not_found_or_incomplete' });
      else send(409, { error: 'evidence_unavailable_or_integrity_failure' });
    }
  });
}

/** Live daily-trend engines, one state file per frozen plan version. */
async function trendStrategies(dataDir: string) {
  const root = join(dataDir, 'trend', 'live'),
    strategies = [];
  for (const id of (await readdir(root).catch(() => [] as string[])).sort())
    try {
      if (identifier.safeParse(id).success)
        strategies.push(
          JSON.parse(await readFile(join(root, id, 'state.json'), 'utf8')),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  return { strategies };
}
