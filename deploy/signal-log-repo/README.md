# Crosswake signal log

Every signal Crosswake sends to its Telegram channel, in an append-only, hash-chained log.
One file per strategy: `trend-daily-v005.jsonl`, `trend-daily-v006.jsonl`.

- Each line is one signal. `hash` is the SHA-256 of the entry's fields (fixed key order,
  absent fields omitted), and every entry's `prevHash` is the hash of the entry before it.
  Editing, reordering or deleting any past line breaks every hash after it.
- Each Telegram post ends with `log #<first 12 hex of hash> · seq <n>`, so a post and its
  log line can be matched.
- This repository is written to by the signal bot only, one commit per new signal. The
  commit history is an independent timestamp for every entry.
- `backfill: true` marks signals sent before logging began (9 October 2026); they were
  appended once, in order, when it started.

Verify a file yourself (Node 20+, no dependencies):

    node verify.mjs trend-daily-v005.jsonl

Paper signals only. Not financial advice.
