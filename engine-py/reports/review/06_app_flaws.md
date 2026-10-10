# 06 - App flaw audit (reports/app/index.html)

Method: headless Edge (playwright-core 1.47.2 driving the installed msedge), 1440x900 and 390x844, light and dark.
I went through all 8 nav sections, all 9 tour steps, all 11 loop steps, and checked tooltips and keyboard Tab.
Screenshots are in the session scratchpad `shots/` (`{d|m}_{light|dark}_{section}.png`, `tour1..9.png`, `tip.png`).
No console errors or page errors in any of the 4 runs. Load time is about 0.2 s.
Numbers were recomputed with `.venv` pandas: BTC 90d daily-resampled change +33.58% (matches the app), 30d vol 34.9% (app shows 35%), funding APR +2.74% (app shows +2.7%), integrity 365/124 (matches).

## Signals today
1. **BLOCKER**: Missing forecast fields are shown as real zeros. Where: script.py:217-219, collect.py:216-218. The predictions in `data/paper/predictions.jsonl` are `expected_return/expected_cost/expected_net_edge = 0.0` with `reason: "sleeve target weight (no return forecast)"`. Every card shows "Expected move +0.00%, Cost 0.00%, Net edge +0.00%" next to "Buy". That reads as "buying with zero edge". Evidence: d_light_signals.png. Fix: in collect, set these fields to None when the reason contains "no return forecast" or `model_id` starts with `sleeve.`. Better, add a `has_forecast` flag and render "not recorded (target weight only)". Show `features.weight` instead.
2. **HIGH**: Step 6, "Is the edge worth the cost?", shows status "Working". Where: script.py:121. Status is ok only because predictions.jsonl exists, but there is no edge or cost check in it. Fix: set ok only if a card has a non-null net_edge. Otherwise use warn with the text "no cost-vs-edge forecasts yet".
3. **MEDIUM**: The cards cover v001 only (13 coins). v002's 36 positions never appear, and nothing tells the user. Where: collect.py:205-238. Fix: label the section with the version or group cards per version.
4. **LOW**: Timestamps like "2026-10-10T09:00" have no zone and keep the raw "T". Where: script.py:221, 245, 241-242. Fix: use one `fmtTs()` that gives "YYYY-MM-DD HH:MM UTC".

## Market and staleness
5. **HIGH**: Nothing says the market data is not live. Prices end 2026-09-30 23:00 but the app was generated 2026-10-10, 10 days later, while paper trades use 2026-10-10 prices (BTC entry 82,760 vs "last" 83,576.90). The page has no stale banner. "Signals today" and "What the market is doing" imply the data is current. Where: script.py:187-200, collect.py:89-128. Fix: compute days between generated_at and asof. If more than 1, show a banner on Home and Market: "Market data ends 2026-09-30 (10 days old). Run `engine download && engine clean`, then `engine app`."
6. **HIGH**: The "Current regime" label is a year old. Labels end 2025-09-30 (before H2) but appear as the current badge on Market and on the Home "At a glance" card. Where: script.py:162, 190. Fix: rename to "Last labelled regime (Sep 2025, research data only)", use a muted tone, and add the age on Home.
7. **LOW**: The "90d" change starts from the 2026-07-03 daily close. The true 90-day change is +35.8% vs the +33.6% shown. Where: collect.py:99-115. Fix: compute from the hourly close at end-90d, or label it "since Jul 3".
8. **LOW**: The big price has no currency ("83,576.90"). Where: script.py:198. Fix: prefix with $ or add "USDT".

## Paper trading
9. **HIGH**: Funding payments are counted as trades. "Trades (fills) 51" is 22 buys, 3 sells and 26 funding events. The "Latest simulated trades" table shows only funding rows, with Side "funding" in red, Size "—" and cost "$-0.01". Where: collect.py:190-194, script.py:238, 245. Evidence: d_light_paper.png. Fix: split trades from funding and show "costs $21.18, funding $0.76" separately. Exclude funding from the trades table or style it neutrally. Format negatives as "-$0.01 (received)".
10. **MEDIUM**: "Hours in profit 71%" comes from 7 steps and uses the Win rate tooltip. Where: script.py:237. Fix: show "—" under 30 steps (same rule as Sharpe) and add its own glossary entry.
11. **MEDIUM**: "$100,000" is hardcoded in the lede and the tour. Where: script.py:227, 375. Fix: use `p.initial`.
12. **LOW**: equity.jsonl has 12 rows but only 8 unique timestamps. The duplicates are dropped silently. Where: collect.py:134-138. Fix: report the duplicate count in Data health.
13. **LOW**: The drawdown axis reads "+0.00%". Where: script.py:242. Fix: format zero as "0%".

## Models
14. **HIGH**: The Prediction-vs-reality scatter is meaningless right now. Every predicted value is 0, so all 26 dots sit on one vertical line. The caption still promises accuracy and direction readings. The axes have no ticks or units. Where: script.py:82-92, 263. Evidence: m_dark_models.png. Fix: exclude predictions that have no return forecast, and show an empty state if none remain. Add % tick labels.
15. **MEDIUM**: WATCH is described as "Promising but not proven", but those rows show "failed: dsr; failed: perturbation", which sends mixed signals. Where: script.py:253, 269. Fix: rename the column "Gates failed" and reword WATCH as "failed some gates; not tradeable".
16. **MEDIUM**: The nav status dots are colour-only and `aria-hidden`. The amber Models dot is never explained. Where: script.py:141, 329. Fix: add sr-only text and a title.

## Research lab
17. **BLOCKER**: Lead-lag BTC->ADA is shown as a green "EDGE EXISTS" chip, with a summary chip "EDGE EXISTS: 1". The registry marks the same strategy WATCH (DSR and perturbation failed). 43 pairs were tested and no multiple-testing caveat is shown. Where: script.py:293-295, collect.py:288-291. Fix: override the verdict with the registry decision for `leadlag_engine:<pair>`. Rename the raw verdict "passed single-pair test (before multiple-testing correction)" in warn tone. Add: "43 pairs tested; 1 pass is consistent with chance; DSR failed."
18. **MEDIUM**: The H1 text "Viewed 5 time(s) since 2024-07-01" uses the holdout start as if it were the first view date. The views all happened on 2026-10-09. Where: script.py:281, collect.py:322. Fix: "Holdout from 2024-07-01; opened 5 times (first 2026-10-09)", and list the reasons.
19. **MEDIUM**: The Home card "12 experiments, 0 promoted, 5 rejected" leaves out 3 WATCH and 4 INCONCLUSIVE. The counts themselves match the registry. Where: script.py:160. Fix: show all four counts.
20. **LOW**: The regime summary is wide raw markdown in a `<pre>`. It is unreadable for non-experts and overflows on mobile. Where: script.py:298. Fix: wrap it in `overflow:auto` and add a short plain summary.
21. **LOW**: The batch card is a bare file list with no explanation. Where: script.py:299.

## Home / loop
22. **HIGH**: The grey ("No data yet") status dot on Step 10 renders as a big dashed circle. Its class `empty` collides with the `.empty` empty-state style (padding 18px, dashed border). Where: script.py:155, render.py:423/440. Evidence: d_dark_home.png. Fix: rename the class to `st-empty`, or add `.dot.empty{padding:0;border:0}`.
23. **MEDIUM**: The Step 3 "Features" status comes from the experiment count, which is a proxy. Where: script.py:115. Fix: use a real feature artifact, or show a neutral status.
24. **MEDIUM**: Links use the browser's default blue. "Open the related section" has low contrast in dark mode. Where: script.py:171, APP_CSS. Evidence: d_dark_home.png. Fix: add `a{color:var(--accent)}`.
25. **LOW**: The pulse loops forever every 900 ms until the user clicks a step. Reduced motion is respected. Where: script.py:349. Fix: stop after one cycle.

## Data health
26. **HIGH**: The "Coins affected" column shows 365, but that counts issue rows across spot and perp; there are 207 unique symbols. The meaning of the issue ("zero-volume flat 'real' bars not flagged is_filled") is not shown. "Most issues concern small or delisted coins" is hardcoded and never checked. Where: script.py:310, collect.py:334-339. Fix: rename the column "Issue rows" and add a unique-symbol count. Show `detail`. Compute and show how many issues touch the traded universe.
27. **MEDIUM**: The red "critical 365" and "Issues found" give no next step or plain explanation. Fix: add one sentence on what "frozen" means and the command to re-check.
28. **LOW**: Timestamp formats are mixed: "2026-10-09T17:05+00:00" vs "2026-10-10 10:39 UTC". Where: collect.py:71. Fix: use one formatter.

## Regenerate flow
29. **HIGH**: The page never says how to refresh. The footer shows only "Generated ...". Where: render.py:502. Fix: "Snapshot, not live. Refresh: run `engine app` (after `engine download && engine clean` / `engine live step`)". Also show how old it is.

## Responsiveness / accessibility
30. **HIGH**: At 390px there is horizontal page overflow: Models +457px, Data +292px, Research +252px, Paper +3px (measured from scrollWidth). The sticky mobile nav covers the top of each section. Evidence: m_dark_models.png. Fix: make tables scroll (`.wrap{overflow-x:auto;max-width:100%}`) and set `pre{white-space:pre-wrap}`. Add `scroll-margin-top` / `padding-top` under the sticky bar.
31. **MEDIUM**: The tour dialog has no `aria-modal` and no focus trap, and `aria-live` sits on the dialog itself. When the tour ends the user is left on Glossary and focus is not returned. Where: script.py:384-396, render.py:507. Fix: return focus to `#tourBtn` and `go('home')` on end, and add `aria-modal`.
32. **MEDIUM**: `.term` elements have no `aria-describedby="tip"`, so screen readers do not announce the tooltip. The click handler has duplicate `hideTip` branches. Where: script.py:363-366.
33. **LOW**: Step and nav dots convey status by colour only. Where: script.py:155, 329.

## Tests
34. **MEDIUM**: tests/test_app.py never runs the JS, so #1, #14, #17, #22 and #30 cannot be caught. Fix: add a headless smoke test that asserts no page errors and non-empty sections, that no "+0.00%" appears for no-forecast cards, and that there is no horizontal overflow at 390px.
