export type FreshnessLimits = {
  maxRecordAgeMs: number;
  maxCollectorIdleMs: number;
  maxEngineIdleMs: number;
};

export type FreshnessSnapshot = {
  generatedAt?: string | null;
  collector?: {
    connected?: boolean | null;
    lastMessageAt?: string | null;
  } | null;
  engines?: { id: string; lastEventAt?: string | null }[] | null;
};

const age = (iso: string | null | undefined, now: number) => {
  const then = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(then) ? now - then : null;
};

/**
 * What a silently dead record looks like from the outside: a page that renders a date from last
 * week and calls it current. Every stale or disconnected signal is a problem; the caller decides
 * whether a warning is enough, but nothing here is allowed to pass quietly.
 */
export function recordFreshness(
  snapshot: FreshnessSnapshot | null,
  now: number,
  limits: FreshnessLimits,
) {
  const problems: string[] = [];
  if (!snapshot) return { ok: false, problems: ['record_missing'], ages: {} };

  const recordAge = age(snapshot.generatedAt, now);
  if (recordAge === null) problems.push('record_undated');
  else if (recordAge > limits.maxRecordAgeMs) problems.push('record_stale');

  if (snapshot.collector?.connected === false)
    problems.push('collector_disconnected');
  const feedAge = age(snapshot.collector?.lastMessageAt, now);
  if (feedAge === null) problems.push('collector_undated');
  else if (feedAge > limits.maxCollectorIdleMs)
    problems.push('collector_silent');

  for (const engine of snapshot.engines ?? []) {
    const idle = age(engine.lastEventAt, now);
    if (idle === null) problems.push(`engine_undated:${engine.id}`);
    else if (idle > limits.maxEngineIdleMs)
      problems.push(`engine_silent:${engine.id}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    ages: {
      recordMinutes: recordAge === null ? null : Math.round(recordAge / 60_000),
      feedMinutes: feedAge === null ? null : Math.round(feedAge / 60_000),
    },
  };
}
