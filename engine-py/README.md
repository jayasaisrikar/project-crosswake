# Systematic Crypto Trend Engine

> **Research software. Not financial advice.** Nothing here guarantees profit. Past results, real or
> simulated, do not predict future results. Crypto trading with leverage can lose more than you put in.

This project is a "robot researcher" for crypto trading. It:

1. **downloads** years of real price history from Binance (the largest crypto exchange),
2. **tests** trading rules on that history as if they had been traded for real, including every fee,
3. **checks** whether the results are genuine skill or just luck and overfitting,
4. **paper-trades** the rule that survived, live, every hour, without real money, and
5. **publishes** the resulting signals (for example, to a Telegram channel) with a public, timestamped record.

If you only read one section, read [The honest scorecard](#7-the-honest-scorecard).
For the adaptive research engine added in October 2026 (hypothesis lab, point-in-time data, models,
ensemble/risk, monitoring), see [section 13a](#13a-research-engine-and-holdout-policy).

---

## 0. Start here (new contributor or new AI session)

**What this repo is, in one sentence:** a Python 3.12 crypto *research machine*. It tests trading ideas honestly on
Binance hourly data (2020 – Sep 2026), rejects the ones that don't survive costs and unseen data, and paper-trades
the survivors hourly. **No real orders are ever placed.**

**Two layers live side by side:**

| Layer | What | Where |
|---|---|---|
| **BASELINE_V0** (original engine) | trend + carry strategies, backtester, cost model, walk-forward validation, hourly paper loop (v001/v002), Telegram | `src/engine/{data,signals,backtest,validation,live,track,audit,reporting}`, frozen snapshot in `reports/baseline_v0/` |
| **Research engine** (added Oct 2026) | hypothesis lab, point-in-time data, feature store, 21 models, lead-lag + regime engines, ensemble / net edge / NO TRADE / risk, prediction ledger, health, drift, leaderboard, events, visual app | `src/engine/{research,pit,features,models,regimes,ensemble,monitor,events,app}`, `src/engine/leadlag/{engine,methods}.py` |

**Doc map:** [`docs/INDEX.md`](docs/INDEX.md) lists every document, its purpose and whether it is current or a
historical snapshot (`docs/archive/`).

**Read in this order:** this README → `AUDIT_REPORT.md` (what was wrong and why) → `ARCHITECTURE.md` →
`src/engine/research/contract.py` (the shared `Prediction` / `SignalModel` interface and holdout dates) →
`EXPERIMENTS.md` + `config/promotion_rules.yaml` → whichever of `DATA.md`, `FEATURES.md`, `MODELS.md`,
`VALIDATION.md`, `RISK.md`, `LIVE.md`, `docs/APP.md` matches the task. Literature and hypotheses:
`RESEARCH_DATABASE.md` (R-001…R-042) and `research/hypotheses_seed.yaml` (H-0001…H-0030).

**Rules that must never be broken** (the whole value of the repo depends on them):
1. **H2 is sealed.** Research and model selection use only data before **2025-10-01** (`H2_START`). Reading past it
   needs an explicit `--open-h2 --reason "..."`, which is logged forever in `experiments/holdout_log.jsonl`.
   H1 (from 2024-07-01) is already consumed. The *old* strategies have already seen H2, so for them only live paper data is new evidence.
2. **Never edit `config/promotion_rules.yaml`** (pre-registered 2026-10-10, before any candidate was evaluated) and
   never change cost parameters or labels after seeing results.
3. **Registries are append-only.** `experiments/exp_registry.jsonl` (EXP-000001…), `experiments/registry.jsonl`,
   `experiments/holdout_log.jsonl`, `data/paper/*.jsonl`. Failed experiments and retired models stay recorded.
4. **No look-ahead.** Every signal/feature/model must give the same answer at time t when data after t is removed
   (tests enforce this). Decisions at bar t fill at the open of t+1. Events are visible only after their publication time.
5. **Never overwrite `reports/baseline_v0/`.**
6. **Never fabricate data.** Models needing open interest, liquidations or order books are stubs that raise
   `DataUnavailable` until real data exists. Only hourly bars exist, so sub-hour lead-lag cannot be tested.
7. **Paper only.** No real execution without explicit human authorization. Secrets come from env variables only.

**Quality gates (must pass before any change is done):**
```bash
uv sync --frozen            # exactly uv.lock (never a plain `uv sync` on a production checkout)
uv run pytest -q            # ~375 tests
uv run ruff check src tests
uv run mypy src
```
The same gates run in CI on every push / PR (`.github/workflows/ci.yml`, Linux, Python 3.12, `uv sync --frozen`).
Optional local hook: `uv run --with pre-commit pre-commit install` (`.pre-commit-config.yaml`: ruff; mypy manual).
Config files are schema-checked at load time (`src/engine/config_schema.py`): an unknown or misspelled key in
`config/live.yaml`, `experiment.yaml` or `universe*.yaml`, or a risk limit out of range, raises `ConfigError`.

**Current state (2026-10-10, after the review round):**
- Baseline: 184 tests passed, ruff/mypy clean (`reports/baseline_v0/BASELINE_V0.md`) - *historical*: the count
  at the BASELINE_V0 freeze; the suite is now ~375+ tests.
- **Data rebuilt 2026-10-10:** `data/cleaned` was rebuilt with the frozen-contract fix (zero-volume flat bars are
  `is_filled`/stale, e.g. FTT after 2022-11-14); the previous tree is kept locally as `data/cleaned_prev_*`
  (gitignored). Integrity (`engine data validate`, `reports/data_integrity.json`): **0 critical / 0 high**
  (8 medium, mostly basis outliers on small coins). The earlier "365 critical" count is obsolete.
- **Independent review:** `reports/review/01_research.md` ... `06_app_flaws.md` (research, data, operations,
  engineering, benchmark, app).
- Lead-lag engine: no robust hourly BTC→alt edge (1 of 43 pairs, BTC→ADA 24h, consistent with chance;
  `reports/leadlag/engine/verdicts.md`).
- **batch_001 is INVALIDATED** (`reports/research/batch_001/INVALIDATED.md`): kept as recorded, but its decisions
  are not evidence either way (pre-rebuild data and the issues in `reports/review/01_research.md`).
- batch_002 (`reports/research/batch_002/results.md`, EXP-000013…000025, rules v2, rebuilt data): **0 PROMOTE**, 1 WATCH
  (`xs_mom` PIT top-15: Sharpe 0.92 vs buy-and-hold 0.47, alpha p 0.0076, but DSR 0.53 at N=116 trials and BH q 0.12),
  1 INCONCLUSIVE, 11 REJECT. Trend models (`tsmom`, `donchian`) were market beta (Sharpe ≤ 0 after removing drift).
  BTC→ADA with one-bar delay: Sharpe −0.31, REJECT. **No trial is significantly positive after multiple-testing correction.**
- Ensemble layer is wired into paper trading but **off** (`ensemble.enabled: false` in `config/live.yaml`); turning
  it on today would block all trades because the baseline sleeves emit positions, not return forecasts.
- Operations hardened: ledger lock + journal, `engine live recover`, `logs/heartbeat.json`, `engine health --alert`;
  see [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

**See everything visually:** `uv run engine app --open` builds `reports/app/index.html`, a single local file
(no server, no internet) explaining the whole loop in plain language with market, signals, paper trading, models,
research lab, data health and a glossary.

---

## Contents
0. [Start here (new contributor or new AI session)](#0-start-here-new-contributor-or-new-ai-session)
1. [Crypto basics in 2 minutes](#1-crypto-basics-in-2-minutes)
2. [What this engine does, in one picture](#2-what-this-engine-does-in-one-picture)
3. [The data](#3-the-data)
4. [The strategies](#4-the-strategies)
5. [How we simulate trading honestly](#5-how-we-simulate-trading-honestly)
6. [How we avoid fooling ourselves](#6-how-we-avoid-fooling-ourselves)
7. [The honest scorecard](#7-the-honest-scorecard)
8. [Ideas we tested and rejected](#8-ideas-we-tested-and-rejected)
9. [The independent audit](#9-the-independent-audit)
10. [Live paper trading and Telegram](#10-live-paper-trading-and-telegram)
11. [How to run it](#11-how-to-run-it)
12. [Project map](#12-project-map)
13. [Known problems and next steps](#13-known-problems-and-next-steps)
14. [Glossary](#14-glossary)

---

## 1. Crypto basics in 2 minutes

| Term | Plain-English meaning |
|---|---|
| **Coin** | A cryptocurrency such as Bitcoin (BTC) or Ethereum (ETH). Here, priced in **USDT**, a "digital dollar". |
| **Spot** | Buying the actual coin. You profit only if the price goes **up**. |
| **Perpetual future ("perp")** | A contract that tracks the coin's price. You can bet on it going up (**long**) or down (**short**). It never expires. |
| **Long / Short** | Long = profit when price rises. Short = profit when price falls. |
| **Funding rate** | Every few hours, perp traders on one side pay the other side a small fee. This keeps the perp price close to the spot price. When most people are betting "up", longs pay shorts. |
| **Leverage** | Controlling more money than you have. 2× leverage means a 10% move becomes 20% for you, both up and down. |
| **Drawdown** | The fall from your account's highest point to its lowest point after that. A −50% drawdown means half your money was gone at the worst moment. |
| **Sharpe ratio** | Return divided by how bumpy the ride was. Higher is better. Above 1 is good; Bitcoin's own is roughly 0.5–1. |

**Why this matters:** crypto has huge booms and crashes. Bitcoin fell **77%** from its 2021 peak to its 2022 bottom.
A strategy that can also **profit from falling prices** and **keeps risk steady** can give a much smoother ride.

---

## 2. What this engine does, in one picture

```
 Binance history ──► Clean & verify ──► Strategy rules ──► Simulated trading ──► Statistical checks ──► Reports
   (2020-2026)        (no bad data)      (target positions)  (fees, slippage,      (is it luck?)          (HTML/CSV)
                                                               funding)
                                                    │
                                                    ▼
                         Live, every hour: fetch latest prices ──► same rules ──► paper trade ──► log ──► Telegram
```

The **same strategy code** is used for the historical test and for live paper trading, so what we test is what we run.

---

## 3. The data

- **Source:** Binance's official public archive (`data.binance.vision`). Every downloaded file is checked against its
  published checksum, so we know it wasn't corrupted.
- **What:** one price bar per **hour** (open, high, low, close, volume) for spot and perps, plus every funding payment,
  **January 2020 to September 2026**. That is about 59,000 hours per coin.
- **Which coins (16):** BTC, ETH, BNB, SOL, XRP, DOGE, ADA, AVAX, LINK, LTC, DOT, TRX, BCH, EOS, **LUNA, FTT**.
- **Why include LUNA and FTT?** Both collapsed to almost zero in 2022. If you test only on coins that are still alive today,
  every strategy looks better than it really was. This is called **survivorship bias**, and we avoid it on purpose.
- **Quality:** no duplicate rows, no broken rows, and the longest gap is 5 hours. Gaps are filled and **flagged** so the strategies never trade on them.
  (One exception was found by the audit; see [section 9](#9-the-independent-audit).)
- **Trading-cost data:** bid-ask spreads are measured from Binance order-book archives where available, and otherwise estimated
  with a published academic method (Abdi & Ranaldo, 2017). That method deliberately estimates spreads too high, to stay conservative.

---

## 4. The strategies

### 4.1 Trend (the core, the one we actually use)

**The idea:** in crypto, prices that have been rising for weeks tend to keep rising for a while, and falling prices tend to keep falling.
This is called *trend following* or *momentum*. It is one of the best-documented effects in academic research.

**The rule, step by step (once a day at 00:00 UTC):**
1. For each coin, ask three questions: *Is the price higher than 20 days ago? Than 60 days ago? Than 120 days ago?*
   Each "yes" counts as +1 and each "no" as −1. Average them to get a score from −1 (strong downtrend) to +1 (strong uptrend).
2. Positive score means a **long** position; negative score means a **short** position.
3. **Size each position by its risk.** A wild coin like DOGE gets a smaller position than a calmer coin like BTC,
   so every coin contributes a similar amount of risk.
4. **Keep the whole portfolio's risk steady:** scale everything so the expected yearly ups and downs are about 20%.
5. **Safety caps:** at most 25% of the account in any one coin, and at most 2× total leverage.

**Why these numbers?** They come from published research or are round defaults. We did **not** search for the settings that
looked best on history; that is exactly how people fool themselves (see [section 6](#6-how-we-avoid-fooling-ourselves)).

### 4.2 Funding carry (optional, small)

**The idea:** buy a coin on spot **and** short the same amount on perps. Price moves cancel out, so you neither win nor lose from them,
but you **collect the funding fee** that over-excited long traders pay.

**The rule:** hold at most 5 coins, rebalance once a day, and only enter when 14 days of expected funding would pay for the trading costs at
least **twice**. Skip any coin whose spot and perp prices disagree by more than 2%.

**Reality check:** funding paid very well in 2021 but has been small since 2024, so carry now rarely trades. That is by design: it waits
until trading is worth the cost.

---

## 5. How we simulate trading honestly

A backtest is a "what would have happened" simulation. Most backtests on the internet are wrong because they cheat by accident.
Here is how we avoid that:

| Common cheat | What we do instead |
|---|---|
| Using a price you couldn't have known yet ("look-ahead") | Decisions use the **close of hour t** and are filled at the **open of hour t+1**. Automated tests check that hiding future data never changes a past decision. |
| Ignoring fees | Exchange fee on every trade (spot 0.10%, perp 0.05%). |
| Ignoring the bid-ask spread | Half the spread charged on every trade. |
| Pretending big orders don't move the price | A "market impact" cost that grows with trade size (the square-root law used by professional desks). |
| Ignoring funding | Every funding payment on every perp position is paid or received. |
| Dead coins disappear from the test | When a coin is delisted, the position is force-closed at **double** cost. |
| Costs might be underestimated | Every result is re-run at **1.5×** and **2×** costs. |

An independent module (`validation/reconcile.py`) re-computes every fee and checks that
*profit = market gains − costs − funding* holds for every single hour.

---

## 6. How we avoid fooling ourselves

**The trap:** if you try enough rules on the same history, one will look amazing purely by luck. This is called **overfitting**.
It is the reason most "95% win-rate" trading bots fail with real money. History rhymes, but it does not repeat exactly.

**Our defences:**

1. **Locked "exam" period.** Strategies were designed using **Jan 2020 – Jun 2024** only (the *development* period).
   **Jul 2024 – Sep 2026** was locked away as a *holdout*: an exam the strategy had never seen. Every time anyone opens it,
   that is permanently logged in `experiments/holdout_log.jsonl`.
2. **Walk-forward testing.** Repeatedly train on 2 years and test on the next 3 months, rolling forward through time.
3. **Every experiment is recorded** (`experiments/registry.jsonl`), so we know how many ideas were tried.
4. **Statistics that punish luck:**
   - *Deflated Sharpe* adjusts for how many ideas were tried.
   - *PBO* (probability of backtest overfitting) measures how often the "best" variant fails later.
   - *Bootstrap confidence intervals* give the range of plausible true Sharpe ratios.
   - The *SPA test* checks whether we really beat simply holding Bitcoin.

---

## 7. The honest scorecard

All results are after every cost. "Unseen" means the locked Jul 2024 – Sep 2026 period.

| Strategy | Return (unseen) | Sharpe (unseen) | Worst drawdown (unseen) |
|---|---|---|---|
| **Trend** | **+47.9%** | **0.94** | −18.7% |
| Trend + Carry (50/50) | +31.4% | 0.93 | −12.6% |
| Carry alone | +0.7% | 1.36 | −0.2% |
| Just holding Bitcoin | +33.4% | 0.51 | **−53.9%** |

**Trend by calendar year:**

| Year | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (to Sep) |
|---|---|---|---|---|---|---|---|
| Trend | +31.0% | +57.7% | +8.9%* | +4.7% | +18.7% | +4.1% | +28.7% |
| Bitcoin | +299% | +60% | −65% | +158% | +122% | −6% | −5% |

\* The audit found that most of 2022's gain came from an FTT trade at a price that could not really have been traded.
**Without FTT, 2022 was about +2.7%.** See [section 9](#9-the-independent-audit).

### What's good
- Roughly Bitcoin-like returns with **about one-third of Bitcoin's worst drawdown**.
- **Made money in falling markets** (2022, 2025) by shorting.
- The edge **survives doubled trading costs** (Sharpe 0.93 → 0.63).

### What's not proven yet (read this)
- **The edge is not statistically proven.** On unseen data, the 95% confidence range for Sharpe is **−0.34 to 2.28**, which includes zero.
  27 months is too short to be sure.
- **Overfitting warning:** PBO is **0.94** on the development period. Among the trend variants tried, the best-looking one tended not to stay best.
  Our response is to use only published default settings, never "the best" variant.
- **The holdout has been opened several times** (logged, mostly for bug fixes), so it is no longer a perfectly clean exam.
  From now on, **only live paper-trading results count as new evidence.**
- **It does not beat Bitcoin on raw return** (SPA test p ≈ 0.92). Its advantage is much lower risk.
- **Expect less live.** Research suggests live results are often about half the backtest: a Sharpe of roughly 0.5–0.9, drawdowns of 15–25%,
  and some flat years.

**There is no setting that makes money "every time". Anyone who promises that is selling something.**

---

## 8. Ideas we tested and rejected

We read the academic research and tested the most promising published ideas exactly as published, once each, on unseen data.
Details are in `docs/RESEARCH.md`, `docs/research/` and `docs/LEADLAG.md`.

| Idea | Looked like (development) | Was actually (unseen) | Decision |
|---|---|---|---|
| Trend (core) | Sharpe 1.08 | 0.92 | ✅ Kept |
| Donchian breakout (buy new 20/55/100-day highs) | 1.27 | 0.26 | ❌ Faded |
| Cross-sectional momentum (buy the strongest coins, short the weakest) | 1.30 | 0.20 | ❌ Faded |
| Volatility-managed trend | 0.89 | not tested | ❌ Worse on development data |
| Blend of the above three | **1.54** | 0.57 | ❌ Faded |
| **BTC → altcoin lead-lag** (altcoins follow BTC with a delay) | Gap exists only *inside* the hour BTC moves, and shrank from 27 bps (2020) to ~0 (2026) | Nothing tradable after the hour closes | ❌ Not tradable on hourly data |

**The lesson:** the best-looking backtest (the blend, Sharpe 1.54) lost most of its edge on unseen data.
That is why we don't chase "highest historical return". The lead-lag effect, if it still exists, plays out in **seconds to minutes**.
Testing it would need minute or tick data and very fast execution, where we would be competing with high-frequency firms.

---

## 9. The independent audit

`uv run python -m engine.audit` re-checks everything from scratch (results in `docs/AUDIT.md` and `reports/audit/`).

| Check | Result |
|---|---|
| LUNA collapse handled correctly (no trades on fake or after-delisting prices) | ✅ PASS |
| **FTT after the FTX collapse (Nov 2022)** | ❌ FAIL at audit time → **fixed** in the 2026-10-10 data rebuild (see below) |
| Forced exits charged correctly | ✅ PASS |
| Funding payments recomputed independently | ✅ PASS (matches to 0.000000000004) |
| Fees, spread and impact reconcile | ✅ PASS (36 of 36 checks) |
| Profit split into long vs short | ✅ PASS: 2022 profit came from shorts |
| Extreme price moves | ⚠️ WARN: 19 real >50% hourly moves (LUNA crash, DOGE Jan 2021), real exchange data, not errors |
| Accounting identity every hour | ✅ PASS |
| No leakage between development and holdout | ✅ PASS |

**The FTT bug:** when FTX collapsed, Binance stopped the FTT perp. Our data kept recording flat "fake" bars (same price, zero volume) as if they were real,
so the backtest closed its FTT short at a price nobody could actually trade at. This inflates 2022's result
(≈ +8.9% reported vs ≈ +2.7% without FTT). The unseen-period (2024–2026) results are **not affected**.
**Fixed (2026-10-10):** zero-volume, flat bars are now marked stale (`is_filled`) by `data/clean.py`, `data/cleaned`
was rebuilt, and integrity is 0 critical / 0 high. Backtest numbers quoted elsewhere that predate the rebuild
(including `reports/baseline_v0/`, frozen by design) still contain the FTT artefact.

---

## 10. Live paper trading and Telegram

`engine live step` is meant to run **once an hour**. Each run:

1. Downloads the latest **completed** hourly prices from Binance's public API. The hour still in progress is never used.
2. Fills last hour's planned trades at this hour's opening price, with realistic costs.
3. Adds funding payments and updates the account value.
4. Runs the **risk checks** below.
5. Decides new target positions using **exactly the same code** as the backtest.
6. Appends everything to a permanent, timestamped log in `data/paper/`. **This log is the public track record.**
7. Prints a Telegram-ready message with a mandatory disclaimer. It is **only sent** if you set `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_CHAT_ID` **and** add `--send`.

**No real orders are ever placed.**

| Safety rule | Setting (`config/live.yaml`) | What happens |
|---|---|---|
| Kill switch | Account down 20% from its peak | Close everything and stay off until a human resets it with `engine live reset-kill --version vNNN --reason "..."` (audited; never edit `state.json` by hand) |
| Daily loss limit | −5% in one day | No new trades until tomorrow |
| Stale data | Prices older than 2 hours | Don't trade |
| Exchange errors | Any | Don't trade |
| Leverage cap | 2× | Scale positions down |
| Reconciliation | Every run | Replay all fills and confirm the ledger matches; repair with `engine live recover` |

All limits are range-checked when `config/live.yaml` is loaded (e.g. `max_drawdown` must be in [0, 1]); a typo'd
key fails the step instead of being ignored.

**Unattended operation** (full procedures in [`docs/RUNBOOK.md`](docs/RUNBOOK.md)):
- *Lock:* a step holds an exclusive lock on the ledger directory; a second concurrent step exits with code 3.
  Exit codes: 0 ok, 1 halted, 2 failed/aborted, 3 lock busy.
- *Crash safety:* every step writes a `journal.json` first; an interrupted step is rolled forward by the next step
  or by `engine live recover --reason "..."` (also quarantines torn log lines, reports duplicate fills,
  `--rebuild` recomputes qty/cash from the deduplicated fills, `--adopt-host` moves a ledger to a new machine).
- *Heartbeat:* each step ends by writing `logs/heartbeat.json` (time, exit code, per-version codes, host, code_rev).
- *Health:* `engine health --alert` (scheduled hourly at :20) writes `logs/health.json` and appends FAILs to
  `logs/alerts.log`; `--send` also posts them to Telegram if the env variables are set.

### Strategy versions (v001, v002, ...)

Every strategy that is paper-traded is **frozen** as a numbered version in `config/versions/`. The file holds the
rules, the coin list, a written hypothesis and the pass/fail gate, plus a fingerprint (`params_hash`). If anyone edits
a frozen rule, the engine refuses to load it, so a changed rule must become a **new** version and be judged on new data.
Failed versions stay listed (`status: retired`), never deleted. `engine live step` runs every version whose status is
`live` or `observe`, each with its own paper account.

| Version | What it is | Judged on |
|---|---|---|
| **v001** | Trend + carry on the core 16 coins (the original live setup; keeps its paper record from 9 Oct 2026) | Live paper only. The 2024–26 holdout was viewed 5 times before freezing, so it is no longer unseen data. |
| **v002** | Exactly the v001 rules on 37 coins, including HYPE, SUI, ENA and TAO | Live paper only. Most of these coins have too little history to backtest. |

### Pass/fail gate

`engine scorecard` rebuilds every **trade** from the fill log. A trade opens when a coin's position leaves zero and
closes when it returns to zero. Its result includes fees, spread, market impact and funding. For each version the
gate says:

- **PENDING** until there are at least 90 live days and 30 closed trades. No verdict is given on too little data.
- **FAIL** at once if the paper drawdown passes 25%.
- **PASS** only if the profit factor is ≥ 1.2 **and** the 95% confidence interval of the average daily return is above zero.

### The one-use exam

`engine backtest --unlock-holdout` now refuses to score the **same rules twice** on the same locked period. A period
already opened by other rules needs `--acknowledge-reuse`, and the report is then stamped **CONTAMINATED**.
Since October 2026 the unlocked run also **stops before 1 Oct 2025 (H2)**; only `--open-h2 --reason "..."` reads past
it, and that is logged as an H2 opening (see [section 13a](#13a-research-engine-and-holdout-policy)).

### Other tools

| Command | What it does |
|---|---|
| `engine dashboard` | Writes `reports/dashboard.html`: versions, gate, equity curve, open positions, trades, latest actions, health. Local file, nothing is hosted. |
| `engine health [--alert [--send]]` | Checks the heartbeat, that hourly steps are running, data is fresh, the kill switch is off, ledgers reconcile and there is disk space. Exits with code 1 on FAIL; `--alert` logs to `logs/health.json` / `logs/alerts.log`. |
| `engine live recover --reason "..." [--rebuild] [--adopt-host]` | Roll forward an interrupted step, repair torn logs, re-reconcile (audited). |
| `engine live reset-kill --version vNNN --reason "..." [--reset-peak]` | Clear a latched kill switch after review (audited). |
| `engine market update [--send]` | 4-hourly market post for 10 major coins: price, 4h/24h change, RSI, MACD, 100-day trend, breadth and what each version holds. Every number is computed, none is written by AI. Context only, never a trade call. |
| `engine venue check` | Compares 30 days of Binance daily closes with Hyperliquid's to catch a bad price feed. Flags gaps over 50 bps. |
| `engine live record-fill` | Logs a real trade you placed by hand next to a version's paper account and measures your slippage against the paper fill. The paper account itself is never changed. |

Signal messages now start with plain-words actions ("OPEN LONG BTC", "TRIM ETH", "CLOSE SHORT SOL"). Tiny rebalances
under 0.25% of equity are left out of that list.

**Frozen contracts.** Binance keeps printing flat, zero-volume candles for some futures that stopped trading (TON since
July 2026). The live feed now treats them as stale, the same way the historical cleaner does, so they can't look like
"zero-risk" coins and get oversized positions.

---

## 11. How to run it

**Requirements:** Python 3.12 and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --frozen                          # install exactly the locked dependencies (uv.lock)

# Historical research
uv run engine download                    # fetch Binance history (large, one-time)
uv run engine clean                       # verify and clean it
uv run engine backtest                    # run strategies on the DEVELOPMENT period -> reports/report.html
# (uv run engine backtest --unlock-holdout --reason "why"   <- opens the locked exam; permanently logged)

# Checks
uv run python -m engine.audit             # independent data & accounting audit
uv run python -m engine.leadlag.study     # BTC -> altcoin lead-lag study

# Live paper trading
uv run engine live step                   # one hourly step (prints the message)
uv run engine live step --send            # ...and posts to Telegram (needs the two env variables)
uv run engine live status                 # current paper account(s)
uv run engine scorecard                   # per-trade stats + pass/fail gate per version
uv run engine dashboard                   # reports/dashboard.html
uv run engine health                      # is everything running? (exit 1 on FAIL)
uv run engine health --alert              # ...and log to logs/health.json + logs/alerts.log
uv run engine live recover --reason "..."  # repair after a crash / mismatch (docs/RUNBOOK.md)
uv run engine live reset-kill --version v001 --reason "reviewed: ..."   # clear a latched kill switch
uv run engine market update [--send]      # 4-hourly market update
uv run engine venue check                 # Binance vs Hyperliquid price cross-check
uv run engine version list                # all strategy versions
uv run engine version freeze --name "..." --hypothesis "..." [--symbols A,B,C]
uv run engine live record-fill --version v001 --symbol BTC --side buy --qty 0.01 --price 82000

# Quality gates
uv run pytest -q                          # automated tests
uv run ruff check src tests               # code style
uv run mypy src                           # type checks
```

**Running it every hour:** follow [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (deploy from a pinned release tag with
`uv sync --frozen`; scheduled jobs use `uv run --frozen --no-sync`).
- *Windows:* `deploy/register_tasks.ps1` registers the hourly step (:02) and health check (:20) tasks.
- *Linux server:* `deploy/oracle_setup.sh` installs everything on a free Oracle Cloud VM and adds an hourly cron job.
  Use a non-US region; Binance blocks US IP addresses.

---

## 12. Project map

```
config/            settings: coins, strategy parameters, costs, live risk limits; versions/ = frozen strategies
data/              raw downloads, cleaned hourly data, paper-trading ledger (data/paper is not in git)
src/engine/
  data/            download, clean, load, spreads, point-in-time coin listings
  signals/         strategies: trend, carry (+ rejected: breakout, xsmom, regime)
  backtest/        hour-by-hour trading simulator
  costs.py         fees + spread + market impact
  validation/      metrics, statistics, walk-forward, holdout lock, reconciliation
  live/            hourly paper trading, risk controls, Telegram
  track/           strategy versions, scorecard + gate, dashboard, health, market update, venue check
  audit/           independent data & accounting audit
  leadlag/         BTC -> altcoin lead-lag research
  reporting/       HTML/CSV reports
  --- research engine (Oct 2026) ---
  research/        contract.py (shared interface + holdout dates), holdout_guard, registry, hypotheses,
                   purged splits, runner, promotion rules, multiple testing, perturbation, batch
  pit/             point-in-time store, PIT universe, data quality
  features/        feature store (17 causal features, cached in data/features/)
  models/          21 SignalModels (baseline wrappers, rules, statistical) + data-unavailable stubs
  regimes/         causal regime labels, HMM (filtered), change-point
  leadlag/         engine.py + methods.py: walk-forward lead-lag engine with verdicts
  ensemble/        calibration, expected net edge, model combiner, NO TRADE gate, risk engine
  monitor/         prediction ledger, metrics, health states, drift -> research triggers, leaderboard
  events/          point-in-time news/event store and classifier
  app/             plain-language visual app (engine app)
research/          hypotheses_seed.yaml, triggers.jsonl (drift -> new research requests)
tests/             automated tests (including "no look-ahead" checks)
reports/           report.html, engine_review.html, comparison_crosswake.html, audit/, leadlag/
docs/              RESEARCH.md (literature), research/ (details), AUDIT.md, LEADLAG.md, TRIAL_LEDGER.md
experiments/       registry of every experiment + log of every holdout opening
deploy/            server setup script
```

**Best documents to read next:**
- `reports/engine_review.html`: the full professional review, with charts.
- `reports/comparison_crosswake.html`: comparison with a similar public project.
- `docs/AUDIT.md`: what the audit checked and found.
- `docs/RESEARCH.md`: what the research literature says.

---

## 13. Known problems and next steps

1. **Fix the FTT data bug** (section 9) and re-run all reports.
2. **Start the public paper track record** and let it run 3–6 months before anyone relies on the signals.
3. **Point-in-time universe:** each month, pick the most-traded coins from *every* coin ever listed (work in progress) instead of a fixed 16.
4. **Long-only spot version** for people who cannot or should not short with leverage.
5. **Compare live fills with the cost model** to check that the trading-cost assumptions hold.
6. **Legal review** before charging for signals. In many countries, including India, paid trading signals can count as regulated investment advice.

---

## 13a. Research engine and holdout policy

The October 2026 audit (`AUDIT_REPORT.md`) led to a second layer built next to the original engine. The old
strategies, backtester, cost model and paper loop are unchanged; new packages code against one shared contract
(`engine.research.contract`: `Prediction`, `SignalModel`, `H1_START`, `H2_START`).

```
data -> pit (as-of store, PIT universe) -> features -> models / leadlag / regimes -> Prediction
     -> ensemble (calibration, net edge, NO TRADE gate, risk sizing) -> backtest | paper loop
     -> monitor (prediction ledger, health, drift, leaderboard, dashboard)      events: external news
```

**Holdout policy.** H1 (from 1 Jul 2024) was opened 5 times and is *consumed*: it is ordinary out-of-sample data for
new ideas, never a final exam. H2 (from **1 Oct 2025**) is *sealed*: all research reads stop before it, and the only
ways past it (`engine research open-h2`, `engine backtest --unlock-holdout --open-h2`,
`engine.leadlag.study --open-h2`, `engine.leadlag.backtest_leadlag --full --open-h2`) each append a line with a
reason and `params_hash` to `experiments/holdout_log.jsonl`. **Caveat:** the existing strategies (trend, carry,
breakout, xsmom, lead-lag, v001/v002) were already shown H2 by earlier unlocks, so for them only live paper data is
new evidence. H2 is a clean exam only for hypotheses registered from now on.

**Audit fixes in this round:** forced-exit sign for shorts in trade stats (B1); an enabled sleeve with no
`allocation` entry is now skipped by both backtest and live (B2); cost models resolve `spreads.json` against the repo
(B3); paper fills skip stale bars like the backtest (B5); H2 enforcement in pipeline and lead-lag scripts (B7-B9).
A causal (expanding) spread estimate is available with `python -m engine.data.spreads --causal`
(`data/cleaned/spreads_causal.json`); it is **off** by default and not yet read by the cost model, so
`reports/baseline_v0` numbers are unchanged.

**Paper loop additions.** Each `engine live step` also logs every sleeve's position as a `Prediction` in
`data/paper/predictions.jsonl` and resolves expired ones (`monitor.log_predictions` in `config/live.yaml`). An
optional ensemble layer (health size multipliers, NO TRADE gate, risk-engine sizing) sits behind
`ensemble.enabled: false`; with the default the paper trades are exactly as before. No notifications were added.

| Command | What it does |
|---|---|
| `engine pit build` / `engine universe-at 2023-01-01` | point-in-time store / eligible coins at a time |
| `engine features list` / `engine features compute [--ids ...]` | feature registry / cached features (< H2) |
| `engine data validate` | integrity + PIT quality report (exit 1 if not ok) |
| `engine research run --hypothesis H-0001 --model MODEL_ID` | one pre-registered experiment (< H2), logged to `experiments/exp_registry.jsonl` |
| `engine research registry` / `engine research open-h2 --reason "..."` | list experiments / the logged H2 opening |
| `engine leadlag-engine` / `engine regimes` | lead-lag engine / regime labels and report (< H2) |
| `engine monitor resolve` / `drift` / `leaderboard` / `dashboard` | score expired predictions + model health / drift triggers / `reports/leaderboard.*` / `reports/research_dashboard.html` |
| `engine events ingest listings` / `engine events ingest --rss URL --source NAME` | external events with availability timestamps |
| `engine app [--open]` | builds the plain-language visual app `reports/app/index.html` (local file only) |

Docs: `AUDIT_REPORT.md`, `ARCHITECTURE.md`, `DATA.md`, `FEATURES.md`, `MODELS.md`, `EXPERIMENTS.md`,
`VALIDATION.md`, `RISK.md`, `LIVE.md`, `RESEARCH_DATABASE.md`, `docs/EVENTS.md`, `docs/REGIMES.md`,
`docs/LEADLAG_ENGINE.md`, and the frozen baseline in `reports/baseline_v0/`.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| Backtest | Simulating a strategy on past data. |
| Holdout / unseen data | Data kept locked away during development and used as a final exam. |
| Overfitting | Tuning a strategy to past noise. Looks great on history, fails live. |
| Paper trading | Simulated trading on live prices with fake money. |
| CAGR | Average yearly growth rate. |
| bps (basis point) | 0.01%. 100 bps = 1%. |
| Volatility | How much a price jumps around; used here to size positions. |
| Slippage / impact | Getting a worse price than expected because your order moves the market. |
| Delisting | An exchange stops trading a coin. |
| Survivorship bias | Testing only on things that survived, which makes results look too good. |
