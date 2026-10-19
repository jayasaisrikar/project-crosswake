import { NextResponse } from 'next/server';

const question = /^[\s\S]{3,600}$/;
const answer = { method: 'POST' as const };

function apiBase() {
  const explicit = process.env.RESEARCH_API_BASE;
  if (!explicit) return null;
  try {
    const url = new URL(explicit);
    if (url.protocol === 'http:' || url.protocol === 'https:')
      return url.origin;
  } catch {
    return null;
  }
  return null;
}

const historyEntry = (value: unknown) => {
  if (!value || typeof value !== 'object') return null;
  const { role, content } = value as { role?: unknown; content?: unknown };
  if (role !== 'user' && role !== 'assistant') return null;
  if (typeof content !== 'string' || content.length > 1000) return null;
  return { role, content };
};

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const origin = request.headers.get('origin'),
    host = request.headers.get('host');
  if (!origin || !host || new URL(origin).host !== host)
    return NextResponse.json({ error: 'cross_origin' }, { status: 403 });
  const base = apiBase(),
    token = process.env.RESEARCH_API_TOKEN;
  if (!base || !token)
    return NextResponse.json(
      {
        error: 'ask_not_configured',
        detail:
          'RESEARCH_API_BASE and RESEARCH_API_TOKEN are required on this deployment.',
      },
      { status: 503 },
    );
  let body: { question?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (typeof body.question !== 'string' || !question.test(body.question))
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const history = Array.isArray(body.history)
    ? body.history.map(historyEntry)
    : [];
  if (history.some((entry) => entry === null) || history.length > 6)
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  try {
    const response = await fetch(`${base}/research/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        question: body.question.trim(),
        history: history.filter(Boolean),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(130000),
    });
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'record_unreachable' }, { status: 503 });
  }
}

export function GET() {
  return NextResponse.json(answer, { status: 405 });
}

export const maxDuration = 160;
