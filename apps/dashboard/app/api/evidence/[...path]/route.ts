import { NextResponse } from 'next/server';
const allowed = new Set([
  'health',
  'live',
  'context',
  'experiments',
  'protocols',
  'signals',
  'research',
]);
const segment = /^[A-Za-z0-9_-]+$/;
function apiBase() {
  const port = process.env.RESEARCH_API_PORT ?? '4112';
  return /^\d{4,5}$/.test(port) ? `http://127.0.0.1:${port}` : null;
}
async function forward(url: string, init: RequestInit = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'evidence_api_offline' },
      { status: 503 },
    );
  }
}
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (
    !path[0] ||
    !allowed.has(path[0]) ||
    path.length > 2 ||
    path.some((p) => !segment.test(p))
  )
    return NextResponse.json(
      { error: 'invalid_evidence_route' },
      { status: 400 },
    );
  const base = apiBase();
  if (!base)
    return NextResponse.json({ error: 'invalid_api_port' }, { status: 503 });
  return forward(`${base}/${path.join('/')}`);
}
/** Only a user's own fill report for a published signal may be written, from this origin. */
export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (
    path.length !== 3 ||
    path[0] !== 'signals' ||
    path[2] !== 'fills' ||
    !segment.test(path[1] ?? '')
  )
    return NextResponse.json(
      { error: 'invalid_evidence_route' },
      { status: 400 },
    );
  const origin = request.headers.get('origin'),
    host = request.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host)
    return NextResponse.json({ error: 'cross_origin' }, { status: 403 });
  const base = apiBase();
  if (!base)
    return NextResponse.json({ error: 'invalid_api_port' }, { status: 503 });
  const body = await request.text();
  if (body.length > 2048)
    return NextResponse.json({ error: 'body_too_large' }, { status: 413 });
  return forward(`${base}/${path.join('/')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}
