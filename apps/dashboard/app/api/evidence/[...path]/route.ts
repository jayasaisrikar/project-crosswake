import { NextResponse } from 'next/server';
const allowed = new Set([
  'health',
  'live',
  'context',
  'experiments',
  'protocols',
]);
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (
    !path[0] ||
    !allowed.has(path[0]) ||
    path.length > 2 ||
    path.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))
  )
    return NextResponse.json(
      { error: 'invalid_evidence_route' },
      { status: 400 },
    );
  const port = process.env.RESEARCH_API_PORT ?? '4112';
  if (!/^\d{4,5}$/.test(port))
    return NextResponse.json({ error: 'invalid_api_port' }, { status: 503 });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${path.join('/')}`, {
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
