import { describe, expect, it } from 'vitest';
import { recordFreshness } from '../packages/research-runtime/src/freshness.js';

const MIN = 60_000;
const now = Date.parse('2026-11-03T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();
const limits = {
  maxRecordAgeMs: 120 * MIN,
  maxCollectorIdleMs: 30 * MIN,
  maxEngineIdleMs: 26 * 60 * MIN,
};

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: ago(5),
  collector: { connected: true, lastMessageAt: ago(1) },
  engines: [
    { id: 'trend-daily-v005', lastEventAt: ago(60) },
    { id: 'momentum-perp-v008', lastEventAt: ago(240) },
  ],
  ...overrides,
});

describe('recordFreshness', () => {
  it('passes a record that was read recently, on a live feed, with live engines', () => {
    const result = recordFreshness(snapshot(), now, limits);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ages.recordMinutes).toBe(5);
  });

  it('fails a record nobody has refreshed', () => {
    const result = recordFreshness(
      snapshot({ generatedAt: ago(500) }),
      now,
      limits,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('record_stale');
  });

  it('fails a disconnected collector even when the record was just written', () => {
    const result = recordFreshness(
      snapshot({ collector: { connected: false, lastMessageAt: ago(90) } }),
      now,
      limits,
    );
    expect(result.problems).toEqual(
      expect.arrayContaining(['collector_disconnected', 'collector_silent']),
    );
  });

  it('names the engine that has gone quiet instead of showing it flat', () => {
    const result = recordFreshness(
      snapshot({
        engines: [
          { id: 'trend-daily-v005', lastEventAt: ago(60) },
          { id: 'residual-spot-v003', lastEventAt: ago(3 * 24 * 60) },
        ],
      }),
      now,
      limits,
    );
    expect(result.problems).toEqual(['engine_silent:residual-spot-v003']);
  });

  it('treats a missing or undated record as a failure, never as fresh', () => {
    expect(recordFreshness(null, now, limits).problems).toEqual([
      'record_missing',
    ]);
    expect(
      recordFreshness({ generatedAt: null }, now, limits).problems,
    ).toContain('record_undated');
  });
});
