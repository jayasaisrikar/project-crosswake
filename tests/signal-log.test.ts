import { describe, expect, it } from 'vitest';
import {
  GENESIS,
  canonical,
  nextEntry,
  parseLog,
  verify,
  type SignalLogEntry,
} from '../packages/signal-log/src/index.js';

const base = {
  version: 'trend-daily-v005',
  kind: 'entry' as const,
  symbol: 'SOLUSDT',
  decidedAt: 1_759_968_000_000,
  fillAt: 1_760_054_400_000,
  price: 182.4,
  publishedAt: 1_760_054_700_000,
};

async function build(n: number) {
  const log: SignalLogEntry[] = [];
  for (let i = 0; i < n; i++)
    log.push(await nextEntry(log, { ...base, id: `SOL-${i}` }));
  return log;
}

describe('signal log', () => {
  it('chains from genesis and verifies', async () => {
    const log = await build(3);
    expect(log[0]!.prevHash).toBe(GENESIS);
    expect(log[1]!.prevHash).toBe(log[0]!.hash);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await verify(log)).toEqual({ ok: true, count: 3, head: log[2]!.hash });
  });

  it('detects an edited entry', async () => {
    const log = await build(3);
    log[1] = { ...log[1]!, price: 190 };
    expect(await verify(log)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects a deleted entry', async () => {
    const log = await build(3);
    log.splice(1, 1);
    expect(await verify(log)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('detects a rewritten tail even when its hash is recomputed', async () => {
    const log = await build(3);
    const forged = await nextEntry(log.slice(0, 1), { ...base, id: 'SOL-1', price: 1 });
    log[1] = forged;
    expect(await verify(log)).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('omits absent optional fields from the canonical form', async () => {
    const [e] = await build(1);
    expect(canonical(e!)).not.toContain('netBps');
    expect(parseLog(JSON.stringify(e) + '\n\n')).toEqual([e]);
  });

  it('pins the hash of a known entry', async () => {
    const [e] = await build(1);
    expect(e!.hash).toMatch(/^[0-9a-f]{64}$/);
    // Changing the canonical form would orphan every published fingerprint.
    expect(e!.hash).toBe(
      '689116c2e758893fe770be174c704a65c1669c52e3a4fd72786ebe7e9261ec49',
    );
  });
});
