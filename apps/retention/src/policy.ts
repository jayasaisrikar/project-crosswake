export interface JournalFile {
  name: string;
  bytes: number;
  mtimeMs: number;
}
export interface RetentionPolicy {
  closedAfterMs: number;
  keepMs: number;
  minFreeBytes: number;
}
export function plan(
  files: JournalFile[],
  policy: RetentionPolicy,
  freeBytes: number,
  protectedNames: Set<string>,
  now = Date.now(),
) {
  const compress = files.filter(
    (f) =>
      f.name.endsWith('.jsonl') &&
      !protectedNames.has(f.name) &&
      now - f.mtimeMs > policy.closedAfterMs,
  );
  const archives = files
    .filter((f) => f.name.endsWith('.jsonl.zst'))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const remove = archives.filter((f) => now - f.mtimeMs > policy.keepMs);
  let free = freeBytes + remove.reduce((a, f) => a + f.bytes, 0);
  for (const f of archives) {
    if (free >= policy.minFreeBytes) break;
    if (remove.includes(f)) continue;
    remove.push(f);
    free += f.bytes;
  }
  return { compress, remove };
}
