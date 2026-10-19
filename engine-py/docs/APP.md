# Engine app (local explainer)

`engine app [--out reports/app/index.html] [--open]` builds one self-contained HTML file that explains the
whole engine to a non-expert. Open it by double-clicking. It needs no server and makes no network calls.
Everything (CSS, JS, SVG charts, data as JSON) is inline. The page is a local file and is never published
or uploaded.

## Sections
Home (the loop as clickable steps, each with its status, data and command), Market (sparklines,
volatility, funding, regime badge), Signals today, Paper trading (simulated money only), Models (health
traffic lights, prediction vs reality, leaderboard), Research lab (decisions, hypotheses, lead-lag
verdicts, regime summary, H1/H2 holdout status), Data health (integrity, coverage, freshness), Glossary.
Underlined terms show a one-sentence tooltip. A guided tour runs on the first visit only (`localStorage`, wrapped in try/catch). "Done" is
remembered in `localStorage`, and the tour can be replayed from the sidebar.

## Data (read-only, `src/engine/app/collect.py`)
| Section | Files |
|---|---|
| Market | `data/cleaned/bars/perp/{BTC,ETH,SOL,BNB,XRP}.parquet` (last 90 days only), `data/cleaned/funding/*.parquet`, `reports/regimes/labels.parquet` |
| Signals | `data/paper/predictions.jsonl` if present, otherwise the latest paper targets in `data/paper/signals.jsonl` |
| Paper | `data/paper/{equity,fills,signals}.jsonl`, `state.json`, plus each `config/versions/*.yaml` `paper_dir` |
| Models | `experiments/exp_registry.jsonl`, `data/paper/model_health.json`, `data/paper/resolutions.jsonl` |
| Research | `research/hypotheses_seed.yaml`, `experiments/holdout_log.jsonl`, `reports/leadlag/engine/verdicts.csv`, `reports/regimes/summary.md`, `reports/research/batch_001/` |
| Data health | `reports/data_integrity.json`, `data/cleaned/audit.json`, file timestamps |

## Honesty rules
- A value that was not recorded is shown as "not available" with the reason, never as 0. Prediction-ledger
  rows with `reason` "... (no return forecast)" or a `sleeve.*` model id are target weights only; their
  expected move, cost and net edge are treated as missing and they are left out of prediction-vs-reality.
- Signals and paper trading show every version (v001, v002, ...). Trades and funding payments are counted
  separately.
- Lead-lag single-pair verdicts are never shown as an "edge": the registry decision
  (`leadlag_engine:<pair>`), the BH q-value and a multiple-testing caveat are shown next to them.
- Step and section statuses come from evidence (forecasts present, models promoted, data age), not from
  whether a file exists. Statuses have text labels and symbols, not only colour.
- A freshness banner shows market data end, page build time, paper last step and the regime label date
  (research data, before the sealed holdout). Home has a "How to refresh" panel:
  `engine download && engine clean`, `engine data validate`, `engine live step`, `engine monitor resolve`,
  `engine app`.

Missing inputs produce an empty state that names the command that fills them. The collector never makes
up a value. When a number is not recorded (for example the per-coin expected move while only paper
targets exist), the app says "not recorded". Sharpe is shown only after 30 or more hourly steps.

## Safety
JSON is embedded with `<`, `>`, `&` and `://` escaped, so a `</script>` in the data cannot break out of
the script block and no URL scheme appears in the file. `tests/test_app.py` checks this and also checks
that the output contains no `http(s)://`, `src=`, `<link>` or `url(`.

`tests/test_app_browser.py` executes the page in headless Edge/Chrome through `playwright-core` (Node). It
checks for console errors, that every section renders, no "+0.00%" for missing forecasts, no "EDGE EXISTS"
text, no horizontal overflow at 390px, the freshness banner and first-visit-only tour. It is skipped when
Node, playwright-core or a browser is missing. Setup:
`npm install --prefix ~/.cache/engine-app-browser playwright-core@1.47.2` (or set `PLAYWRIGHT_CORE_DIR`).
Set `ENGINE_APP_SHOTS=<dir>` to save screenshots.
