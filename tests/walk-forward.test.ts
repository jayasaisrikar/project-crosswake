import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  freezeResearch,
  verifyFrozen,
  planSchema,
} from '../packages/backtest/src/research-plan.js';
import {
  walkForward,
  evaluateWindow,
  selectVariant,
} from '../packages/backtest/src/walk-forward.js';
import {
  selectionRecord,
  verifySelection,
  reserveHoldout,
} from '../packages/backtest/src/holdout.js';
import { evidenceGate } from '../packages/backtest/src/evidence.js';
import { riskReport } from '../packages/backtest/src/reports.js';
import { SignalEngine } from '../packages/signals/src/index.js';
import type { PaperTrade } from '../packages/backtest/src/index.js';
import {
  frames,
  start,
  config,
  plan,
  frozen,
  loader,
  snapshot,
} from './fixtures/research.js';
describe('frozen chronological research', () => {
  it('detects mutated plans/configs, typos and overlapping unseen blocks', () => {
    expect(verifyFrozen(JSON.parse(JSON.stringify(frozen)))).toEqual(frozen);
    const changed = structuredClone(frozen);
    changed.variants[0]!.config.minConfidence = 99;
    expect(() => verifyFrozen(changed)).toThrow('provenance');
    expect(() =>
      freezeResearch(
        {
          ...plan,
          variants: [{ id: 'typo', overrides: { confidenceTheshold: 99 } }],
        },
        config,
      ),
    ).toThrow();
    expect(() =>
      planSchema.parse({
        ...plan,
        folds: [...plan.folds, { ...plan.folds[0], id: 'overlap' }],
      }),
    ).toThrow('overlap');
  });
  it('freezes estimates before an unseen regime change', () => {
    const engine = new SignalEngine(config);
    const data = frames(180);
    for (const rows of data) engine.update(rows);
    const fits = engine.freezeRelationships();
    expect(Object.keys(fits)).toEqual(['ETHUSDT']);
    for (let i = 180; i < 210; i++)
      engine.update([
        snapshot('BTCUSDT', start + i * 1000, 100 + i),
        snapshot('ETHUSDT', start + i * 1000, 500 - i),
      ]);
    expect(engine.relationships).toEqual(fits);
    expect(engine.diagnostics.frozen).toBe(true);
  });
  it('selects using validation only and never loads holdout prices', async () => {
    const data = frames();
    const requested: { startTs: number; endTs: number }[] = [];
    const input = async function* (range: { startTs: number; endTs: number }) {
      requested.push(range);
      yield* loader(data)(range);
    };
    const a = await walkForward(input, frozen);
    expect(a.folds[0]?.selection.chosen.id).toBe('baseline');
    expect(a.folds[0]?.validations[0]?.result.trades.length).toBeGreaterThan(0);
    expect(
      requested.every((r) => r.endTs <= Date.parse(plan.holdout.start)),
    ).toBe(true);
    const changed = data.map((rows) =>
      rows[0]!.ts < start + 300000
        ? rows
        : rows.map((r) => ({
            ...r,
            close: r.close! * 10,
            bestBid: r.bestBid! * 10,
            bestAsk: r.bestAsk! * 10,
          })),
    );
    const b = await walkForward(loader(changed), frozen);
    expect(b.folds[0]?.selection).toEqual(a.folds[0]?.selection);
    expect(
      Object.values(a.folds[0]!.test.trainingRelationships).every(
        (f) => f.asOf < start + 300000,
      ),
    ).toBe(true);
  });
  it('purges decisions whose full modeled lifetime crosses a block boundary', async () => {
    const result = await evaluateWindow(
      loader(frames()),
      config,
      start,
      start + 180000,
      start + 290000,
    );
    expect(result.boundaryPurged).toBeGreaterThan(0);
    expect(
      result.trades.every(
        (t) => t.entryTs >= start + 180000 && t.exitTs < start + 290000,
      ),
    ).toBe(true);
  });
  it('returns a declared baseline when validation sample is inadequate', async () => {
    const result = await evaluateWindow(
      loader(frames()),
      config,
      start,
      start + 180000,
      start + 300000,
    );
    const selection = selectVariant(
      frozen.variants,
      [{ variantId: 'baseline', result }],
      10000,
    );
    expect(selection).toMatchObject({
      qualified: false,
      chosen: { id: 'baseline' },
    });
  });
  it('reserves holdout once and blocks new plans that reuse its dates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crosswake-holdout-'));
    try {
      const unqualified = selectionRecord(
        frozen,
        'data',
        frozen.variants[0]!,
        true,
        false,
      );
      await expect(reserveHoldout(dir, frozen, unqualified)).rejects.toThrow(
        'do not qualify',
      );
      const selected = selectionRecord(
        frozen,
        'data',
        frozen.variants[0]!,
        true,
        true,
      );
      expect(verifySelection(frozen, selected).id).toBe('baseline');
      await reserveHoldout(dir, frozen, selected);
      await expect(reserveHoldout(dir, frozen, selected)).rejects.toThrow(
        'already reserved',
      );
      const revised = freezeResearch({ ...plan, id: 'renamed-plan' }, config);
      const revisedSelection = selectionRecord(
        revised,
        'data',
        revised.variants[0]!,
        true,
        true,
      );
      await expect(
        reserveHoldout(dir, revised, revisedSelection),
      ).rejects.toThrow('overlapping');
      expect(() =>
        verifySelection(frozen, { ...selected, variantId: 'strict' }),
      ).toThrow('provenance');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('requires adequate confidence, distribution and sample size for an evidence pass', () => {
    const make = (i: number): PaperTrade => ({
      signalId: `s${i}`,
      btcImpulseId: `e${i}`,
      symbol: i % 2 ? 'ETHUSDT' : 'SOLUSDT',
      entryTs: start + i * 1000,
      entryPrice: 100,
      exitTs: start + i * 1000 + 500,
      exitPrice: 100,
      grossReturnBps: i % 10 < 7 ? 12 : -8,
      netReturnBps: i % 10 < 7 ? 10 : -10,
      feeBps: 1,
      slippageBps: 1,
      maeBps: -10,
      mfeBps: 10,
      exitReason: 'time',
    });
    const trades = Array.from({ length: 1000 }, (_, i) => make(i));
    expect(evidenceGate(trades, plan.acceptance).passed).toBe(true);
    expect(evidenceGate(trades.slice(0, 20), plan.acceptance).passed).toBe(
      false,
    );
    expect(
      evidenceGate(
        trades.map((t) => ({ ...t, symbol: 'ETHUSDT' })),
        plan.acceptance,
      ).reasons,
    ).toContain('asset_concentration');
    expect(evidenceGate(trades, plan.acceptance, 1).reasons).toContain(
      'unfinished_positions',
    );
  });
  it('reports loss streaks and equal-notional drawdown without implying portfolio capital', () => {
    const trades = [10, -20, -10, 40].map(
      (value, i) =>
        ({
          signalId: `s${i}`,
          btcImpulseId: `e${i}`,
          symbol: i % 2 ? 'ETHUSDT' : 'SOLUSDT',
          exitTs: start + i * 1000,
          netReturnBps: value,
        }) as PaperTrade,
    );
    expect(riskReport(trades)).toMatchObject({
      equalNotionalCumulativeBps: 20,
      equalNotionalMaxDrawdownBps: 30,
      maxLosingStreak: 2,
    });
  });
});
