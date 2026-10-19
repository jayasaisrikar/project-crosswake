# Crosswake — live-data chat agent

Status doc for this build. Later scope (not built): the same tool registry driving
auto-posting to X.

## What exists now

An agent that reads Crosswake's **live** production record directly, and a public
page visitors can question.

| Piece                             | Where                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Read-only live-data tools         | `packages/research-runtime/src/agent-tools.ts`                                       |
| Instructions, agent, bounded turn | `packages/research-runtime/src/agent.ts`                                             |
| Gated `POST /research/chat`       | `packages/research-runtime/src/ask-api.ts`                                           |
| Mounted in the evidence API       | `packages/research-runtime/src/evidence-api.ts`, `apps/api/src/main.ts`              |
| Server-side proxy                 | `apps/landing/app/api/ask/route.ts`                                                  |
| Chat console + page               | `apps/landing/components/crosswake/ask-console.tsx`, `apps/landing/app/ask/page.tsx` |
| Public copy                       | `apps/landing/lib/docs.ts`, `lib/changelog.ts`, `app/llms.txt/route.ts`              |
| Tests                             | `tests/ask-agent.test.ts`                                                            |

## Decisions

| Decision             | Choice                                                                                                       | Why                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Where the agent runs | On the OCI box, inside the evidence API process                                                              | The live record is local files; in-process loaders mean no new public data surface and no second unit to supervise |
| Data access          | A whitelist of seven typed, read-only loaders                                                                | No shell, no SQL, no model-supplied paths, no writes, no money                                                     |
| Model                | `opencode/<id>` on the OpenCode Go gateway, default `opencode/longcat-2.5-preview-free` via `RESEARCH_MODEL` | Free tier on Go, and it calls tools correctly                                                                      |
| Transport            | `POST /research/chat` behind the existing bearer token and Tailscale Funnel on 443                           | Same door as every other route; no new port, no firewall change                                                    |
| Chat surface         | `apps/landing` at `/ask`, proxied server-side                                                                | The token never reaches the browser                                                                                |
| State                | Stateless; the client sends at most six prior turns                                                          | Nothing to persist, nothing to leak                                                                                |

Tools: `liveStatus`, `strategyRecord`, `recentSignals`, `marketContext`,
`preRegistered`, `researchEvidence`, `publicRecord`. Tool payloads are bounded: the
largest, `recentSignals`, was cut from 21 KB of raw ledger rows to 3.2 KB of
projected signals.

## Guardrails

- Read-only by construction: no tool can write, spawn, spend, or reach a path the
  model chooses. Payment execution is not in this tool set at all.
- Four bounds on the endpoint: request size (8 KB), per-caller rate (4/min, 20/h,
  60/day), a total daily budget (400), concurrency (2), and a 120 s wall-clock cap.
- The model may only phrase what the tools returned, must separate live paper
  results from backtests and from out-of-sample tests, and says so when the record
  does not cover a question.
- The route answers 401 without `RESEARCH_API_TOKEN`; verified through the public
  funnel on the deployed (older) box, where the token check precedes route dispatch.

## Verified

- OpenCode Go inference and tool calling work after the subscription was renewed.
  Go's free models are part of the subscription; Zen's free tier refuses
  non-OpenCode clients outright.
- Offline suite: 16 new tests in `tests/ask-agent.test.ts`; 312 across the repo.
- Local end to end through a real browser (`/ask` -> proxy -> agent -> tools -> free
  model): a question about v005 returned its live open position, its one closed
  trade and the frozen backtest confidence interval, and cited `read: strategy record`.
  Zero console errors. Mobile at 390 px collapses to one column with no overflow.
- Live answers match the box byte for byte (NEAR 5.896 -> 5.063, -1442.8 bps; ATOM
  exit 1.703, -1787 bps; collector memory 199 MB, lateness 7 s).
- Landing build emits `/ask`, `/docs/ask`, `/api/ask`; nav, sitemap, `llms.txt`,
  changelog and the OG card all resolve.

## Still to do

1. Commit and deploy the box. Only `crosswake@api` changes; no collector restart.
2. Add `RESEARCH_API_BASE` and `RESEARCH_API_TOKEN` to the **landing** Vercel project
   and redeploy, or `/api/ask` answers 503 `ask_not_configured`.
3. Vercel function duration: a free-model turn can run 30-120 s, so the route sets
   `maxDuration = 160`. Confirm the plan allows it, then ask a real question through
   the deployed site to be sure it returns 200 rather than a platform timeout.

## Known limits

- Free-model latency is highly variable (measured 14 s to over 60 s for the same
  question), so the cap is generous and the UI says so after 20 s.
- `researchEvidence` is thin on the box by design: the walk-forward, study,
  cost-summary and backtest report directories live on the workstation, not in
  production. The agent reports them as absent instead of guessing.
- No conversation memory between visits: each turn carries a bounded history sent
  from the browser only.
