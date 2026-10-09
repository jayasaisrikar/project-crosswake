# Operations and Risk-Management Runbook

Operational runbook for the crypto **paper-trading** engine (`engine live`).
This covers how to run it, every risk control and what trips it, how state
survives crashes, monitoring, and the safety guarantees that keep it from ever
touching real money.

> **This system places NO real orders.** It reads public Binance market data and
> simulates fills against a local ledger. See the [Safety](#6-safety--no-real-orders)
> section for the hard guarantees.

---

## 1. Operating model

The engine runs **once per hour**:

```bash
uv run engine live step            # one hourly step (prints the Telegram-ready message)
uv run engine live step --send     # ...and posts to Telegram (needs the two env vars)
uv run engine live status          # inspect the current paper account
```

Scheduling (from README section 11):
- **Windows:** a Task Scheduler job running `uv run engine live step` hourly in this folder.
- **Linux server:** `deploy/oracle_setup.sh` adds an hourly cron job on an Oracle Cloud VM.
  Use a **non-US region** — Binance blocks US IP addresses.

Each `live step` does the following, in order (see `live_step` in `src/engine/cli.py`):

1. **Fetch.** `build_live_dataset` pulls the latest hourly bars and funding from
   Binance public REST, merged with on-disk cleaned history. **Only closed bars
   are used** — the in-progress hour is dropped (`feed.py`, `parse_klines`:
   `df["ts"] + HOUR <= now`). The dataset ends at the last real closed bar.
2. **Fill pending.** `ledger.fill_pending` fills *last hour's* planned trades at
   **this hour's OPEN** (never same-bar), applying the cost model (fees + spread
   + impact). **Skipped entirely if the feed reported any errors this step.**
3. **Funding.** `ledger.accrue_funding` applies every perp funding event since the
   last cursor: `cash -= qty * price * rate` (longs pay positive rates).
4. **Mark.** `ledger.mark` values equity at the last bar's close prices, updates
   the running peak, and appends an `equity.jsonl` row.
5. **Risk checks.** `check_risk` evaluates the controls in section 2, followed by
   ledger-vs-fills `reconcile`.
6. **Decide.** `latest_signal` computes target weights using **exactly the same
   strategy code as the backtest** (`signals_live.py` → `build_strategies`), then
   scales to the gross-leverage cap. The action taken depends on risk state
   (flatten on kill, hold on halt, otherwise stage new targets as `pending`).
7. **Log + notify.** Appends to `signals.jsonl`, atomically saves `state.json`, and
   prints / sends the Telegram message. The process exits `1` if halted, else `0`.

---

## 2. Risk controls

All limits live in `config/live.yaml` under `risk:` and are loaded into
`RiskLimits` (`src/engine/live/risk.py`). Actual configured values:

| Control | Config key | **Value** | Trips when | Effect |
|---|---|---|---|---|
| Kill switch (drawdown) | `max_drawdown` | **0.20 (20%)** | `1 - equity/peak > 0.20` | **Latched.** `killed=true` persisted; targets forced all-flat (`flatten_on_kill`). Requires manual reset. |
| Daily loss limit | `daily_loss_limit` | **0.05 (5%)** | `1 - equity/day_start_equity > 0.05` | **Halt** — no new trades the rest of the UTC day; positions held. |
| Stale data | `stale_data_hours` | **2.0 h** | last closed bar older than 2h, or no bar at all | **Halt** — don't trade. |
| Exchange errors | `max_exchange_errors` | **0** | more than 0 fetch errors in a step | **Halt** — don't trade; fills also skipped this step. |
| Gross leverage cap | `max_gross_leverage` | **2.0×** | combined `sum|weights|` across spot+perp > 2.0 | Target weights **scaled down** by `k = 2.0/gross` (not a halt). |
| Flatten on kill | `flatten_on_kill` | **true** | kill switch active | On kill, target = all-flat and staged as pending. |
| Reconcile tolerance | `reconcile_tolerance` | **1e-6** | ledger vs replayed fills mismatch > tol | **Halt** — reasons appended. |

Behaviour details (`check_risk` + the decision block in `cli.py`):

- **Kill switch is latched.** Once `max_drawdown` is breached, `check_risk`
  returns `kill=True`, and `cli.py` sets `ledger.state.killed = True`, which is
  saved to `state.json`. On every subsequent step the `already_killed` path keeps
  `kill=True` **regardless of recovery in equity**. The reason string is explicit:
  `"kill switch latched (manual reset required: set killed=false in state.json)"`.
- **`halt` subsumes `kill`** (`rep.halt = rep.halt or rep.kill`). On kill with
  `flatten_on_kill`, targets become `{"spot":{}, "perp":{}}` and are staged pending
  (so positions are closed at next open). On a non-kill halt, `target = current`
  (hold; no new orders). Otherwise new targets are staged.
- **Stale-data age** is measured from bar *close*: `age_h = now - (last_bar + 1h)`.
- **Gross leverage** scaling is not a halt — it quietly resizes and adds a note:
  `"gross leverage capped at 2.0x (scaled x…)"`.

### Resetting the kill switch (manual)

The kill switch is intentionally **human-gated**. To resume trading after a drawdown kill:

1. Stop the hourly scheduler.
2. Investigate why the drawdown happened; confirm it is safe to resume.
3. Edit `data/paper/state.json` and set `"killed": false`.
4. Re-enable the scheduler. The next step re-evaluates drawdown from scratch; if
   equity is still below the threshold, it will simply re-latch.

---

## 3. State and recovery

State lives under `data/paper/` (gitignored). See the module docstring in
`src/engine/live/paper.py`.

| File | Role | Write mode |
|---|---|---|
| `state.json` | cash, qty per (market, symbol), `pending` targets, `peak`, `killed`, `last_bar`, `last_funding_ts`, `created_at` | **atomic** (write `state.json.tmp`, then `os.replace`) |
| `fills.jsonl` | simulated fills (and funding rows) | append-only |
| `equity.jsonl` | one equity mark per step/bar | append-only |
| `signals.jsonl` | timestamped signal log — the **public track record** | append-only |

**Atomic state writes.** `PaperLedger.save` writes to a temp file then
`tmp.replace(state.json)`, so a crash mid-write never corrupts `state.json`:
either the old or the new complete file survives.

**Crash recovery.** On startup `PaperLedger` loads `state.json` if present,
otherwise initialises a fresh ledger at `initial_capital` (100000.0 from
`config/live.yaml`). The append-only ledgers are never rewritten, so history is
durable across restarts.

**Idempotency — no duplicate orders.** Three mechanisms together prevent
double-counting:
- **`fill_pending` is single-shot.** It reads `state.pending`, fills at the first
  bar *strictly after* the decision bar, and sets `state.pending = None`. If the
  next bar isn't closed yet it returns early and keeps `pending` intact — so a
  re-run before a new bar closes fills nothing.
- **Funding cursor.** `accrue_funding` only applies events with
  `index > last_funding_ts` and advances the cursor to the last event ts, so
  re-running never re-charges funding already applied.
- **Reconciliation.** Every step, `reconcile` replays *all* non-funding fills from
  `fills.jsonl` into expected positions and compares to the live ledger
  `state.qty`. Any mismatch beyond tolerance **halts** trading and surfaces the
  discrepancy (e.g. `spot BTC: ledger … vs fills …`). This is the guard that a
  partial crash (state saved but a fill lost, or vice-versa) is caught, not traded
  through.

**How fills are replayed.** `reconcile` (`risk.py`) sums `float(f["qty"])` per
`(market, symbol)` over the fill log (excluding `side == "funding"`) and asserts
it equals the ledger qty within `reconcile_tolerance`. The fill log is therefore
the source of truth the ledger is continuously checked against.

---

## 4. Stale-data and exchange-failure handling

**Only closed bars.** `feed.py` keeps a bar only once `open_time + 1h <= now`;
the live hour is always dropped. The returned `last_bar` is the newest **real**
(non-synthetic) closed bar; trailing all-synthetic rows are truncated.

**Fetch retries.** `get_json` retries up to `feed.retries` (**4**) with capped
exponential backoff on HTTP 418/429/5xx and transport errors, timeout
`feed.timeout_s` (**15s**). HTTP 400 "Invalid symbol" raises `SymbolNotFound` and
is treated as *not listed* (that symbol is skipped) — **not** an exchange error.

**Error accounting → halt.** Any genuine `FeedError` (per symbol / funding) is
appended to `feed.errors`. With `max_exchange_errors: 0`, **any** such error halts
the step, and `cli.py` also **skips `fill_pending`** when `feed.errors` is
non-empty — so a degraded feed never fills against incomplete data.

**Stale halt.** Even with no fetch error, if the newest closed bar is older than
`stale_data_hours` (**2.0h**) — or there is no bar at all (`last_bar is None`,
reason `"no market data"`) — the step halts and holds.

---

## 5. Monitoring and health checks

Use `uv run engine live status` for a quick snapshot (last bar, cash, peak,
`killed`, equity, return, drawdown, positions, pending, last signal). Beyond that,
watch:

- **Data gaps / staleness.** If `last signal` `asof` is not advancing roughly
  hourly, or status shows a halt with a `stale data` / `no market data` reason, the
  feed or scheduler is down. Confirm the hourly job is firing and the host IP is
  not US-blocked.
- **Failed fills / exchange errors.** Halt reasons containing `exchange error(s)`
  mean the feed failed; fills were skipped. Transient — but persistent errors need
  investigation (symbol delisting, API changes, connectivity).
- **Reconciliation mismatches.** A halt reason starting `reconciliation:` is
  serious: ledger and fill log disagree. Do **not** clear it by editing state
  blindly; diagnose which side is wrong first.
- **`equity.jsonl`.** The canonical equity/cash time series. Watch for unexpected
  drawdown (approaching the 20% kill or 5% daily limit), flat-lining (no new marks
  = not running), or gaps.
- **`signals.jsonl`.** Per-step record of `halt`, `kill`, `reasons`, targets vs
  current, gross, `n_fills`, `funding_paid` — the audit trail and public track
  record.

---

## 6. Safety — no real orders

The design makes real trading **impossible without new code**:

- **Public GET endpoints only.** `feed.py` talks to exactly three Binance public
  read-only endpoints: `api/v3/klines`, `fapi/v1/klines`, `fapi/v1/fundingRate`.
  All requests are `session.get(...)`.
- **No exchange order path.** There is no order-placement, order-cancel, or
  position-management call anywhere in the live package. "Fills" are purely
  simulated against the local ledger at next-bar OPEN with a modelled cost.
- **No withdrawal keys, no credentials.** The feed sends no API key/secret and no
  signed requests. There are **no hardcoded credentials** of any kind.
- **Telegram token from env only.** `telegram.py` reads `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID` from the environment; it posts only if `--send` **and** both
  vars are present, otherwise it just prints. No secrets are stored in the repo.
- **Mandatory disclaimer.** Every message carries the paper-trading / not-advice
  disclaimer.

---

## 7. Pre-live checklist for a FUTURE real-money mode

> **Real-money trading is NOT currently enabled and MUST NOT be enabled by this
> runbook.** No order path exists. The following is the bar to clear *before* any
> such capability is ever built or switched on.

- [ ] **Explicit human approval.** A named owner signs off that real trading may be
      enabled, with the capital amount and venue recorded.
- [ ] **Scoped API keys without withdrawal.** Keys restricted to trading only —
      **withdrawals disabled**, IP-allowlisted, least privilege. Never committed to
      the repo; injected via environment / secret store.
- [ ] **Separate config.** A distinct config (not `config/live.yaml`) gating real
      mode, so paper and live can never be confused by a stray flag.
- [ ] **Independent review.** The order-execution code, reconciliation, and
      kill-switch behaviour reviewed by someone other than the author before first
      use.
- [ ] **Dry run first.** Run the new path against the exchange testnet / shadow
      mode and confirm reconciliation holds before any real capital.
- [ ] **Kill switch verified.** Confirm the latched kill switch and daily-loss halt
      actually prevent orders in the live path, not just the paper path.

---

## 8. Known operational caveats (from audit)

Documented honestly; **not fixed** here. None of these affect the no-real-orders
guarantee.

- **`day_start_equity` is approximate.** `PaperLedger.day_start_equity` returns the
  last `equity.jsonl` entry at/before UTC midnight (or the first entry after
  midnight if none earlier). It is therefore *the latest mark before the day
  boundary*, **not guaranteed to be the exact day-start equity**. The daily-loss
  limit is measured against this approximation.
- **Reconcile tolerance scales with position size.** `reconcile` compares with
  `abs(x - y) > tol * max(1.0, abs(y))` — the effective tolerance grows with
  position size `|y|`, so larger positions tolerate a (proportionally) larger
  absolute mismatch before flagging.
- **Unbounded forward-fill in `close_prices`.** `close_prices` uses
  `close.loc[:t].ffill()` with no limit, so a stale last price can be carried
  forward indefinitely for valuation. This is only guarded by the **2h stale-data
  check**; within that window a forward-filled price may be used to mark equity.
