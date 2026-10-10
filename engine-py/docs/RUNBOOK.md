# RUNBOOK — unattended PAPER trading (v001 / v002 / ...)

Paper only: no real orders exist anywhere in this code. Everything below is local: logs, alerts and
health state are files on the machine. The only optional outbound message is Telegram, and only when
`--send` is passed **and** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are already set.

Exit codes of `engine live step`: `0` ok, `1` halted (book held, see reasons), `2` failed / aborted,
`3` another step holds the ledger lock. `engine health` exits `1` on any FAIL.

---

## 1. Deploy from a pinned release (never from the research working tree)

The research tree is edited by humans and AI sessions; a half-saved file once killed a step (O6).
Production runs from a separate checkout pinned to a tag, with the locked environment.

```powershell
# one time, Windows (outside OneDrive is better: C:\crypto-prod)
cd C:\Users\kilar\OneDrive\Documents\crypto
git tag -a release-2026-10-10 -m "ops hardening"          # tag what you reviewed
git worktree add C:\crypto-prod release-2026-10-10
cd C:\crypto-prod
uv sync --frozen                                           # exactly uv.lock
```

```bash
# Linux VM (Oracle, non-US region)
git clone <repo> ~/crypto && cd ~/crypto && git checkout release-2026-10-10
bash deploy/oracle_setup.sh                                # uv sync --frozen, cron, logrotate
```

Rules:
- Scheduled jobs always call `uv run --frozen --no-sync ...` (`deploy/*.ps1`, the cron lines) so a
  changed `pyproject.toml` can never alter production dependencies.
- Every `signals.jsonl` row carries `code_rev` (`git rev-parse --short HEAD`, or `ENGINE_RELEASE` if
  set) and `live_hash` (fingerprint of the trading-relevant part of `config/live.yaml`).
- Upgrade = new tag → `git -C C:\crypto-prod checkout <new-tag>` → `uv sync --frozen` → wait for the
  next step and check `engine health`. Roll back by checking out the previous tag.
- Data: the paper ledgers live under `<checkout>/data/paper` (gitignored). When moving production to a
  new checkout, stop the task, copy `data/paper` (and optionally `data/cleaned`), start the task.
  Keep the ledger directory outside OneDrive if possible (OneDrive can briefly lock files; the code
  retries `os.replace`, but sync conflicts are still possible).
- **One writer per ledger.** `state.json` records the owning `host`; a step on another machine refuses
  to run (`HostMismatch`). Decide which machine is canonical; moving it is `engine live recover
  --adopt-host --reason "moved to VM"` on the new machine.

## 2. Schedule

Windows (local Task Scheduler; scripts are provided, **you** run them):

```powershell
# review deploy\register_tasks.ps1 first, then from an elevated PowerShell:
powershell -ExecutionPolicy Bypass -File C:\crypto-prod\deploy\register_tasks.ps1 -App C:\crypto-prod
#   add -RunWhetherLoggedOn to run while nobody is logged on (stores the account password in Task Scheduler)
#   add -HealthSend to post health FAILs to Telegram (only if TELEGRAM_* env vars are set for that user)
```

It registers `PaperTradingStep` (hourly at :02 → `deploy\run_step.ps1`) and `PaperTradingHealth`
(hourly at :20 → `deploy\run_health.ps1`), both with `ExecutionTimeLimit` 30 min and
`MultipleInstances IgnoreNew`. The engine's own fetch budget is `feed.step_deadline_s: 600` (10 min),
so a slow Binance aborts the step cleanly (exit 2, nothing written) long before the task is killed.

- "Interactive" tasks (the default) only run while the user is logged on. A laptop that is shut down
  or asleep still misses hours even with WakeToRun; the next step catches up (funding and prediction
  resolution are cursor-based; an order older than 1 bar is cancelled, see section 5).
- `run_step.ps1` writes a UTC header and `===== exit N =====` to `logs\live.log`, rotates the log at
  20 MB and exits with the engine's code, so Task Scheduler's *Last Run Result* is meaningful.

Linux: `deploy/oracle_setup.sh` installs
`flock -n /tmp/engine-step.lock timeout 50m uv run --frozen --no-sync engine live step` at :02 and
`engine health --alert` at :20, plus a weekly logrotate for `logs/*.log`.

## 3. Monitor

| Signal | Where | Meaning |
|---|---|---|
| `logs/heartbeat.json` | written at the end of every `engine live step` | `ts`, `rc`, per-version codes, host, code_rev |
| `logs/health.json` | `engine health --alert` | latest checks (OK/WARN/FAIL) |
| `logs/alerts.log` | step rc 2/3, any health FAIL | the local alert channel — check it |
| `logs/live.log` | step output | UTC headers + exit code per run |
| Task Scheduler *Last Run Result* | both tasks | non-zero = look at the logs |

`engine health` FAILs on: heartbeat older than 3 h or last step rc ≥ 2; a version's last step older
than 6 h; last bar older than 8 h; a latched kill switch; reconciliation mismatch; a torn or corrupt
ledger file; a version continuously halted for more than 6 h; < 2 GB disk. WARN on a pending
`journal.json`, stale-marked positions, halts, logs > 100 MB.

Dead-man's switch: an alert that depends on the machine being alive cannot report the machine being
dead. Check `logs/heartbeat.json` age (or the dashboard) when you look in; if an external check is
wanted later, that is a separate decision (no remote service is configured by this repo).

Monitor jobs (optional, e.g. daily): `engine monitor resolve` (live feed, refuses exit prices more
than 2 bars older than expiry, then re-scores model health per version), `engine monitor drift`,
`engine monitor leaderboard` (all running versions; `--version vNNN` for one).

## 4. Recover

Every recovery command takes the ledger lock (refused while a step runs) and appends an audit row
to `<ledger>/audit.jsonl`.

**Interrupted step (crash, kill, reboot, task timeout).** Nothing to do. A step writes nothing until
its commit: `journal.json` (atomic) → append rows tagged `step_id`/`seq` (fsync) → `state.json`
(atomic) → delete the journal. The next step (or `engine live recover`) rolls a leftover journal
forward idempotently. A crash before the journal leaves disk untouched; the step simply re-runs.

**Torn last line** (`[ledger] WARNING: torn last line ... quarantined`). Automatic: the fragment is
moved to `<file>.torn`, the file is truncated to its last good line, and the interrupted step's rows
are re-applied from the journal. Health shows FAIL until a step or `recover` has run.

**Corrupt line in the middle of a file** (`LedgerCorrupt`, health FAIL "corrupt"). Real corruption:
stop the task, copy the ledger directory aside, inspect the line, restore the file from the latest
backup or remove the line by hand (document it), then `engine live recover --reason "..."`.

**Reconciliation mismatch / duplicate fills.**
```bash
uv run engine live recover --version v001 --reason "post-crash check"        # report only
uv run engine live recover --version v001 --reason "rebuild after review" --rebuild
```
Fills are identified by `(decision_ts, market, symbol)` and funding by `(ts, symbol)`; repeats
(written by the pre-journal code when a step died between the log appends and `state.json`) are
ignored by reconciliation and the scorecard, so a duplicated log no longer halts a version forever.
`--rebuild` recomputes `qty` and `cash` from the deduplicated fill log (diff recorded in audit.jsonl).

**Kill switch latched.** Review why (signals.jsonl reasons, equity.jsonl). Then
```bash
uv run engine live reset-kill --version v001 --reason "reviewed: <why>" [--reset-peak]
```
Without `--reset-peak` the next step re-latches if equity is still below the drawdown limit.
The kill switch is never evaluated on a book whose stale-marked positions exceed 5 % of equity
(`risk.stale_mark_tolerance`): those steps hold instead ("cannot value book").

**Feed failures.** 451/403/418 abort the whole step at once (exit 2, alert) — 451/403 mean the
machine's region is blocked by Binance (use a non-US VM), 418 is an IP ban (stop the schedule for a
few hours). 429/5xx/network errors retry with backoff and `Retry-After` within the 10-min deadline;
a symbol that still fails is listed in `reasons` and the step holds.

**Host mismatch.** Someone ran the same ledger on another machine. Decide which ledger is canonical,
copy it over if needed, then `engine live recover --adopt-host --reason "..."`.

## 5. Behaviour you should know

- Stale orders: an order whose fill bar is more than `paper.max_fill_lag_bars` (1) bar older than the
  latest closed bar is **cancelled**, logged as `missed_fill` in signals.jsonl, and a fresh decision
  is made in the same step. It is never filled at a price from hours ago.
- Equity marks never go backwards and are written once per bar. Positions without a fresh price are
  marked at their last-known price and flagged (`stale_marks`, `stale: true` on the equity row); such
  marks never raise the peak.
- Live bars and funding are cached in `data/paper/live_cache/` (parquet, atomic writes); each step
  only downloads bars newer than the cache. Deleting the cache is safe (it is refetched).
- `config/live.yaml` is fingerprinted (`live_hash`). Versions frozen from now on pin it and refuse to
  run if it changes. v001/v002 predate the pin: their hashes are unchanged, every row records the
  `live_hash` in effect, and the ensemble layer is never applied to them.

## 6. Rotate secrets

Only Telegram secrets exist (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), only as environment variables.
1. Revoke the token in @BotFather (`/revoke`) and issue a new one.
2. Update the user environment variable (Windows: *System → Environment Variables*, user scope; Linux:
   the cron user's environment file). Scheduled tasks pick it up on their next run.
3. Search logs for the old token: `Select-String -Path logs\*.log -Pattern "<old token prefix>"`.
   Since O12 every send error is redacted (`/bot<redacted>`), but older logs may contain it — delete
   or redact those lines.
4. Run `uv run engine health --alert --send` once to confirm delivery (only if sending is wanted).

## 7. Incident checklist

1. `uv run engine health` — note every FAIL.
2. `Get-Content logs\alerts.log -Tail 50`, `Get-Content logs\live.log -Tail 200`, `logs\heartbeat.json`.
3. Is a step running? (`.step.lock` is held by a live process only; a crashed process never leaves a
   stale lock.) Wait for it or stop the task before manual action.
4. Stop the scheduled task if the ledger may be damaged (`Disable-ScheduledTask PaperTradingStep`).
5. Back up the ledger directory (`data/paper`, including `v002/`) before any manual change.
6. Classify: feed (451/403/418/timeouts) · code (traceback; check `code_rev`, roll back the tag) ·
   ledger (torn/corrupt/mismatch → section 4) · risk (kill/halt reasons → section 4).
7. Recover with the commands in section 4 (always with `--reason`).
8. `uv run engine live step --version vNNN` once by hand, then `engine health` must be OK/WARN.
9. Re-enable the task; write what happened and why in the version's notes
   (`engine version set-status vNNN live --note "..."`).
