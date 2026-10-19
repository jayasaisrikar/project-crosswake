# Installation and Usage Guide

> **Research software. Not financial advice.** This engine downloads real history, backtests trading
> rules honestly (every fee), checks for overfitting, and paper-trades the survivor live — **with fake
> money only. No real orders are ever placed.**

This guide covers prerequisites, installation, the full command reference, configuration, scheduling
hourly runs, and troubleshooting. Everything here is derived from the code and config in this repository.

---

## 1. Prerequisites

| Requirement | Version / notes |
|---|---|
| **Python** | **3.12** (the project pins `>=3.12,<3.13` in `pyproject.toml`). |
| **uv** | Astral's package/venv manager. Install from <https://docs.astral.sh/uv/>. All commands run through `uv run`, so you never manage a virtualenv by hand. |
| **Network** | Access to `data.binance.vision` (history) and Binance's public REST API (live feed). **Binance blocks US IP addresses** — see [Troubleshooting](#8-troubleshooting). |
| **Disk** | Several GB for the raw + cleaned hourly history of 16 coins (spot + perp, Jan 2020 onward). |

No API keys are needed for data or backtesting. Telegram env vars are optional and only used by live paper
trading when you opt in with `--send`.

---

## 2. Installation

```bash
uv sync --frozen        # exactly uv.lock (pyproject bounds are not enough for reproducibility)
```

That creates the virtual environment and installs all runtime dependencies (pandas, numpy, pyarrow, scipy,
statsmodels, arch, pyyaml, requests, plotly, jinja2) plus the dev tools (pytest, ruff, mypy, type stubs).

The project exposes a single console script, defined in `pyproject.toml`:

```toml
[project.scripts]
engine = "engine.cli:main"
```

so `uv run engine ...` is the primary entry point. Research-only helpers (audit, lead-lag) are invoked as
Python modules with `uv run python -m ...`.

---

## 3. Single command to start

If you only want to see the engine produce a result, after `uv sync --frozen`:

```bash
uv run engine download && uv run engine clean && uv run engine backtest
```

This fetches the history, cleans/verifies it, runs the strategies on the **development** period only, and
writes `reports/report.html`. The locked holdout is **not** touched unless you explicitly unlock it (below).

---

## 4. Command reference

All commands are run from the repository root.

### 4.1 Data

```bash
uv run engine download          # fetch raw history from data.binance.vision (large, one-time)
uv run engine clean             # verify checksums and build cleaned hourly data in data/cleaned
```

`clean` is also how you **regenerate** cleaned data after a fix or config change — it rebuilds
`data/cleaned` from the raw downloads. Both read `config/universe.yaml` for the coin list and date range.

### 4.2 Backtest (development vs holdout)

```bash
uv run engine backtest                                   # DEVELOPMENT period only -> reports/report.html
uv run engine backtest --unlock-holdout --reason "why"   # also include the locked holdout (logged)
```

- Development is `start`..`split.dev_end` (`2024-06-30`); the holdout (`2024-07-01` onward) stays locked.
- `--unlock-holdout` requires a `--reason`. **Every unlock is permanently recorded** in
  `experiments/holdout_log.jsonl`. Open it only when you truly must — it erodes the "clean exam".

### 4.3 Lead-lag study (event study + cross-correlations)

```bash
uv run python -m engine.leadlag.study                      # uses config/leadlag.yaml
uv run python -m engine.leadlag.study path/to/leadlag.yaml # optional alternate config
```

Runs the pre-registered BTC -> altcoin impulse event study and lagged cross-correlations, printing a summary
and writing CSVs to `reports/leadlag/` (`event_study.csv`, `events_k*.csv`, `xcorr_by_year.csv`).

### 4.4 Lead-lag strategy backtest (net-of-cost comparison)

```bash
uv run python -m engine.leadlag.backtest_leadlag          # DEVELOPMENT period only (default)
uv run python -m engine.leadlag.backtest_leadlag --full   # descriptive all-period view (logged)
```

Turns the event study into an executable strategy and prices it with the **same backtester and cost model**
as every other sleeve, so the "is lead-lag tradable on hourly bars?" question is answered in net-return
terms. It sweeps a pre-registered grid of thresholds (`k`) and holding horizons, adds trend and
BTC-buy-and-hold baselines, writes `reports/leadlag/strategy_comparison.csv`, and appends to
`experiments/registry.jsonl`. Default runs on development only to keep the holdout clean; `--full` is logged.

### 4.5 Independent audit

```bash
uv run python -m engine.audit            # re-checks data & accounting from scratch
```

Re-computes fees, funding and the accounting identity independently, checks delisting handling (LUNA/FTT),
look-ahead, and dev/holdout leakage. Results land in `docs/AUDIT.md` and `reports/audit/`.

### 4.6 Live paper trading

`engine live step` is meant to run **once an hour**. It fetches the latest *completed* hourly bars, fills
last hour's pending trades at this hour's open (with realistic costs), accrues funding, marks the account,
runs the risk checks, decides new targets with the **same code as the backtest**, and appends everything to
the permanent ledger in `data/paper/`.

```bash
uv run engine live step            # one hourly paper step; prints a Telegram-ready message
uv run engine live step --send     # also post the message to Telegram (needs env vars below)
uv run engine live status          # show current paper account (equity, return, drawdown, positions)
```

**Telegram (optional).** The message is only transmitted when **both** env vars are set **and** you pass
`--send`:

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. |
| `TELEGRAM_CHAT_ID` | Target chat/channel id. |

```bash
# bash / Linux
export TELEGRAM_BOT_TOKEN="123456:ABC..."
export TELEGRAM_CHAT_ID="-1001234567890"
uv run engine live step --send
```

```powershell
# PowerShell / Windows
$env:TELEGRAM_BOT_TOKEN = "123456:ABC..."
$env:TELEGRAM_CHAT_ID   = "-1001234567890"
uv run engine live step --send
```

Without `--send`, or without the env vars, the message is printed only and nothing leaves the machine.
**No real orders are ever placed in any mode.**

### 4.7 Quality gates

Run these after any change; they are the project's real gates.

```bash
uv run pytest -q                 # 139 automated tests (including "no look-ahead" checks) — all pass
uv run ruff check src tests      # lint / code style
uv run mypy src                  # static type checks
```

---

## 5. Scheduling hourly runs

The live step is idempotent per bar and designed to be driven by a scheduler at the top of each hour (UTC).

### 5.1 Windows (Task Scheduler)

A ready wrapper is provided at `deploy/run_step.ps1`. It `cd`s into the repo, ensures a `logs/` folder,
and appends the step output to `logs\live.log`:

```powershell
& "C:\Users\...\uv.exe" run engine live step *>&1 | Out-File -Append logs\live.log
```

Create a Task Scheduler job that runs this script **hourly** with the repository as its working directory.
(If `uv` is on a different path on your machine, update the path inside `run_step.ps1`.)

### 5.2 Linux server (Oracle Cloud, cron)

`deploy/oracle_setup.sh` is a one-time setup script for an Oracle Cloud Always Free Ubuntu VM. It:

1. installs `curl`/`ca-certificates` and `uv` (if missing),
2. runs `uv sync --frozen`, creates `logs/`, sets the timezone to **UTC**,
3. performs a Binance reachability check (HTTP 451/403 there means the region is blocked),
4. installs an hourly cron entry at minute `:02`, and
5. runs the first step immediately.

```bash
bash ~/crypto/deploy/oracle_setup.sh
```

The cron line it installs:

```
2 * * * * cd $APP && $UV run engine live step >> $APP/logs/live.log 2>&1
```

**Use a non-US region** — Binance blocks US IP addresses.

---

## 6. Configuration reference

All settings live in `config/*.yaml`. Key fields:

### `config/universe.yaml` — what to trade
- `quote: USDT`, `interval: 1h`, `start: "2020-01"`, `end: null` (null = last complete month).
- `symbols`: the 16 coins, deliberately including **LUNA** and **FTT** (which later collapsed) to limit
  survivorship bias.
- `markets: [spot, perp]` (perp = Binance USDT-M perpetual futures).

### `config/experiment.yaml` — strategy, costs, split, walk-forward
- `initial_capital: 100000.0`.
- `costs`: `fee_bps: {spot: 10.0, perp: 5.0}` (Binance VIP0 taker), half-spreads from
  `data/cleaned/spreads.json` using `spread_stat: p75` (conservative), `impact_y: 0.7` (square-root impact
  law), `stress_multiplier: 1.0` (reports also re-run at 1.5x and 2.0x).
- `split`: `dev_end: "2024-06-30"`, `holdout_start: "2024-07-01"` — the holdout is locked.
- `walk_forward`: `train_months: 24`, `test_months: 3`, `embargo_bars: 168` (1 week).
- `strategies.trend` (enabled): `market: perp`, `lookbacks_days: [20, 60, 120]`,
  `vol_target_annual: 0.20`, `rebalance_hours: 24`, `max_gross_leverage: 2.0`,
  `max_weight_per_asset: 0.25`, `allow_short: true`.
- `strategies.carry` (enabled): funding entry/exit thresholds, `max_positions: 5`, `min_hold_days: 14`,
  cost-aware entry margin, `max_basis: 0.02`.
- `breakout`, `xsmom`, `leadlag`, `trend_regime`: research candidates, `enabled: false`.
- `allocation`: `trend: 0.5`, `carry: 0.5` (capital split between sleeves).

### `config/leadlag.yaml` — lead-lag research (pre-registered)
- `leader: BTC`, `followers: [...]` (FTT/LUNA excluded as collapsed), `k_values: [2.0, 3.0]`,
  `horizons: [1, 2, 4, 8, 24]`, causal `vol_lookback_bars`/`beta_lookback_bars: 720` (30d),
  `dev_end: "2024-06-30 23:00"`, and a `strategy` block (`k: 2.0`, `hold_hours: 1`, `gross: 1.0`).

### `config/live.yaml` — live paper risk limits
- `paper`: `initial_capital: 100000.0`, `dir: data/paper` (gitignored), `min_trade_frac: 0.001`.
- `feed`: `history_days: 200`, `timeout_s: 15`, `retries: 4`.
- `risk`: `max_drawdown: 0.20` (latched kill switch), `daily_loss_limit: 0.05`,
  `stale_data_hours: 2.0`, `max_exchange_errors: 0`, `max_gross_leverage: 2.0`,
  `flatten_on_kill: true`, `reconcile_tolerance: 1.0e-6`.

---

## 7. Project map (where things live)

```
config/            settings: coins, strategy parameters, costs, live risk limits
data/              raw downloads, cleaned hourly data, paper ledger (data/paper not in git)
src/engine/
  data/            download, clean, load, spreads, point-in-time listings
  signals/         strategies: trend, carry (+ rejected: breakout, xsmom, leadlag, regime)
  backtest/        hour-by-hour trading simulator
  costs.py         fees + spread + market impact
  validation/      metrics, statistics, walk-forward, holdout lock, reconciliation
  live/            hourly paper trading, risk controls, Telegram
  audit/           independent data & accounting audit
  leadlag/         BTC -> altcoin lead-lag research (study + strategy backtest)
  reporting/       HTML/CSV reports
tests/             139 automated tests (including "no look-ahead" checks)
reports/           report.html, engine_review.html, audit/, leadlag/
docs/              RESEARCH.md, research/, AUDIT.md, LEADLAG.md, and this guide
experiments/       registry of every experiment + log of every holdout opening
deploy/            oracle_setup.sh (Linux cron) and run_step.ps1 (Windows)
```

---

## 8. Troubleshooting

**Binance returns HTTP 451 / 403, or download/live step fails to reach the exchange.**
Binance blocks **US IP addresses**. Run from a **non-US region** (for example, an Oracle Cloud VM in a
non-US region, or a non-US network). `deploy/oracle_setup.sh` includes a reachability check that prints the
HTTP code from both the spot and perp ping endpoints — anything other than `200` indicates a region block.

**Cleaned data looks wrong, or you changed `universe.yaml` / fixed a data bug.**
Regenerate the cleaned dataset from the raw downloads:

```bash
uv run engine clean
```

If the raw files themselves are missing or stale, re-run `uv run engine download` first, then `clean`.

**Live step reports `halt` / `kill`.**
The risk layer (see `config/live.yaml`) halts on stale data, exchange errors, a daily loss over 5%, or a
reconciliation mismatch; the kill switch latches when drawdown from peak exceeds 20%. A kill is persistent:
reset it by setting `killed=false` in `data/paper/state.json` (a deliberate human step).

**Telegram message was not sent.**
It is only sent when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set **and** you pass `--send`.
Otherwise the message is printed only.

**Quality gate fails.**
Re-run the three gates — `uv run pytest -q` (139 tests, all pass), `uv run ruff check src tests`,
`uv run mypy src` — and fix issues before committing. A failing gate means the task is not done.
