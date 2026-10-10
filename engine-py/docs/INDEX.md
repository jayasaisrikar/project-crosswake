# Documentation index

One line per document: where it is, what it is for, and whether it is **current** (maintained, trust it)
or **historical** (a point-in-time snapshot kept for the record; do not update, do not trust numbers
without re-checking). When two documents overlap, the "canonical" one wins.

Start with [`README.md`](../README.md) section 0.

## Root

| Document | Purpose | Status |
|---|---|---|
| `README.md` | Entry point: what the engine is, rules, current state, how to run, project map | current (canonical) |
| `ARCHITECTURE.md` | Module layout of BASELINE_V0 + the research engine built on top | current (canonical architecture) |
| `AUDIT_REPORT.md` | Phase 0 audit: what was wrong before the research engine, and why | historical (2026-10-10 Phase 0); later findings live in `reports/review/` |
| `DATA.md` | Point-in-time data layer (`engine.pit`), integrity checks, PIT universe | current (canonical data doc) |
| `FEATURES.md` | Feature store (`engine.features`) | current |
| `MODELS.md` | Signal model library (`engine.models`) | current (owned by the research workflow) |
| `EXPERIMENTS.md` | Research lab, experiment registry, batches | current (owned by the research workflow) |
| `VALIDATION.md` | Research-engine validation (PBO, DSR, multiple testing) | current (canonical validation doc) |
| `RISK.md` | Ensemble / net edge / NO TRADE / portfolio risk (`engine.ensemble`) | current |
| `LIVE.md` | Live feedback loop: prediction ledger, health, drift | current |
| `RESEARCH_DATABASE.md` | Literature database R-001 ... R-042 | current (reference) |

## docs/

| Document | Purpose | Status |
|---|---|---|
| `docs/INDEX.md` | This map | current |
| `docs/RUNBOOK.md` | Unattended paper trading: deploy, schedule, monitor, recover, incidents | current (canonical ops doc) |
| `docs/APP.md` | The local visual app (`engine app`) | current; `reports/app/index.html` is the single UI (other `reports/*.html` dashboards are generated legacy views, not tracked) |
| `docs/EVENTS.md` | Point-in-time external events | current |
| `docs/REGIMES.md` | Causal regime engine (`engine.regimes`) | current |
| `docs/INSTALLATION_AND_USAGE.md` | Long-form install + command guide (`uv sync --frozen`) | current; README section 11 is the short version |
| `docs/OPERATIONS_AND_RISK.md` | Strategy-level risk rules and original operations notes | partly superseded: unattended operation is canonical in `docs/RUNBOOK.md` |
| `docs/AUDIT.md` | Output of the independent data + accounting audit (`python -m engine.audit`) | current for the audit tool; the FTT FAIL is fixed by the 2026-10-10 data rebuild |
| `docs/DATA_AND_EXECUTION_MODEL.md` | Datasets, microstructure, cost / execution assumptions | current (cost model); data layer details in `DATA.md` |
| `docs/STRATEGY_SPECIFICATION.md` | Trend / carry signal pipeline, parameters, decisions | current (BASELINE_V0 strategies) |
| `docs/VALIDATION_METHODOLOGY.md` | Bias prevention + statistics for the BASELINE_V0 backtests | current for BASELINE_V0; research-engine validation is `VALIDATION.md` |
| `docs/TRIAL_LEDGER.md` | Every trial run against the baseline strategies | current (append-only record) |
| `docs/RESEARCH.md` | Index + summary of `docs/research/` | current (reference) |
| `docs/research/01..05_*.md` | Literature / feasibility notes and the 2026-10-09 dev-period results | historical research notes (2026-10-09) |
| `docs/LEADLAG_ENGINE.md` | Multi-method lead-lag study (`engine.leadlag.engine`, `methods`) | current (canonical lead-lag doc) |
| `docs/LEADLAG.md` | First BTC → alt impulse experiment (`engine.leadlag.study`, `events`, `backtest_leadlag`, `scorecard`) | historical/legacy stack, superseded by `docs/LEADLAG_ENGINE.md` |
| `docs/LEAD_LAG_RESEARCH_REVIEW.md` | Lead-lag literature review | current (reference) |
| `docs/ALGORITHM_COMPARISON.md` | Lead-lag candidate families and the pre-registered scorecard | historical (legacy lead-lag stack) |

### Lead-lag code stacks

* **Canonical:** `engine.leadlag.engine` + `engine.leadlag.methods` (+ `predictive.py` helpers) → `reports/leadlag/engine/`.
* **Legacy (kept, still tested):** `engine.leadlag.{study,events,backtest_leadlag,scorecard}` → older `reports/leadlag/*.csv`.
* **Live signal:** `engine.signals.leadlag` (strategy `leadlag`, disabled in `config/experiment.yaml`).
* Removed 2026-10-10: `engine.leadlag.research_predictive` (unreachable, 0 % coverage).

## docs/archive/ (historical snapshots, unedited apart from a header)

| Document | Was | Superseded by |
|---|---|---|
| `docs/archive/FINAL_REPORT.md` | Lead-lag engine final report (2026-10-09) | `docs/LEADLAG_ENGINE.md`, `reports/leadlag/engine/verdicts.md`, README section 7 |
| `docs/archive/REVIEW_FOR_CHATGPT.md` | Build description written for an external review | `README.md`, `ARCHITECTURE.md`, `reports/review/` |
| `docs/archive/CURRENT_ENGINE_AUDIT.md` | Audit of the pre-research engine | `AUDIT_REPORT.md`, `docs/AUDIT.md`, `reports/review/` |
| `docs/archive/ARCHITECTURE.md` | Detailed BASELINE_V0 architecture (duplicate of the root file's scope) | `ARCHITECTURE.md` (root) |

## Reports that are documents

| Path | Purpose | Status |
|---|---|---|
| `reports/baseline_v0/` | Frozen BASELINE_V0 snapshot (never overwrite) | historical by design |
| `reports/review/01..06_*.md` | Independent review round (research, data, operations, engineering, benchmark, app) | current findings |
| `reports/research/batch_001/` | First experiment batch | INVALIDATED (see `INVALIDATED.md`) |
| `reports/research/batch_002/` | Second batch | see `results.md` when written |

Generated outputs (`reports/*.html`, `reports/app/index.html`, large trade/event CSVs, `logs/`) are gitignored:
rebuild them with the engine commands in README section 11.
