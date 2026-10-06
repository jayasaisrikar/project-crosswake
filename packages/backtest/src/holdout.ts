import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hash,
  type FrozenResearch,
  type FrozenVariant,
} from './research-plan.js';
export interface SelectionRecord {
  planHash: string;
  datasetHash: string;
  variantId: string;
  configHash: string;
  validationQualified: boolean;
  walkForwardPassed: boolean;
  selectionHash: string;
}
export function selectionRecord(
  frozen: FrozenResearch,
  datasetHash: string,
  chosen: FrozenVariant,
  validationQualified: boolean,
  walkForwardPassed = false,
): SelectionRecord {
  const body = {
    planHash: frozen.planHash,
    datasetHash,
    variantId: chosen.id,
    configHash: chosen.configHash,
    validationQualified,
    walkForwardPassed,
  };
  return { ...body, selectionHash: hash(body) };
}
export function verifySelection(
  frozen: FrozenResearch,
  record: SelectionRecord,
) {
  const { selectionHash, ...body } = record;
  if (hash(body) !== selectionHash || record.planHash !== frozen.planHash)
    throw new Error('Selection provenance mismatch');
  const chosen = frozen.variants.find(
    (v) => v.id === record.variantId && v.configHash === record.configHash,
  );
  if (!chosen) throw new Error('Selected config is not in the frozen plan');
  return chosen;
}
/** Reservation remains consumed even if evaluation fails, to prevent repeated holdout tuning. */
export async function reserveHoldout(
  root: string,
  frozen: FrozenResearch,
  record: SelectionRecord,
) {
  verifySelection(frozen, record);
  if (!record.validationQualified || !record.walkForwardPassed)
    throw new Error(
      'Validation and walk-forward evidence do not qualify for locked holdout evaluation',
    );
  const locks = join(root, 'research-locks');
  await mkdir(locks, { recursive: true });
  const mutex = join(locks, 'holdout-mutex');
  try {
    await mkdir(mutex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'Holdout reservation is busy; inspect a stale mutex after a crash',
      );
    throw error;
  }
  try {
    const start = Date.parse(frozen.plan.holdout.start),
      end = Date.parse(frozen.plan.holdout.end);
    for (const entry of await readdir(locks, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'holdout-mutex') continue;
      const prior = JSON.parse(
        await readFile(join(locks, entry.name, 'reservation.json'), 'utf8'),
      ) as { source: string; start: number; end: number };
      if (
        prior.source === frozen.plan.source &&
        start < prior.end &&
        end > prior.start
      )
        throw new Error(
          'Holdout already reserved or evaluated for an overlapping window; repeated evaluation is blocked',
        );
    }
    const dir = join(
      locks,
      hash({ source: frozen.plan.source, start, end }) + '.holdout',
    );
    await mkdir(dir);
    await writeFile(
      join(dir, 'reservation.json'),
      JSON.stringify(
        {
          planHash: frozen.planHash,
          selectionHash: record.selectionHash,
          source: frozen.plan.source,
          start,
          end,
          reservedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return dir;
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}
