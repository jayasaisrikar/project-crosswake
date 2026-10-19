# 03 — Operations / unattended-run review

Scope: `src/engine/live/**`, `src/engine/track/**`, `src/engine/monitor/**`,
`src/engine/ensemble/{edge,no_trade,risk,combine}.py`, `config/live.yaml`, `config/health_rules.yaml`, `deploy/**`,
plus the installed Windows task `PaperTradingStep` and `logs/live.log`.
Review date: 2026-10-10. Read-only: no source or config was edited, `data/paper` was not touched (a copy was used),
nothing was sent to Telegram and no orders were placed.

How the findings were checked: the simulations are in the session scratchpad (`ops/sim.py`). They run against a
copy of `data/paper` and the test fixtures in `tests/test_live.py`, with mocked HTTP. Every finding marked
**VERIFIED** was reproduced. Findings marked **REASONED** come from reading the code and were not executed.

Severity scale: **CRITICAL** = silently corrupts the track record or stops trading with no alert. **HIGH** =
likely to happen in unattended running and needs a human to fix. **MEDIUM** = wrong but bounded.
**LOW** = hygiene.

---

## Summary table

| # | Sev | Finding | Where |
|---|---|---|---|
| O1 | CRITICAL | Not crash-safe: fills, funding and equity rows are appended before `state.json` is saved. If the process dies in between, the next run fills the same orders again, and reconciliation then halts that version permanently | `cli.py:72-118`, `paper.py:151,176,190,64` |
| O2 | CRITICAL | One torn JSONL line (from a power loss or a killed process) makes every later step crash and makes `engine health` crash | `paper.py:71-75`, `track/health.py:32-36,67` |
| O3 | HIGH | False kill switch. If no prices are available, equity is taken as cash only, so a long book reads as a 90%+ drawdown. The kill switch then latches and the book is flattened | `cli.py:77`, `paper.py:81-88`, `risk.py:47-53` |
| O4 | HIGH | No alerting. Nothing schedules `engine health`. Exit codes are dropped, so Task Scheduler always reports success. A 10-hour outage and a SyntaxError crash already went unnoticed | `deploy/run_step.ps1`, `deploy/oracle_setup.sh`, `logs/live.log` |
| O5 | HIGH | `oracle_setup.sh` installs an **empty** crontab on a fresh VM and then exits non-zero (pipefail combined with `crontab -l` failing) | `deploy/oracle_setup.sh:22-23` |
| O6 | HIGH | Production runs straight from the research working tree. A half-saved `pipeline.py` broke the 13:02 step | `deploy/run_step.ps1:6`, `logs/live.log:618-634` |
| O7 | HIGH | Worst-case step time (about 54 min for v001, about 124 min for v002) is longer than the task's 20-minute `ExecutionTimeLimit`. The task can be killed mid-step, which triggers O1. 451/403 errors are retried as if transient | `feed.py:56-75`, Task Scheduler settings |
| O8 | HIGH | The ensemble layer can **never** trade, whatever is configured, and enabling it **flattens** frozen versions | `ensemble_hook.py:255-264`, `no_trade.py:69-70`, `cli.py:93-108` |
| O9 | HIGH | `engine monitor resolve` resolves live predictions against `data/cleaned`, which ends on 2026-09-30. Wrong exit prices would be written permanently to the append-only `resolutions.jsonl` | `cli.py:287-292`, `monitor/ledger.py:70-73` |
| O10 | HIGH | `engine monitor leaderboard` drops every registry row because it keys on `model_id`/`exp_id`, but the registry uses `id` and `model_version`. Live ids (`sleeve.trend`) never match research ids (`tsmom\|H-0001`) | `monitor/leaderboard.py:41-48`, `research/batch.py:441-443` |
| O11 | MEDIUM | After an outage, a stale pending order is filled at the open of the bar right after the old decision, which can be hours in the past | `paper.py:107-109` |
| O12 | MEDIUM | The Telegram bot token is written to `logs/live.log` when a send fails | `telegram.py:76-78`, `cli.py:148` |
| O13 | MEDIUM | No process lock. A manual `engine live step` that overlaps the scheduled one produces duplicate fills (same mechanism as O1) | `cli.py:41-133` |
| O14 | MEDIUM | `HealthBook.reinstate` leaves `size_multiplier` at 0.0. `model_health.json` is written non-atomically. Health is evaluated only for the default ledger | `monitor/health.py:94,126-134`, `cli.py:283` |
| O15 | MEDIUM | The live feed never saves the bars it fetches. Each hour it re-downloads everything since the last `data/cleaned` bar, so the request load grows every day | `feed.py:173-234` |
| O16 | MEDIUM | `live.yaml` (risk limits and the ensemble switch) is not part of a version's `params_hash`, so a frozen version's behaviour can change without a new version id | `track/versions.py:34`, `config/live.yaml` |
| O17 | LOW | The log header labels local time as UTC (`Get-Date -Format u` adds `Z`) | `deploy/run_step.ps1:5` |
| O18 | LOW | A 400 response for any reason is read as "symbol not listed" and fails silently. 429/418 ignore `Retry-After` | `feed.py:62-65` |
| O19 | LOW | Ledgers grow without limit and are re-read in full several times per step. Telegram messages are close to the 4096-character limit | `paper.py:71`, `day_start_equity`, `monitor/ledger.py` |
| O20 | LOW | The ensemble stale-data check measures from bar open, while `check_risk` measures from bar close, so the two disagree by one hour | `ensemble_hook.py:258`, `risk.py:62` |

---

## Findings

### O1 — CRITICAL — A crash between ledger appends and `state.json` save duplicates fills and halts the version permanently (VERIFIED)

`live_step` does these steps in order:
1. `fill_pending` appends to `fills.jsonl` and mutates the in-memory state (`cli.py:72`, `paper.py:151`).
2. `accrue_funding` appends funding rows (`paper.py:176`).
3. `mark` appends to `equity.jsonl` (`paper.py:190`).
4. Risk checks and signal generation run, plus the optional ensemble.
5. Only then does `ledger.save()` run (`cli.py:118`).

Any exception or kill between steps 1 and 5 leaves the files out of step: `fills.jsonl` holds the fills, but
`state.json` still holds the old `qty` and the old `pending`. Possible causes are a `latest_signal` error, an
ensemble error, the Task Scheduler 20-minute limit, a reboot or OneDrive locking `state.json`. On restart the same
pending order is filled again.

Simulation S1 (`tests/test_live` toy data):
```
pending survived restart: True
fill rows: 2  reconcile: ['perp BTC: ledger 45.248869 vs fills 90.497738']
```
From then on every step adds `reconciliation: ...` to the halt reasons (`cli.py:82-86`). The version is
**halted forever**: `target = current`, and reconciliation never heals itself because the log is append-only.
Funding is affected the same way (S1b: 2 funding rows for 1 event). The scorecard rebuilds trades from
`fills.jsonl`, so it counts the duplicate trade. The public track record is therefore wrong.

**Fix:** make one step one transaction.
- Collect the fill, funding and equity rows in memory. Write `state.json` atomically first, with a `step_id`
  (the bar ts) and the list of rows it implies. Then append the rows, each tagged with `step_id`.
- On startup, if `state.step_id` is newer than the last `step_id` in `fills.jsonl`, append the missing rows.
  If it is older, ignore any rows with that `step_id`.
- Simpler alternative: each fill row carries `decision_ts`. `fill_pending` skips the fill if `fills.jsonl`
  already contains rows with that `decision_ts` and rebuilds `qty`/`cash` from them. The same idea applies to
  funding, keyed on `ts`/symbol.
- Also `fsync` the appends.

### O2 — CRITICAL — A torn trailing JSONL line breaks every later step (VERIFIED)

`PaperLedger.read_log` (`paper.py:71-75`) calls `json.loads` on every line and has no error handling. It runs
inside every step: `reconcile` (`cli.py:82`) and `day_start_equity` (`paper.py:195`). An append cut off by a power
loss or a killed process leaves a partial last line. S2:
```
PaperLedger.read_log -> JSONDecodeError Unterminated string ...
track.health._last_line -> JSONDecodeError
```
After that every hourly step crashes (`live_step_all` prints `step failed` and returns 2). `engine health` crashes
too instead of reporting FAIL, so the outage is invisible. `monitor/_io.read_jsonl` already skips bad lines, so
the two readers are inconsistent.

**Fix:**
- Write each record with a single `write()` of `line + "\n"`, then `flush` and `os.fsync`.
- On read, tolerate **only** a malformed *final* line: quarantine it to `<file>.torn` and raise an alert.
  A malformed line in the middle is real corruption and should FAIL health, not crash it.
- Wrap the health checks in try/except so they report FAIL instead of crashing.

### O3 — HIGH — The kill switch latches falsely when prices are missing (VERIFIED)

When `feed.last_bar is None`, `prices = {}` and `equity = ledger.equity({})` (`cli.py:76-77`). `equity()`
silently skips positions that have no price (`paper.py:84-86`), so equity becomes **cash only**. For a long perp
book, cash is far below true equity, because buying perps debits the notional. `check_risk` then measures the
drawdown against `peak` and latches `killed=True`.

```
equity seen 5000.0  kill True  ['drawdown 95.0% > limit 20.0%', 'no market data']
```

Today: v001 cash is 83,557 against a peak of 100,299 (16.7% "drawdown" from cash alone). A little more net long
exposure would trip the kill switch on the first full feed outage.

`last_bar is None` happens whenever there is no disk history and Binance cannot be reached. That is exactly the
Oracle VM case: `oracle_setup.sh` never builds `data/cleaned`, and it is gitignored. A partial version of the
same problem: with only the disk history, the book is valued at the 2026-09-30 prices. `mark()` then writes an
equity row stamped 2026-09-30, and `state.last_bar` goes backwards.

**Fix:**
- Never evaluate the drawdown or kill switch on an incomplete price vector. If any held position has no fresh
  price, set `halt` with reason "cannot value book" and skip `mark` and the kill check.
- Refuse `mark(t)` when `t <= state.last_bar`.

### O4 — HIGH — It can stop silently: no alerting, and exit codes are dropped (VERIFIED from logs and task config)

Evidence:
- `logs/live.log:103-104`: the run at 2026-10-10 00:02 (local) printed nothing. The next run was at 10:07, a gap
  of about 10 hours. `data/paper/signals.jsonl` also has no 06:00 UTC bar. Nobody was told about either gap.
- `logs/live.log:618-634`: the 13:02 run crashed with a `SyntaxError`, yet Task Scheduler showed
  `LastTaskResult 0`.

The reasons:
- `run_step.ps1` never calls `exit $LASTEXITCODE`.
- `engine health` (which exits 1 on FAIL) is not scheduled anywhere.
- No `--send` is configured.
- The task is `LogonType Interactive`, so it only runs while user `kilar` is logged on. `WakeToRun` is set, but
  a laptop that is shut down or on a locked lid still misses hours.
- `oracle_setup.sh` has no health cron and no log rotation.

**Fix:**
- Add `exit $LASTEXITCODE` to `run_step.ps1`.
- Schedule `engine health` (for example at :20) with a dead-man's switch: a *pinging* heartbeat such as
  healthchecks.io or a cron-monitor URL, sent only on success. Missing pings then raise the alert from outside
  the machine.
- Alternatively send a Telegram alert on FAIL to a separate admin chat. This needs a decision from sir about
  which channel is acceptable.
- Make health also FAIL on a version that has been continuously halted for N hours, and on reconciliation
  mismatch. Reconciliation is already covered.

### O5 — HIGH — `oracle_setup.sh` installs an empty crontab on a fresh VM (VERIFIED)

Line 23: `( crontab -l 2>/dev/null | grep -v 'engine live step' ; echo "$LINE" ) | crontab -` under
`set -euo pipefail`. On a VM with no crontab, `crontab -l` exits 1 and `grep` gets no input and exits 1. With
pipefail and errexit inherited by the subshell, the subshell exits **before** `echo "$LINE"`. `crontab -` then
installs an empty table and the script exits 1. The same happens when the only existing line is the engine line.
Simulated with a stub `crontab`:
```
installed: []
exit=1
```
The script also does not stop on the 451/403 reachability check (it only prints the result). It does not fetch
history (see O3 and O15), does not run `uv sync --frozen`, and the cron line has no `flock` and no `--send`.

**Fix:**
```bash
{ crontab -l 2>/dev/null | grep -v 'engine live step' || true; echo "$LINE"; } | crontab -
```
Also:
- Wrap the job as `flock -n /tmp/engine.lock timeout 50m ...`.
- Abort if the ping returns anything other than 200.
- Add a health/heartbeat line and `logrotate`.

### O6 — HIGH — The scheduler runs the live research working tree (VERIFIED)

The task runs `uv run engine live step` from `C:\Users\kilar\OneDrive\Documents\crypto`, which is the same tree
where research and AI sessions edit code. At 13:02 a half-written `pipeline.py:441` killed the step. A worse
outcome would be a *valid but changed* file (cost model, signals), which would silently alter a "frozen"
version. `params_hash` only covers the version YAML. `uv run` also re-syncs the environment on every call, so an
edited `pyproject.toml` changes dependencies in production.

**Fix:**
- Run production from a separate checkout pinned to a tag, for example
  `git worktree add C:\crypto-prod <tag>`.
- Use `uv run --frozen --no-sync`.
- Keep the paper data at an absolute path outside OneDrive, or exclude it from sync.
- Stamp every `signals.jsonl` row with `git rev-parse HEAD`.

### O7 — HIGH — Step duration can exceed the 20-minute task limit, and 451/403 are retried as transient (VERIFIED)

`get_json` treats any `HTTPError`, including **451** (region blocked) and **403**, as retryable: 4 attempts and
7 s of backoff, plus up to 4×15 s of timeouts (S3). Worst case per request is about 67 s. One step makes about
3 requests per symbol (spot klines, perp klines, funding). That gives about 54 min for v001 (16 symbols) and
about 124 min for v002 (37 symbols), run one after the other.

The installed task has `ExecutionTimeLimit PT20M`, so a slow Binance kills the process mid-step, and that is
exactly O1. 429/418 do not read `Retry-After`, and an IP ban (418) gets hammered again.

**Fix:**
- Treat 451, 403 and 418 as fatal for the whole step: abort immediately and alert.
- Honour `Retry-After`.
- Set a global deadline for the step (for example 10 min). After it, abort *before* any ledger mutation. Today
  the fetch already happens before mutation, so a deadline inside the fetch phase is safe.
- Share one fetch between v001 and v002. The symbols overlap.

### O8 — HIGH — The ensemble layer blocks every trade and flattens frozen versions (VERIFIED). Design for a correct fix below

`apply_ensemble` builds every candidate with `expected_return=0.0`, `confidence=nan` and
`expected_net_edge=nan` (`ensemble_hook.py:255-257`). `no_trade.evaluate` rejects whenever `ne` is not finite
(`no_trade.py:69`). **No `ensemble.no_trade` override can unblock it**, so the module docstring's "unless
`ensemble.no_trade` overrides say otherwise" (`ensemble_hook.py:16-18`) is wrong. S7, with
`require_calibrated: false, min_net_edge: -1`:
```
target: {'spot': {}, 'perp': {}}  vetoes: {'BTC': 'insufficient_edge: net edge nan (direction 1)'}
```
In `live_step`, an empty but non-halted target goes to `ledger.set_pending(t, target)` (`cli.py:107-108`). So
flipping `ensemble.enabled: true` **closes every position of v001 and v002 at the next open**. The change is not
captured in `params_hash` (O16).

A second, structural problem: even with a finite expected return, `HORIZON_HOURS = 1` combined with
*round-trip* costs (`edge.py:47-59`) asks a slow trend sleeve to earn its full entry plus exit cost
(about 2×(5 + spread) bps) every hour. That is impossible by construction. Holding an existing position costs
nothing.

**Correct design: how the sleeves should emit `expected_return`**
1. **Calibrate from the ledger the sleeves already write.** `predictions.jsonl` and `resolutions.jsonl` already
   pair each sleeve's weight `w` with the realised next-period return. Per sleeve, fit
   `E[r_{t→t+h}] = β_s · w_t`, a pooled, no-intercept regression of signed realised return on weight. Use only
   resolved rows older than the decision (causal), shrink toward 0 with a prior
   (`β_post = n·β̂ / (n + n0)`), and require `min_samples` (30, the same as `health_rules.yaml`). Before that,
   β = 0, and the ensemble must run in **shadow mode** (see 4). Fit `confidence` the same way, as a Platt or
   isotonic fit of `P(sign correct)` on |w|, so `require_calibrated` can pass honestly.
   *Bootstrap option:* β can be seeded from the frozen version's walk-forward OOS backtest (pre-H2 only),
   recorded once in the version YAML so that it is frozen and hashed.
2. **Use the sleeve's real holding horizon, not 1 h.** Set `horizon_hours` to the sleeve's measured mean holding
   time (trend is days). The edge test is then `|E[r_h]| > cost`, where cost is the **marginal turnover cost of
   moving from the current weight to the target**, not a round trip from flat. A held position whose target does
   not change has zero cost and must never be vetoed for "insufficient edge". In `edge.py` that means passing
   `notional = |Δw|·equity` and dropping the `2×` round-trip for continuation trades.
3. **Keep the sleeve's sizing.** `risk.target_weights` divides alpha by hourly vol and re-vol-targets at
   20%/yr with `periods_per_year=8760`. That replaces the frozen sleeve sizing with a different strategy. The
   layer should act as a *multiplier/veto* on the sleeve weights (health multiplier × gate ∈ {0,1} × risk caps),
   not a re-sizer, unless that change is frozen as a new version.
4. **Failure mode must be "hold", not "flatten".** If no candidate passes (missing calibration, all vetoed),
   either keep `current` (like `halt`) or keep the un-gated sleeve target, and log it. Never send an empty target
   into `set_pending`.
5. **Freeze it.** Include the `ensemble` block, and the calibration β/confidence maps or their hash, in
   `params_hash`, so turning the ensemble on creates v003 instead of mutating v001/v002.
6. Test: "ensemble enabled + sleeves with no calibration ⇒ target == current" and "calibrated sleeve with
   positive β and unchanged target ⇒ no veto".

### O9 — HIGH — `engine monitor resolve` writes wrong outcomes from stale history (VERIFIED)

`monitor_cmd("resolve")` builds price series from `data/cleaned` (last bar `2026-09-30 23:00`) and resolves with
`now = wall clock` (`cli.py:282-292`). `_price_at(series, expiry)` returns the **last price at or before**
expiry, even when it is weeks earlier (`monitor/ledger.py:70-73`). S4: a prediction made 2026-10-10 09:00 with
entry 60,000 resolved at exit **50,000 (the 2026-08-31 price)**, giving realised −16.7%.

Running it once on today's ledger would permanently write garbage into the append-only `resolutions.jsonl`. That
garbage then feeds health states, multipliers and the leaderboard. The live-step resolver is safe only because
its series ends at `t`.

**Fix:**
- Require the exit price's timestamp to be within one bar of `expiry`; otherwise skip the row.
- Make `monitor resolve` use the live feed, or simply drop it. The live step already resolves.

### O10 — HIGH — The leaderboard keys do not match the registry (VERIFIED)

`monitor.leaderboard.load_registry` keys rows on `r.get("model_id") or r.get("exp_id")`, but registry rows carry
`id` (EXP-…) and `model_version` + `hypothesis_id`. S6:
```
registry rows keyed: 0
engine monitor leaderboard would write model_ids: ['sleeve.trend']
```
So `engine monitor leaderboard` **overwrites `reports/leaderboard.md`** with a single live row. The 12-row file
you see now was written by a different path, `research/batch.py:431-444`, which uses the key
`f"{model_version}|{hypothesis_id}"`.

There are three key spaces that never meet:
- research: `tsmom|H-0001`
- live ledger and health: `sleeve.trend`
- versions: `v001`/`v002`

In addition, both versions log the same `sleeve.trend` id, so any cross-ledger view merges them.

**Fix:**
- Single `canonical_model_id(record)` in `monitor/leaderboard.py` = `f"{model_version}|{hypothesis_id}"`, with
  `exp_id = r["id"]`, used by both writers.
- Live predictions use `f"{version_id}/sleeve.{name}"`.
- A version YAML field `research_model_ids: [...]` links a live sleeve to the registry rows it descends from, and
  the leaderboard joins on that field.
- `monitor` commands loop over `running_versions` instead of only the default `paper.dir`.

### O11 — MEDIUM — After an outage, pending orders fill at a historical price (REASONED)

`fill_pending` fills at `after[0]`, the first bar after `decision_ts` (`paper.py:107-109`), however old it is.
After the 10-hour outage observed in O4, a decision made before the outage is filled at a price from about 9
hours earlier, which the bot could not have traded at. The positions between that bar and now are never marked.

**Fix:** if `after[0] < last_bar`, either fill at the open of the *latest* bar, or cancel the pending order,
log `missed_fill`, and decide again.

### O12 — MEDIUM — The Telegram token can leak into logs (VERIFIED)

`maybe_send` posts to `.../bot{token}/sendMessage` and calls `raise_for_status()`. The `HTTPError` text contains
the full URL:
```
HTTPError 400 Client Error: Bad Request for url: https://api.telegram.org/botSECRET123:ABC/sendMessage
```
`live_step_all` prints `step failed: {e}` into `logs/live.log` (`cli.py:148`). `logs/` is inside the
OneDrive-synced tree. A long v002 message (the largest observed is about 3.7k characters; Telegram's limit is
4096) is a realistic way to get a 400 response.

**Fix:**
- Catch `HTTPError` in `maybe_send` and re-raise with the token redacted.
- Split messages longer than 4000 characters.

### O13 — MEDIUM — No lock: concurrent steps double-fill (REASONED, same mechanism as O1)

`MultipleInstances IgnoreNew` only prevents overlapping *task* instances. A manual `engine live step`, a second
scheduler, or a cron job overlapping the task each load the same `state.json`. Each fills the same pending order
and appends fills, and the last `save()` wins. The result is the O1 reconciliation halt.

Running Windows and Oracle in parallel also produces two divergent ledgers for the same version ids. If either
uses `--send`, there are also duplicate posts.

**Fix:**
- Take an exclusive lock file per paper dir (`msvcrt.locking` / `fcntl.flock`) for the whole step.
- Record `host` in `state.json` and refuse to run if it differs.

### O14 — MEDIUM — Health book defects (S5 VERIFIED)

- `reinstate` copies the old record and sets `state: REDUCED` but keeps `size_multiplier: 0.0`:
  `after reinstate: {..., 'size_multiplier': 0.0, 'state': 'REDUCED'}`. The model stays at zero size.
- `_save` uses `write_text` with no temp file and no replace (`health.py:94`). A torn file is turned into
  multipliers of 1.0 by `health_multipliers`, because it catches the `ValueError`, so the model fails *open*.
- `HealthBook.evaluate` only runs from `engine monitor resolve` for the default dir. v002's health is never
  computed.

### O15 — MEDIUM — Live bars are never saved (REASONED)

`build_live_dataset` only reads `data/cleaned`. Each hour it re-downloads every bar since the last cleaned bar.
Today that is 10 days per symbol, rising by a day per day, and on the Oracle VM it is 200 days per symbol every
hour. That is about 10 requests per symbol and roughly 530 requests per hour across v001 and v002, which raises
the chance of 429 and IP bans over time.

**Fix:** append closed live bars and funding to a `data/live_cache/` parquet with an atomic write, and merge it
the same way as `data/cleaned`.

### O16 — MEDIUM — `live.yaml` is outside the version fingerprint (REASONED)

`params_hash(strategies, symbols, gate)` (`track/versions.py:34`) does not cover `config/live.yaml`. Editing
`max_gross_leverage`, `min_trade_frac`, the kill thresholds or `ensemble.enabled` changes how v001/v002 trade,
yet their verdict still counts as "the same frozen rules".

**Fix:** hash the effective risk, paper and ensemble block into each signals row, and refuse to run if it differs
from the value recorded in the version.

### O17–O20 — LOW

- **O17:** `run_step.ps1:5` uses `Get-Date -Format u`, which writes *local* time with a `Z`. The log header
  `16:02:03Z` was really 10:32 UTC (IST +5:30). Use `(Get-Date).ToUniversalTime().ToString('u')`. No NTP or clock
  check exists, and the in-progress-bar filter (`feed.py:88`) relies on the local clock. Clock skew forward by
  more than 0 s near :00 could admit a still-open bar. Cross-check against `close_time` and Binance `/time`.
- **O18:** `feed.py:62-63` treats every 400 response as `SymbolNotFound`, so a malformed parameter or a changed
  API quietly removes a symbol with no error. Match on Binance code `-1121` only.
- **O19:**
  - Growth: `day_start_equity`, `reconcile` and the prediction ledger re-read whole files every step.
    v002 adds about 13 prediction rows and about 3.5 KB of signals per step, roughly 65 MB a year of
    predictions plus 30 MB of signals, so the cost is O(n) per step and O(n²) over time.
  - `logs/live.log` is never rotated.
  - Fix: roll the files monthly and keep a running `day_start_equity` in state.
- **O20:** `TradeContext(last_data_time=t)` measures data age from the bar open, while `check_risk` measures from
  the close (`t + 1h`), so the ensemble declares data stale one hour earlier than the live risk check.

### Checked and found OK
- `state.json` is written atomically (tmp + `replace`, `paper.py:63-65`). The only caveat is that, inside
  OneDrive, `replace` can raise `PermissionError` while OneDrive holds the file open. That was not reproduced.
- Running twice in the same hour is safe for trading. `pending` is kept until the next bar exists, and funding
  is cursor-based. It only duplicates `equity.jsonl` and `signals.jsonl` rows; the scorecard dedups equity by ts.
- A missed hour is handled for funding and prediction resolution. Fills are covered under O11.
- The kill switch latches and flattens correctly when it fires on a valid price vector. Daily loss uses the
  previous UTC midnight mark.
- No real order endpoints are used. Secrets come only from env variables, apart from the logging leak in O12.

---

## Production runbook — gap list

| Area | Gap | Needed |
|---|---|---|
| Deploy | Runs from the dev working tree inside OneDrive | Pinned tag/worktree, `uv run --frozen --no-sync`, data dir outside OneDrive |
| Scheduling | Windows task is Interactive-only with a 20 min limit; Oracle cron install is broken (O5) | Fixed install line, `flock` + `timeout`, task runs whether or not a user is logged on (if allowed), and a time limit greater than the step deadline |
| Single writer | Nothing stops Windows + Oracle + manual runs from overlapping | Lock file + host id in `state.json`. Decide which machine is the canonical track record |
| Alerting | None. Exit codes are dropped and health is not scheduled | Heartbeat or dead-man's switch, a scheduled `engine health`, alerts on FAIL, halted > N h and reconciliation mismatch |
| Recovery: torn JSONL | No procedure | Documented `engine ledger repair` (quarantine the torn tail, re-reconcile) |
| Recovery: duplicate fills | No procedure | Documented replay from `fills.jsonl` keyed by `decision_ts` (after the O1 fix) |
| Kill reset | Hand-edit `state.json` | `engine live reset-kill --version vNNN --reason` with a logged audit row, refused while a step holds the lock |
| Backups | `data/paper` is gitignored; the only copy is OneDrive (Windows) or none (Oracle) | Daily snapshot plus a hash chain (each row carries the hash of the previous row) so the "public track record" is tamper-evident |
| Region | 451/403 is retried instead of failing fast | Fail fast and alert. Document the non-US region requirement for the VM |
| Data bootstrap (VM) | `oracle_setup.sh` never builds `data/cleaned`, which leads to O3 and O15 | Bootstrap download/clean, or a live bar cache |
| Log hygiene | No rotation; local time labelled as Z; token can appear in logs | logrotate / size cap, UTC headers, redaction |
| Monitor jobs | `monitor resolve/drift/leaderboard` are unscheduled, only cover the default dir, and are unsafe (O9, O10) | Fix first, then schedule per version |
| Change control | `live.yaml` edits silently change frozen versions | Hash it into the version and the signals rows |
| Ensemble | Enabling it flattens all books | Keep it OFF until the O8 design is implemented, with tests |
| Clock | No NTP or skew check on Windows | Compare with Binance `/api/v3/time` each step and halt if skew > 30 s |
