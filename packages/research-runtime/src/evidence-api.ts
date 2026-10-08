import { liveEvidence } from './live-evidence.js';
import {
  recordFill,
  residualResearch,
  residualSignals,
} from './residual-evidence.js';
import { latestContext } from '../../context/src/index.js';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
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
export function createEvidenceServer(paths: RuntimePaths): Server {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(body));
    };
    // Loopback API. Its only mutation records a user's own reported fill for a published
    // paper signal; it never places orders, returns credentials or serves arbitrary files.
    const url = new URL(request.url ?? '/', 'http://localhost'),
      fillRoute = /^\/signals\/[^/]+\/fills$/.test(url.pathname);
    if (request.method !== 'GET' && !(request.method === 'POST' && fillRoute)) {
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
      else if (segments.length === 1 && segments[0] === 'research')
        send(200, await residualResearch(paths.dataDir));
      else if (segments.length === 1 && segments[0] === 'context')
        send(200, await latestContext(paths.dataDir));
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
