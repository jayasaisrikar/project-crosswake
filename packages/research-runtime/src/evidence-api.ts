import { liveEvidence } from './live-evidence.js';
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
    // Loopback API has no mutation endpoints and never returns provider credentials or arbitrary files.
    if (request.method !== 'GET') {
      send(405, { error: 'read_only_api' });
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.search) {
        send(400, { error: 'query_parameters_not_supported' });
        return;
      }
      const segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
      if (segments.length === 1 && segments[0] === 'health') {
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
