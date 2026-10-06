import { describe, it, expect } from 'vitest';
import {
  ShadowRuntime,
  type ShadowEvent,
} from '../packages/backtest/src/shadow.js';
import { frames, config } from './fixtures/research.js';
describe('live paper parity', () => {
  it('reproduces live candidates/fills using recorded delivery clocks', async () => {
    const live: ShadowEvent[] = [],
      replayed: ShadowEvent[] = [];
    let clock = 0;
    const a = new ShadowRuntime(
      config,
      async (events) => {
        live.push(...events);
      },
      () => clock,
    );
    for (const rows of frames(280)) {
      clock = rows[0]!.ts + 25;
      await a.step(rows);
    }
    const times = live
      .filter((e) => e.kind === 'step')
      .map((e) => Number(e.decisionAt));
    const b = new ShadowRuntime(
      config,
      async (events) => {
        replayed.push(...events);
      },
      () => clock,
    );
    let index = 0;
    for (const rows of frames(280)) {
      clock = times[index++]!;
      await b.step(rows);
    }
    expect(replayed).toEqual(live);
    expect(live.some((e) => e.kind === 'candidate')).toBe(true);
    expect(live.some((e) => e.kind === 'entry')).toBe(true);
    expect(live.some((e) => e.kind === 'trade')).toBe(true);
    expect(a.paper.trades).toHaveLength(0);
    expect(a.diagnostics.closedTrades).toBeGreaterThan(0);
  });
  it('counts real compute delay in decision time and never fabricates closure on shutdown', async () => {
    let clock = 0;
    const events: ShadowEvent[] = [],
      runtime = new ShadowRuntime(
        config,
        async (e) => {
          events.push(...e);
        },
        () => clock,
      );
    for (const rows of frames(184)) {
      clock = rows[0]!.ts + 50;
      await runtime.step(rows);
    }
    const signalEvent = events.find((e) => e.kind === 'candidate');
    expect(signalEvent).toBeDefined();
    const signal = signalEvent!.candidate as { decisionTs: number; ts: number };
    expect(signal.decisionTs).toBeGreaterThanOrEqual(
      signal.ts + config.decisionLatencyMs,
    );
    await runtime.close();
    expect(events.at(-1)).toMatchObject({
      kind: 'session_end',
      researchOnly: true,
    });
  });
  it('rejects a processing clock before source availability', async () => {
    const runtime = new ShadowRuntime(
      config,
      async () => {},
      () => 1,
    );
    await expect(runtime.step(frames(1)[0]!)).rejects.toThrow(
      'precedes availability',
    );
  });
});
