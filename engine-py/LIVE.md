# LIVE feedback loop (paper only)

Everything is local. No notifications, no remote services, no uploads. The research dashboard is a
static file you open from disk.

## Loop

1. **Log** every model prediction: `Ledger(<ledger dir>).append(preds, entry_prices)` writes
   `Prediction.to_record()` + `signal_id` + `entry_price` to `<ledger dir>/predictions.jsonl`
   (append-only; a `signal_id` = hash(model, asset, timestamp, horizon) is written once). The hourly
   step logs each sleeve as `<version>/sleeve.<name>` (e.g. `v002/sleeve.trend`; `sleeve.<name>` when
   unversioned), so versions never merge. Appends are one fsync'd write; a torn last line left by a
   crash is quarantined to `<file>.torn` before the next append.
2. **Resolve** at expiry: `resolve(ledger, prices, now)` appends to `<ledger dir>/resolutions.jsonl`
   (keyed by `signal_id`): exit price (last price <= expiry, and at most `max_gap_hours` = 2 bars
   older than expiry, otherwise the row stays unresolved), realized/signed/net return, error vs
   expected return, hit. Prediction lines are never edited. The live step resolves every hour;
   `engine monitor resolve` uses the live feed (never the frozen `data/cleaned` alone) per version.
3. **Measure** (`engine.monitor.metrics`): hit rate, expectancy (net of expected cost), mean error,
   calibration (reliability table + ECE), Sharpe and rolling Sharpe, per model / regime / confidence bucket.
4. **Health** (`engine.monitor.health`, rules in `config/health_rules.yaml`): score 0-100 →
   ACTIVE / WARNING / REDUCED / QUARANTINED / RESEARCH. Downgrades can skip states, upgrades go one
   step at a time with a recovery margin, `quarantine_to_research` consecutive QUARANTINED evaluations
   move a model to RESEARCH, which is sticky until `HealthBook.reinstate(model, now, reason)`.
   Models are never deleted. Each state has a `size_multiplier` for the risk/ensemble layer;
   `reinstate` restores the REDUCED multiplier. State: `<ledger dir>/model_health.json` (atomic
   write; an unreadable file makes the ensemble layer HOLD, never default to 1.0); history:
   `<ledger dir>/model_health.jsonl`. `engine monitor resolve` re-scores every running version.
5. **Drift** (`engine.monitor.drift`): PSI/KS on feature distributions, Page-Hinkley on the error
   stream, and shifts in BTC-alt correlation, funding level/sign, vol and liquidity. Each drift event
   appends a `new_hypothesis_request` to `research/triggers.jsonl` (deduped per day).
6. **Leaderboard** (`engine.monitor.leaderboard`): joins `experiments/exp_registry.jsonl` (latest row
   per canonical id `model_version|hypothesis_id`, `exp_id` = the registry `id`; legacy rows keep
   `model_id`; missing file/keys tolerated) with live ledger stats and health of every running
   version. A version's optional `research_model_ids` links its live sleeves to registry rows. Ranked by mean
   percentile rank over OOS Sharpe, live Sharpe, max DD, expectancy, calibration, cost robustness,
   regime robustness, parameter stability and health. Return is shown but never ranks.
   Output: `reports/leaderboard.md`, `reports/leaderboard.csv`.
7. **Dashboard** (`engine.monitor.dashboard.build_default`): `reports/research_dashboard.html`
   with MARKET, SIGNALS, MODELS, PAPER TRADING, RESEARCH; light/dark via `prefers-color-scheme`.

## Files

| Path | Writer | Mode |
|---|---|---|
| <ledger dir>/predictions.jsonl | ledger | append-only |
| <ledger dir>/resolutions.jsonl | ledger.resolve | append-only |
| <ledger dir>/model_health.json / .jsonl | health | latest state (atomic) / append-only history |
| <ledger dir>/fills, equity, signals .jsonl + state.json | paper step | one transaction per step (journal.json) |
| <ledger dir>/audit.jsonl | `engine live recover` / `reset-kill` | append-only |
| logs/heartbeat.json, logs/health.json, logs/alerts.log | step / `engine health --alert` | latest / latest / append |
| research/triggers.jsonl | drift.write_triggers | append-only |
| reports/leaderboard.{md,csv}, reports/research_dashboard.html | leaderboard / dashboard | regenerated |

`<ledger dir>` = a version's `paper_dir` (`data/paper` for v001, `data/paper/v002` ...).
Operations (deploy, schedule, monitor, recover, secrets, incidents): see docs/RUNBOOK.md.

External events: see docs/EVENTS.md.
