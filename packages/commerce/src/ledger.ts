// jay logs: ts long, me visit again

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { formatUsdc, parseUsdc } from './money.js';
import {
  deliveryStateSchema,
  paymentStateSchema,
  purchaseRecordSchema,
  purchasedDataRecordSchema,
  settlementEvidenceSchema,
  validationStateSchema,
  type PurchaseIntent,
  type PurchaseRecord,
  type PurchasedDataRecord,
} from './types.js';

export const GENESIS = '0'.repeat(64);

const detailSchema = z.record(z.string(), z.unknown());

export const ledgerEventSchema = z
  .object({
    seq: z.number().int().positive(),
    at: z.number().int().positive(),
    kind: z.enum(['payment', 'reservation', 'approval', 'control']),
    purchaseId: z.string().max(120),
    researchRunId: z.string().max(120),
    mode: z.enum(['mock', 'testnet', 'mainnet']),
    paymentState: paymentStateSchema,
    deliveryState: deliveryStateSchema,
    validationState: validationStateSchema,
    amountUsdc: z.string(),
    detail: detailSchema,
    prevHash: z.string().length(64),
    hash: z.string().length(64),
  })
  .strict();
export type LedgerEvent = z.infer<typeof ledgerEventSchema>;

export type LedgerEventInput = Omit<LedgerEvent, 'seq' | 'prevHash' | 'hash'>;

const ORDER = [
  'seq',
  'at',
  'kind',
  'purchaseId',
  'researchRunId',
  'mode',
  'paymentState',
  'deliveryState',
  'validationState',
  'amountUsdc',
  'detail',
  'prevHash',
] as const;

export function canonical(event: Omit<LedgerEvent, 'hash'>): string {
  const out: Record<string, unknown> = {};
  for (const key of ORDER) out[key] = event[key];
  return JSON.stringify(out);
}

export function hashEvent(event: Omit<LedgerEvent, 'hash'>): string {
  return createHash('sha256').update(canonical(event)).digest('hex');
}

export function verifyLedger(events: LedgerEvent[]) {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const fail = (problem: string) => ({
      ok: false as const,
      count: events.length,
      brokenAt: event.seq,
      problem,
    });
    if (event.seq !== i + 1)
      return fail(`expected seq ${i + 1}, found ${event.seq}`);
    if (event.prevHash !== prev)
      return fail('prevHash does not match the previous event');
    const { hash, ...fields } = event;
    if (hashEvent(fields) !== hash)
      return fail('event contents do not match its hash');
    prev = hash;
  }
  return { ok: true as const, count: events.length, head: prev };
}

export interface BudgetSnapshot {
  at: number;
  dayKey: string;
  daySpentUsdc: bigint;
  dayHeldUsdc: bigint;
  dayCommittedUsdc: bigint;
  totalSettledUsdc: bigint;
}

const TERMINAL_RELEASE = new Set([
  'FAILED',
  'DECLINED',
  'EXPIRED',
  'SETTLEMENT_UNKNOWN',
]);

/**
 * Append-only, hash-chained commerce ledger on the local filesystem.
 *
 * Crosswake persists research state as JSONL ledgers and atomic JSON snapshots
 * (no SQL database is present), so commerce follows the same convention rather
 * than introducing a second persistence stack. Every mutation is an appended,
 * hash-chained event; materialised JSON files are derived views only.
 */
export class CommerceLedger {
  private readonly lockPath: string;

  constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.lockPath = join(root, '.lock');
  }

  private file(name: string) {
    return join(this.root, name);
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    for (const dir of ['intents', 'purchases', 'purchased', 'runs', 'evidence'])
      await mkdir(join(this.root, dir), { recursive: true });
  }

  /** Exclusive critical section. Bounded wait; never silently proceeds unlocked. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
      try {
        await mkdir(this.lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired)
      throw new Error(
        'Commerce ledger lock is held; inspect the owning process',
      );
    try {
      return await fn();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async readLedgerFile(name: string): Promise<LedgerEvent[]> {
    let text: string;
    try {
      text = await readFile(this.file(name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split('\n'),
      events: LedgerEvent[] = [];
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        events.push(ledgerEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        // A final line without its newline is an append still in flight.
        if (index !== lines.length - 1)
          throw new Error(`Commerce ledger integrity failure in ${name}`, {
            cause: error,
          });
      }
    });
    return events;
  }

  async events(): Promise<LedgerEvent[]> {
    return this.readLedgerFile('events.jsonl');
  }

  /** Must be called inside `withLock` when the decision depends on it. */
  async appendUnlocked(input: LedgerEventInput): Promise<LedgerEvent> {
    const events = await this.events(),
      previous = events.at(-1),
      fields = ledgerEventSchema.omit({ hash: true }).parse({
        ...input,
        seq: (previous?.seq ?? 0) + 1,
        prevHash: previous?.hash ?? GENESIS,
      }) as Omit<LedgerEvent, 'hash'>;
    const event: LedgerEvent = { ...fields, hash: hashEvent(fields) };
    await mkdir(this.root, { recursive: true });
    const handle = await readFile(this.file('events.jsonl'), 'utf8').catch(
      () => '',
    );
    await writeFile(
      this.file('events.jsonl'),
      handle + JSON.stringify(event) + '\n',
    );
    return event;
  }

  async append(input: LedgerEventInput): Promise<LedgerEvent> {
    return this.withLock(() => this.appendUnlocked(input));
  }

  private static reducePurchase(
    purchaseId: string,
    events: LedgerEvent[],
  ): PurchaseRecord | null {
    const rows = events.filter((e) => e.purchaseId === purchaseId),
      first = rows[0],
      last = rows.at(-1),
      // Approval events carry no money and no run id, so they must never
      // overwrite the figures recorded by the payment path.
      money = rows.filter((e) => e.kind !== 'approval');
    if (!first || !last) return null;
    const settled = rows.find((e) => e.detail.settlement !== undefined),
      failure = rows
        .slice()
        .reverse()
        .find((e) => typeof e.detail.failureReason === 'string'),
      unknown = rows
        .slice()
        .reverse()
        .find((e) => typeof e.detail.settlementUnknownReason === 'string');
    const settlement = settlementEvidenceSchema.safeParse(
      settled?.detail.settlement,
    );
    return purchaseRecordSchema.parse({
      purchaseId,
      researchRunId: money.at(-1)?.researchRunId ?? last.researchRunId,
      idempotencyKey: String(
        money.find((e) => typeof e.detail.idempotencyKey === 'string')?.detail
          .idempotencyKey ?? '',
      ),
      mode: last.mode,
      providerId: String(
        money.find((e) => typeof e.detail.providerId === 'string')?.detail
          .providerId ?? '',
      ),
      serviceId: String(
        money.find((e) => typeof e.detail.serviceId === 'string')?.detail
          .serviceId ?? '',
      ),
      dataType: String(
        money.find((e) => typeof e.detail.dataType === 'string')?.detail
          .dataType ?? 'order_book_depth',
      ),
      amountUsdc: money.at(-1)?.amountUsdc ?? first.amountUsdc,
      paymentState: last.paymentState,
      deliveryState: last.deliveryState,
      validationState: last.validationState,
      settlement: settlement.success ? settlement.data : null,
      settlementUnknownReason:
        typeof unknown?.detail.settlementUnknownReason === 'string'
          ? unknown.detail.settlementUnknownReason
          : null,
      failureReason:
        typeof failure?.detail.failureReason === 'string'
          ? failure.detail.failureReason
          : null,
      createdAt: first.at,
      updatedAt: last.at,
    });
  }

  async purchases(): Promise<PurchaseRecord[]> {
    const events = await this.events(),
      ids = [...new Set(events.map((e) => e.purchaseId))].filter(Boolean),
      records = ids
        .map((id) => CommerceLedger.reducePurchase(id, events))
        .filter((r): r is PurchaseRecord => r !== null);
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  async purchase(purchaseId: string): Promise<PurchaseRecord | null> {
    return CommerceLedger.reducePurchase(purchaseId, await this.events());
  }

  private static dayKey(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
  }

  /**
   * Money committed in the current UTC day: settled charges plus in-flight
   * holds. An unknown settlement keeps its hold so it cannot be spent twice.
   */
  async budgetSnapshot(
    at = this.clock(),
    excludePurchaseId?: string,
  ): Promise<BudgetSnapshot> {
    const events = await this.events(),
      dayKey = CommerceLedger.dayKey(at),
      sameDay = events.filter(
        (e) =>
          CommerceLedger.dayKey(e.at) === dayKey &&
          e.purchaseId !== excludePurchaseId,
      ),
      reserves = new Map<string, bigint>(),
      settled = new Map<string, bigint>();
    for (const event of sameDay) {
      const amount = parseUsdc(event.amountUsdc);
      if (event.kind !== 'reservation') continue;
      if (event.detail.action === 'reserve')
        reserves.set(
          event.purchaseId,
          (reserves.get(event.purchaseId) ?? 0n) + amount,
        );
      else if (
        event.detail.action === 'release' ||
        event.detail.action === 'consume'
      )
        reserves.set(event.purchaseId, 0n);
      if (event.paymentState === 'SETTLED')
        settled.set(event.purchaseId, amount);
    }
    const daySpentUsdc = [...settled.values()].reduce((a, b) => a + b, 0n),
      dayHeldUsdc = [...reserves.values()].reduce((a, b) => a + b, 0n),
      totalSettledUsdc = (await this.purchases()).reduce(
        (sum, p) =>
          p.paymentState === 'SETTLED' && p.purchaseId !== excludePurchaseId
            ? sum + parseUsdc(p.amountUsdc)
            : sum,
        0n,
      );
    return {
      at,
      dayKey,
      daySpentUsdc,
      dayHeldUsdc,
      dayCommittedUsdc: daySpentUsdc + dayHeldUsdc,
      totalSettledUsdc,
    };
  }

  async runCommittedUsdc(
    researchRunId: string,
    excludePurchaseId?: string,
  ): Promise<bigint> {
    const snapshot = await this.purchases();
    return snapshot
      .filter(
        (p) =>
          p.researchRunId === researchRunId &&
          p.purchaseId !== excludePurchaseId &&
          p.paymentState !== 'FAILED' &&
          p.paymentState !== 'DECLINED' &&
          p.paymentState !== 'EXPIRED',
      )
      .reduce((sum, p) => sum + parseUsdc(p.amountUsdc), 0n);
  }

  /**
   * A key is only "used" while a charge for it is live. A failed, declined or
   * expired attempt releases its key so the research can be resumed with a
   * fresh quote, while any in-flight or settled charge blocks a duplicate.
   */
  async hasIdempotencyKey(
    key: string,
    excludePurchaseId?: string,
  ): Promise<boolean> {
    const live: PurchaseRecord['paymentState'][] = [
      'CREATED',
      'QUOTED',
      'AWAITING_APPROVAL',
      'AUTHORIZED',
      'PAYMENT_PENDING',
      'SETTLED',
      'SETTLEMENT_UNKNOWN',
    ];
    return (await this.purchases()).some(
      (p) =>
        p.idempotencyKey === key &&
        p.purchaseId !== excludePurchaseId &&
        live.includes(p.paymentState),
    );
  }

  /** Prevents paying twice for equivalent data in one run. */
  async hasDeliveredEquivalent(
    researchRunId: string,
    providerId: string,
    serviceId: string,
    dataType: string,
    excludePurchaseId?: string,
  ): Promise<boolean> {
    return (await this.purchases()).some(
      (p) =>
        p.researchRunId === researchRunId &&
        p.purchaseId !== excludePurchaseId &&
        p.providerId === providerId &&
        p.serviceId === serviceId &&
        p.dataType === dataType &&
        (p.paymentState === 'SETTLED' ||
          p.paymentState === 'PAYMENT_PENDING' ||
          p.paymentState === 'SETTLEMENT_UNKNOWN'),
    );
  }

  async intent(purchaseId: string): Promise<unknown | null> {
    try {
      return JSON.parse(
        await readFile(this.file(`intents/${purchaseId}.json`), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeIntent(intent: PurchaseIntent) {
    await mkdir(join(this.root, 'intents'), { recursive: true });
    const temp = join(this.root, 'intents', `.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(intent, null, 2));
    await rename(temp, this.file(`intents/${intent.purchaseId}.json`));
  }

  private async writeJson(dir: string, name: string, value: unknown) {
    await mkdir(join(this.root, dir), { recursive: true });
    const temp = join(this.root, dir, `.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(value, null, 2));
    await rename(temp, this.file(`${dir}/${name}`));
  }

  async writePurchase(record: PurchaseRecord) {
    await this.writeJson('purchases', `${record.purchaseId}.json`, record);
  }

  async writePurchased(record: PurchasedDataRecord) {
    await this.writeJson('purchased', `${record.purchaseId}.json`, record);
  }

  async purchased(purchaseId: string): Promise<PurchasedDataRecord | null> {
    try {
      return purchasedDataRecordSchema.parse(
        JSON.parse(
          await readFile(this.file(`purchased/${purchaseId}.json`), 'utf8'),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeRun(runId: string, report: unknown) {
    await this.writeJson('runs', `${runId}.json`, report);
  }

  async run(runId: string) {
    try {
      return JSON.parse(
        await readFile(this.file(`runs/${runId}.json`), 'utf8'),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listRuns(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, 'runs')))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeEvidence(runId: string, value: unknown) {
    await this.writeJson('evidence', `${runId}.json`, value);
  }

  async evidence(runId: string) {
    try {
      return JSON.parse(
        await readFile(this.file(`evidence/${runId}.json`), 'utf8'),
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async approval(purchaseId: string) {
    const events = await this.events();
    const row = events
      .filter((e) => e.kind === 'approval' && e.purchaseId === purchaseId)
      .at(-1);
    return row
      ? {
          decision: String(row.detail.decision),
          actor: String(row.detail.actor),
          at: row.at,
        }
      : null;
  }

  /** Runtime emergency stop; independent of the committed policy file. */
  async control(): Promise<{ disabled: boolean; reason: string | null }> {
    try {
      const value = JSON.parse(
        await readFile(this.file('CONTROL.json'), 'utf8'),
      ) as { disabled?: boolean; reason?: string };
      return {
        disabled: value.disabled === true,
        reason: value.reason ?? null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { disabled: false, reason: null };
      throw error;
    }
  }

  async setControl(disabled: boolean, reason: string | null) {
    await this.writeJson('.', 'CONTROL.json', {
      disabled,
      reason,
      at: this.clock(),
    });
  }
}
