import { describe, expect, it } from 'vitest';
import { plan } from '../apps/retention/src/policy.js';

const H = 3_600_000, now = 100 * 24 * H,
  policy = { closedAfterMs: 2 * H, keepMs: 7 * 24 * H, minFreeBytes: 100 },
  f = (name: string, ageH: number, bytes = 10) => ({ name, bytes, mtimeMs: now - ageH * H });

describe('raw journal retention', () => {
  it('compresses only closed, unprotected journals', () => {
    const r = plan([f('live.jsonl', 0.1), f('old.jsonl', 5), f('chain.jsonl', 50)], policy, 1e6, new Set(['chain.jsonl']), now);
    expect(r.compress.map((x) => x.name)).toEqual(['old.jsonl']);
  });
  it('expires compressed journals after the keep window', () => {
    const r = plan([f('a.jsonl.zst', 24 * 8), f('b.jsonl.zst', 24)], policy, 1e6, new Set(), now);
    expect(r.remove.map((x) => x.name)).toEqual(['a.jsonl.zst']);
  });
  it('deletes the oldest archives early when disk is low, never plain journals', () => {
    const r = plan([f('new.jsonl.zst', 2, 50), f('old.jsonl.zst', 30, 50), f('x.jsonl', 0.1, 999)], policy, 10, new Set(), now);
    expect(r.remove.map((x) => x.name)).toEqual(['old.jsonl.zst', 'new.jsonl.zst']);
  });
});
