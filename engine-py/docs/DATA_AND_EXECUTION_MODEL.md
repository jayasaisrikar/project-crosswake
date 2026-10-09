# DATA_AND_EXECUTION_MODEL — datasets, microstructure & cost/execution assumptions

Master-prompt §5 and §7. What data the engine has, its quality and limits, and exactly how a signal becomes a
priced fill (fees, spread, impact, funding, timing). Written 2026-10-09 from the repo's code, configs and
`data/cleaned/`; no code was changed authoring this doc. Scope is the information a lead-lag (or any)
candidate needs to be evaluated honestly.

**Verification legend:** [V] = checked this session (2026-10-09); [K] = established result the repo's research
docs already cite. All spread/coverage figures below are read from `data/cleaned/` artifacts.

---

## 1. Datasets

### 1.1 Source and access
- **Exchange:** Binance. **Markets:** USDT-M **perpetual futures** (primary) and **spot**. **Interval:** 1-hour
  klines. **Access:** public monthly/daily archives from `data.binance.vision` (`engine.data.download`),
  parsed by `engine.data.clean`. Funding-rate history is downloaded and cleaned alongside bars.
- **Universe (lead-lag study):** leader **BTC**; followers ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, DOT, LINK, LTC,
  BCH, TRX, EOS (`config/leadlag.yaml`). The engine's trading universe (`config/universe.yaml`) is 16 symbols
  and **deliberately retains LUNA and FTT** (collapsed) as a survivorship control.
- **Archive breadth (bigger than the universe):** `data/cleaned/bars/perp` actually holds **~283 symbols** [V],
  each from its listing date to **2026-09-30 23:00 UTC**. Long-lived majors span **2020-01 → 2026-09** (e.g.
  ADA 58,432 bars, ATOM 58,260, AAVE 52,217). This breadth matters for §6: a wider point-in-time universe is
  available *at 1h*; the binding gap for lead-lag is **resolution (1h), not symbol count**.

### 1.2 Timestamp conventions & event-time alignment
- Epoch ms **or** µs is auto-detected per value and converted to tz-aware UTC (`clean.py::to_utc`,
  `US_THRESHOLD`). Only **hour-aligned** bars are kept (`ts == ts.floor("h")`).
- **Convention (critical for causality):** a row's index is the **bar open**; its return `r[t]` is
  `log(close_t) − log(close_{t−1})` (`events.py` docstring, `contracts.py`). Funding timestamps carry ms jitter
  (`08:00:00.001`) and are **snapped to the settlement hour** before being charged (`engine.py`;
  `tests/test_timestamps.py`, `tests/test_time_axis.py`).

### 1.3 Missingness, quality, integrity checks (`clean.py::clean_bars`)
- Dedupe on `ts` (keep last), sort, and drop **OHLC-invalid** rows (non-positive, `high < max(open,close)`,
  `low > min(open,close)`, `high < low`, negative volume).
- **Gaps** forward-filled onto a complete hourly index; every synthesized hour is flagged `is_filled=True` and
  its returns are masked everywhere downstream (so stale prices never create signals or fills).
- **Ticker-reuse / delisting breaks:** `truncate_at_discontinuity` cuts the series before the first open that
  jumps >90% vs the previous close (open-vs-prev-close avoids flagging genuine intrabar crashes), handling e.g.
  the LUNA→LUNC rename. Funding of the successor contract is dropped too.
- **"Frozen" halted bars:** bars present in the archive but with zero volume and `o=h=l=c=prev close` (what
  Binance published for FTT/halted perps after the FTX failure, Nov 2022) are treated exactly like synthesized
  bars (`frozen` mask). These are not executable prices.
- An audit JSON records per-symbol first/last ts, bar count, filled count, longest filled run, truncation ts
  (`data/cleaned/audit.json`).

### 1.4 Limitations (honest)
- **Resolution ceiling:** 1h bars cannot resolve the seconds-to-minutes BTC→alt lead the literature documents
  (`docs/LEAD_LAG_RESEARCH_REVIEW.md` §1). **An hourly archive cannot prove — or trade — a sub-hour edge.**
- **No intrabar / L2 data:** no trades, quotes, or order-book depth. Partial fills and true queue position
  cannot be modelled; the spread and impact terms are *estimates*, not measured executable liquidity.
- **Spot spread is modelled, not observed:** spot half-spreads come from the Abdi–Ranaldo (2017) 1h estimator
  with a 2.0 bps floor, not from quotes. Perp half-spreads come from a **4-day** bookTicker sample (2023–24),
  so they are a small, specific window extrapolated across the whole history.
- **Delisted-asset depth:** historical ADV/vol for thin or dead coins is noisy; the impact model defaults to
  worst-case participation when liquidity is unknown (below).

---

## 2. Microstructure inputs

### 2.1 Measured half-spreads (`data/cleaned/spreads.json`, used at `spread_stat: p75`) [V]
Half-spread in **bps**, perp (bookTicker) vs spot (Abdi–Ranaldo, floored at 2.0):

| symbol | perp p75 | spot p75 |
|---|---|---|
| BTC | ~0.020 | ~3.27 |
| ETH | ~0.031 | ~2.13 |
| BNB | ~0.23 | ~6.60 |
| SOL | ~0.34 | ~8.27 |
| XRP | ~1.03 | ~6.68 |
| DOGE | ~0.81 | ~5.94 |

Perp half-spreads for majors are **sub-basis-point**; the dominant frictions on perps are **fees** and
**impact**, not spread. Config fallbacks when a symbol is absent: BTC/ETH 0.5 bps, default 2.0 bps.

### 2.2 Fees (`config/experiment.yaml`, accessed 2026-10-09) [V]
- **Perp USDT-M taker 5.0 bps / side** (maker 2.0); **spot taker 10.0 bps / side**. No BNB discount assumed
  (conservative). The engine charges **taker** because signals cross the spread.
  https://www.binance.com/en/fee/trading · https://www.binance.com/en/support/faq/360033544231

### 2.3 Market impact — square-root law (`engine/costs.py`) [K]
`impact = Y · σ_daily · sqrt(min(N/ADV_daily, 1.0)) · N`, with **Y = 0.7**. ADV (quote/day) and daily σ are
trailing-30-day, `shift(1)` → causal (`rolling_adv_and_vol`). Unknown liquidity → participation capped at 1.0
(worst case). References: Almgren, Thum, Hauptmann & Li (2005); Torre/BARRA (1997); Tóth et al. (*PRX* 2011).

### 2.4 Funding
Perp funding is charged every 8h on positions held into the settlement bar, marked at the last perp close
before settlement (`engine.py` step 1). Spot/perp basis is used by the carry sleeve, not by lead-lag.

---

## 3. Execution model (master-prompt §7)

Implemented once in `engine.backtest.engine.run_backtest`; **every candidate — including lead-lag — uses it**,
so backtest and (future) paper trading share identical fill logic.

1. **No intrabar look-ahead.** Weights decided from bar *t* close are **executed at the OPEN of bar *t+1***.
   Candle high/low are **never** used as a fill price. (`docs/VALIDATION_METHODOLOGY.md` §1.2.)
2. **Stale-data protection.** No fills on `is_filled` bars — the trade is skipped and retried next decision
   (`meta["n_skipped_stale"]`). Prevents "executing" at a forward-filled price.
3. **Costs applied per trade** = fees + half-spread + sqrt-impact, each × stress multiplier, deducted from cash
   at fill (step 2). **Funding** charged separately (step 1).
4. **No-trade band:** a target change below `min_trade_frac` (0.1% of equity) is not traded — avoids churning on
   noise (lead-lag still hit ~100× annual turnover; see `ALGORITHM_COMPARISON.md`).
5. **Forced exits on delisting:** if `close` goes NaN while holding, the position is liquidated at the last real
   close at **2× cost** (`FORCED_EXIT_COST_MULT`) — models the realistic penalty of exiting a dying market.
6. **Ruin check:** equity ≤ 0 halts the run (no negative-equity compounding).

### 3.1 Cost-stress protocol
Runs at **0× (gross), 1× (base), 1.5×, 2×** via `CostModel.with_multiplier`. A candidate must stay positive at
**2×** to be taken seriously [K]. The lead-lag family is negative **even at 0×** — a *signal* failure, not a
cost failure (see scorecard).

### 3.2 Can this data support the claimed execution speed?
**No, for lead-lag.** The model is self-consistent at 1h (enter next-bar open, realistic 1h frictions), but a
seconds-scale lead cannot be entered at the *next hourly open* — by then the move is long over. Honoring the
master prompt's rule ("do not claim hourly candles prove a minutes-level edge"), the engine therefore does
**not** assert a tradable lead-lag edge from this dataset.

---

## 4. Reproducibility
- Ingest/clean: `engine.data.download` → `engine.data.clean` → `data/cleaned/{bars,funding}/…` + `audit.json`.
- Spreads: `uv run python -m engine.data.spreads` → `data/cleaned/spreads.json`.
- Costs are config-driven (`config/experiment.yaml::costs`) and identical across all backtests.

## 5. Open gaps / blockers
- **1-minute klines** (`futures/um/monthly/klines/<SYM>USDT/1m/`, ~0.5M rows/symbol-year) and **aggTrades /
  bookTicker** for second-level response curves are **not downloaded here** (blocker: data volume & time, not
  capability). Required to test the lead-lag hypothesis at its real time scale.
- **Perp spread sample is thin** (4 days, 2023–24). Widen it before trusting any minute-scale cost claim where
  spread dominates fees.
- **Impact Y=0.7 is a literature default, not fitted to Binance crypto**; order-book data would let it be
  calibrated rather than assumed.
- **Spot spreads are modelled (Abdi–Ranaldo), not quoted** — fine for daily/hourly sizing, inadequate for HF.

## Sources
- https://www.binance.com/en/fee/trading
- https://www.binance.com/en/support/faq/360033544231
