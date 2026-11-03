import { readRecord } from './api';

export const LIVE_REVALIDATE = 300;

export type SnapshotPosition = {
  symbol: string;
  side: string | null;
  since: string | null;
  markBps: number | null;
  targetBps: number | null;
  stopBps: number | null;
  exitBy: string | null;
};

export type SnapshotEngine = {
  id: string;
  version: string;
  kind: string;
  market: string | null;
  instrument: string | null;
  liveSince: string | null;
  regimeOn: boolean | null;
  positions: SnapshotPosition[];
  stats: {
    trades: number | null;
    winRate: number | null;
    netExpectancyBps: number | null;
    profitFactor: number | null;
    medianBps: number | null;
  } | null;
  watch: { symbol: string; toHighBps: number | null }[];
  lastEventAt: string | null;
  telegram: boolean;
  executionEnabled: boolean;
};

export type SnapshotEvent = {
  id: string;
  at: string;
  engine: string;
  kind: 'entry' | 'exit' | 'signal';
  symbol: string;
  market: string | null;
  side: string | null;
  price: number | null;
  netBps: number | null;
  reason: string | null;
};

export type PublicSnapshot = {
  version: number;
  generatedAt: string;
  executionEnabled: false;
  collector: {
    connected: boolean;
    lastMessageAt: string | null;
    symbols: string[];
  };
  engines: SnapshotEngine[];
  events: SnapshotEvent[];
  digestLastPostAt: string | null;
};

function isSnapshot(value: unknown): value is PublicSnapshot {
  const v = value as PublicSnapshot | null;
  return (
    !!v &&
    typeof v.version === 'number' &&
    Array.isArray(v.engines) &&
    Array.isArray(v.events) &&
    typeof v.collector === 'object'
  );
}

/** The engines' live state, cached for a few minutes. Null when the record is unreachable. */
export async function readSnapshot(): Promise<PublicSnapshot | null> {
  return readRecord<PublicSnapshot>(
    '/research/record.json',
    '/public',
    LIVE_REVALIDATE,
    isSnapshot,
  );
}

export const pct = (bps: number | null, digits = 1) =>
  bps === null ? null : `${(bps / 100).toFixed(digits)}%`;

export function relativeAge(iso: string | null, now: number) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
