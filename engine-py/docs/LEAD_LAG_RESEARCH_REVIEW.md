# LEAD_LAG_RESEARCH_REVIEW — BTC → altcoin lead-lag literature

Master-prompt §3. Independent review of the published evidence for a tradable BTC→altcoin lead-lag
relationship, the methods used to measure it, and how that evidence maps onto this engine's hourly data.
Written 2026-10-09.

**Verification legend:** **[V]** = the claim/URL was checked by web search in *this* session (2026-10-09);
**[K]** = established result I know from the literature and that the repo's prior research docs already
cite — re-open the PDF before quoting a number externally. **No number attributed to a source below was
produced by our engine.** A separate, clearly-marked section reports our own experimental findings.

Three evidence buckets are kept strictly apart, per the master prompt:
1. **Published evidence** — what peer-reviewed / preprint sources actually report.
2. **Interpretation** — my reading of what that implies for *this* project.
3. **Repo findings** — what our own code and experiments produced (reproducible from `reports/leadlag/`).

---

## 1. Published evidence

### 1.1 The lead-lag effect is real but lives at seconds-to-minutes scale
The consistent message of the high-frequency literature is that BTC leads other coins, but the lag is
**seconds to a few minutes** and decays quickly.

- **Price Transmission from Bitcoin to Altcoins: High-Frequency Evidence and Implications for Trading
  Strategy** (*Asia-Pacific Financial Markets*, 2026). Uses cross-correlation functions, Granger-causality
  tests and VAR on high-frequency data; reports that **small-cap** altcoins show statistically significant
  **delayed** responses to BTC moves, and frames this explicitly as a candidate trading signal. [V]
  https://link.springer.com/article/10.1007/s10690-026-09589-z (full text gated; summary from abstract/index).
- **Bitcoin, Ethereum, and the Ambiguity of Price Discovery: A Multi-Measure High-Frequency Analysis**
  (*J. Risk Financial Manag.* 19(9):678, 2026). Four years of **1-minute Coinbase** trades (2022–2025),
  multiple rolling price-discovery / spillover / predictability measures. Headline: **which asset "leads"
  depends on the measure chosen.** Short-horizon return predictability after extreme moves is **asymmetric**
  — ETH shows continuation-type predictability after large *positive* shocks at horizons **up to ~30 min**
  (strongest at 1–5 min), while BTC shows none at any horizon tested. [V]
  https://www.mdpi.com/1911-8074/19/9/678
- **A tick-by-tick level measurement of the lead-lag duration** (*Investment Management and Financial
  Innovations*, 2023). Ultra-HF tick data, BTC vs Cardano: estimated lead **16–118 seconds, mean ≈ 57 s**. [V]
  https://businessperspectives.org/images/pdf/applications/publishing/templates/article/assets/17735/IMFI_2023_01_Anderson.pdf
- **High-Frequency Lead-Lag Relationships in the Bitcoin Market** (CBS thesis, 2019). Tick data across
  exchanges: one venue's BTC price follows another with a lag **up to ~15 s**. [V]
  https://research.cbs.dk/en/studentProjects/high-frequency-lead-lag-relationships-in-the-bitcoin-market-an-em/
- **Lead-Lag Relationship between Bitcoin and Ethereum: Evidence from Hourly and Daily Data** (Monash,
  2019). At coarser (hourly/daily) frequency the relationship is weak/ambiguous — consistent with the effect
  having already decayed by the time you aggregate to an hour. [V]
  https://research.monash.edu/en/publications/lead-lag-relationship-between-bitcoin-and-ethereum-evidence-from-/
- **Price discovery in bitcoin spot and futures markets** (*J. Int. Money & Finance*, 2025) and related
  Hayashi–Yoshida work: the **CME bitcoin futures** market tends to lead price formation. [V]
  https://ideas.repec.org/a/eee/jimfin/v159y2025ics0261560625001500.html

### 1.2 A large share of apparent lead-lag is a *measurement artifact* (Epps effect)
Non-zero lagged cross-correlations at short sampling horizons are partly a statistical artifact of
**asynchronous trading / nonsynchronous ticks**, not genuine predictability. This is the Epps effect.

- **On the origin of the Epps effect** (arXiv physics/0701110) and **The Epps effect revisited**
  (arXiv 0704.1099): correlations fall at short windows; asynchronicity of ticks is a dominant driver and
  *promotes spurious lagged cross-correlations*. Using only synchronous ticks sharply reduces the effect. [V]
  https://arxiv.org/abs/physics/0701110 · https://arxiv.org/pdf/0704.1099

### 1.3 Context: price discovery, momentum, and overfitting (already cited in repo research docs)
- BTC price-discovery dominance over the broad crypto market. [K] (Bitwise/NYSE Arca price-discovery
  white paper, 2021) https://static.bitwiseinvestments.com/Bitwise-Bitcoin-ETP-White-Paper-1.pdf [V]
- Time-series momentum survives costs where cross-sectional does not — relevant because an impulse-
  continuation signal is a short-horizon TSMOM in disguise (Han, Kang & Ryu; Liu & Tsyvinski RFS 2021). [K]
- Multiple-testing / overfitting toolkit that governs how any lead-lag claim must be judged: Deflated Sharpe
  and PBO/CSCV (Bailey & López de Prado), the ~t>3 factor hurdle (Harvey, Liu & Zhu RFS 2016), and the
  888-algorithm backtest-to-live gap (Wiecki et al. 2016). [K] — see `docs/research/03_*` and
  `docs/VALIDATION_METHODOLOGY.md`.

---

## 2. Interpretation (mine, for this project)

1. **The effect the literature documents is not the effect our data can trade.** Every source that finds a
   *tradable-looking* BTC→alt delay measures it at **seconds to minutes**. Our dataset is **1-hour bars**. An
   hourly bar cannot resolve a lag shorter than one hour; a genuine 60-second lead is fully contained inside a
   single bar and shows up only as a within-bar co-move, never as a next-bar signal.
2. **Direction of the edge matters.** The one recent source closest to "tradable" (MDPI 2026) finds
   *continuation* predictability concentrated in **ETH after positive shocks, at 1–30 min**, and **asymmetric**
   (sign- and asset-dependent). That is a narrow, fragile, HF effect — not a robust symmetric "alts follow BTC"
   rule, and not something hourly bars capture.
3. **Asynchrony warning applies directly to us.** Cross-exchange / cross-pair asynchronicity (Epps) means a
   naive lagged correlation can *invent* a lead that is really just stale prints. Our `is_filled` masking and
   same-venue (Binance) sampling mitigate this, but it is the reason a positive lagged correlation must clear a
   much higher bar than statistical significance before being called an edge.
4. **Where any residual edge would live:** finer data (1m klines, aggTrades, bookTicker) on the small-cap tail,
   long side, with a hard latency budget — exactly the regime the engine's hourly archive cannot test. So the
   honest research answer at our resolution is a *negative* one, with a clearly-scoped path to re-test at 1m.

---

## 3. Repo findings (our own experiments — reproducible)

Source code `src/engine/leadlag/`, config `config/leadlag.yaml` (pre-registered), outputs `reports/leadlag/`.
Reproduce the study with `uv run python -m engine.leadlag.study`. Event detection is causal by construction
(impulse threshold uses trailing 720-bar vol, `shift(1)`; forward-return labels are never fed back as signals —
see `events.py` docstring). Full method and tables: `docs/LEADLAG.md`.

**Event study (BTC impulse → alt forward return, signed by impulse direction, mean bps / HAC-t):**

| cell | gap (in-bar) | raw_1 | abn_2 | abn_24 | n events |
|---|---|---|---|---|---|
| k=2 dev (≤2024-06-30) | **+14.2 / t 5.01** | −4.4 / −1.39 | −5.2 / −2.21 | −24.4 / −2.92 | 2071 |
| k=2 holdout | +3.1 / 1.08 | +0.2 / 0.05 | −1.9 / −0.71 | +7.2 / 0.92 | 1072 |
| k=3 dev | **+31.6 / t 5.17** | −3.0 / −0.47 | −7.1 / −1.57 | −23.5 / −1.60 | 775 |

- **In-bar `gap` is strongly positive and significant** (alts under-react *within* the impulse hour) but is
  realized inside the bar that defines the event — it is **not executable** at hourly resolution.
- **Every forward (post-close) outcome is ≤ 0 in dev**, several significantly negative (mild
  overshoot/reversal, not delayed follow-through). Holdout shows essentially nothing.
- **Lagged cross-correlation** `corr(r_BTC[t−L], r_alt[t])` (`xcorr_by_year.csv`): L=0 ≈ 0.64–0.75 every year;
  **L=1 small and negative** (≈ −0.01 to −0.05), drifting toward 0 over time. Co-movement is contemporaneous.
  This matches §1.1/§1.2: at 1h the lead has already decayed and what remains is slight reversal + noise.
- **Granger / rolling-lag / OOS tests** (`predictive.py`, `reports/leadlag/predictive_*.csv`): lagged BTC,
  controlling the alt's own lags with HAC inference and Benjamini-Hochberg FDR @0.10, is significant for
  **0 of 13** followers; the best rolling BTC→alt lag is **0 (contemporaneous) for all 13** (stable, lag_std≈0);
  and the incremental out-of-sample R² of adding BTC lags is **negative for all 13**. Lagged BTC carries no
  usable forward information at 1h.
- **Confirmatory backtest** (`backtest_leadlag.py`, `strategy_comparison.csv` / `scorecard.csv`): all 6
  pre-registered variants lose heavily on dev (total return −96% to −99.95%, Sharpe −1.8 to −4.2), the
  reversion variant also loses (Sharpe −2.95), and the **zero-trading-cost ("gross") run of k=2/h=1 still loses**
  (total return −80%, Sharpe −0.74). An impulse strategy has **no edge even before costs** on hourly bars in
  either direction; costs only deepen the loss. The pre-registered scorecard gate returns `NO EDGE`. Baselines
  on the same window: trend Sharpe 1.08, BTC buy-&-hold 1.05.

**Verdict (repo + literature agree): no tradable BTC→altcoin lead-lag edge at 1-hour resolution.** The
pre-registered gate (dev forward outcome positive with t>2) failed; the production config keeps `leadlag`
`enabled: false`. The in-bar under-reaction is genuine but un-executable at this frequency.

---

## 4. Open gaps / what would change the verdict
- **Resolution.** Re-test at **1-minute klines** (lookbacks ×60, horizons 1–30 min) and, for a few event days,
  **aggTrades + bookTicker** for second-level response curves. None of that data is downloaded here (blocker:
  volume/time, not capability). This is the single highest-value next experiment.
- **Universe.** Literature edge concentrates in **small-caps**; our universe is 16 large caps. A point-in-time
  small-cap universe at 1m could legitimately change the answer — and would need strong survivorship controls.
- **Doc tension to flag:** `docs/LEADLAG.md` predates the executable strategy and states no backtest was run;
  `backtest_leadlag.py` + `predictive.py` now *do* run confirmatory backtest and Granger/OOS tests. The two are
  consistent in conclusion (no edge); `LEADLAG.md` is retained as the original pre-registration record.
- **Statistical caveat:** significance of the in-bar `gap` is not an edge; multiple cells (k×horizon×year) were
  examined, so any single significant forward cell must survive the multiple-testing controls in
  `docs/VALIDATION_METHODOLOGY.md` before being believed.

## Sources
- https://link.springer.com/article/10.1007/s10690-026-09589-z
- https://www.mdpi.com/1911-8074/19/9/678
- https://businessperspectives.org/images/pdf/applications/publishing/templates/article/assets/17735/IMFI_2023_01_Anderson.pdf
- https://research.cbs.dk/en/studentProjects/high-frequency-lead-lag-relationships-in-the-bitcoin-market-an-em/
- https://research.monash.edu/en/publications/lead-lag-relationship-between-bitcoin-and-ethereum-evidence-from-/
- https://ideas.repec.org/a/eee/jimfin/v159y2025ics0261560625001500.html
- https://arxiv.org/abs/physics/0701110
- https://arxiv.org/pdf/0704.1099
- https://static.bitwiseinvestments.com/Bitwise-Bitcoin-ETP-White-Paper-1.pdf
