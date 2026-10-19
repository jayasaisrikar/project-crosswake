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

| Decision             | Choice                                                                                                      | Why                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the agent runs | On the OCI box, inside the evidence API process                                                             | The live record is local files; in-process loaders mean no new public data surface and no second unit to supervise                                                                                                              |
| Data access          | A whitelist of seven typed, read-only loaders                                                               | No shell, no SQL, no model-supplied paths, no writes, no money                                                                                                                                                                  |
| Model                | `ASK_MODEL` (falls back to `RESEARCH_MODEL`); set to `opencode/deepseek-v4.1-flash`                         | Chosen for general-question quality at 1-4 s a turn, against 11-87 s for the free LongCat. `resolveModel` now routes each family to the endpoint it is served on: DeepSeek/GLM/Kimi/MiMo/LongCat on chat, GPT/Grok on responses |
| Transport            | `POST /research/chat` behind the existing bearer token and Tailscale Funnel on 443                          | Same door as every other route; no new port, no firewall change                                                                                                                                                                 |
| Chat surface         | A floating launcher pinned bottom-right on every page, plus the dedicated `/ask` page                       | The launcher follows the `#ask` hash, so nav and hero links open it; the first attempt hid the whole thing behind a nav dropdown                                                                                                |
| Env                  | `RESEARCH_API_BASE` + `RESEARCH_API_TOKEN` on the **landing** Vercel project (Production), server-side only | The token never reaches the browser                                                                                                                                                                                             |
| State                | Stateless; the client sends at most six prior turns                                                         | Nothing to persist, nothing to leak                                                                                                                                                                                             |

Tools: `liveStatus`, `strategyRecord`, `recentSignals`, `marketContext`,
`preRegistered`, `researchEvidence`, `publicRecord`. Tool payloads are bounded: the
largest, `recentSignals`, was cut from 21 KB of raw ledger rows to 3.2 KB of
projected signals.

## Guardrails

- Read-only by construction: no tool can write, spawn, spend, or reach a path the
  model chooses. Payment execution is not in this tool set at all.
- Four bounds on the endpoint: request size (8 KB), per-caller rate (4/min, 20/h,
  60/day), a total daily budget (400), concurrency (2), and a 120 s wall-clock cap.
- The model answers any question, but never invents our data. A question about the record is forced
  to read first (`asksAboutRecord` picks the topic); a general question may be answered from
  knowledge; an answer that claims record facts without a read gets one grounded retry and is then
  withheld. It must separate live paper results from backtests and from out-of-sample tests, and it
  never gives advice.
- Answers are rendered as light markdown (bold, dash bullets, paragraphs) by an in-house renderer,
  so no markdown dependency and no HTML injection surface.
- The route answers 401 without `RESEARCH_API_TOKEN`; verified through the public
  funnel.
- A turn that claims our data without reading it is withheld rather than served.
  Two production bugs were found by asking the live site questions, not by reading
  code:
  - the tools handed the model raw epoch milliseconds, and it converted them wrongly
    (v005 "live since 2026-05-02" instead of 2026-10-01). Time fields are now ISO
    strings, so there is nothing for the model to compute.
  - one turn in roughly five answered "the collector is healthy" without reading
    anything (`steps=1 tools=none`). `prepareStep` now forces a tool call on the
    first step, and an ungrounded turn returns a plain refusal instead of a claim.

## Verified

- OpenCode Go inference and tool calling work after the subscription was renewed.
  Go's free models are part of the subscription; Zen's free tier refuses
  non-OpenCode clients outright.
- Offline suite: 21 tests in `tests/ask-agent.test.ts`; 317 across the repo.
- Local end to end through a real browser (`/ask` -> proxy -> agent -> tools -> free
  model), with zero console errors, and mobile at 390 px collapsing to one column
  with no overflow.
- Deployed: box at `48c821c`, landing Production on Vercel with both variables set.
  A question through `https://project-crosswake.vercel.app/api/ask` returns 200 in
  16-28 s, cites the tools it read, and matches the box (v005 forward start
  2026-10-01, NEAR entry 2026-10-12 at 5.896, ATOM exit 2026-10-18 at 1.703,
  collector 7 s late, three pairs).
- After the forced-tool fix, four consecutive live turns all read the record.
- The box restart is clean: `crosswake@api` stops in under a second since
  `closeIdleConnections()`, where a Funnel keep-alive socket previously stalled it
  for 60 s and got it SIGKILLed. The collector was never restarted and its
  `NRestarts` stayed 0 across all three deploys.
- Landing build emits `/ask`, `/docs/ask`, `/api/ask`; nav, sitemap, `llms.txt`,
  changelog and the OG card all resolve.

## Known limits

- Free-model latency is highly variable (measured 11 s to 87 s for the same
  question), so the cap is generous and the UI says so after 20 s.
- `researchEvidence` is thin on the box by design: the walk-forward, study,
  cost-summary and backtest report directories live on the workstation, not in
  production. The agent reports them as absent instead of guessing.
- No conversation memory between visits: each turn carries a bounded history sent
  from the browser only.
- `next dev` rewrites `apps/landing/next-env.d.ts` differently from `next build`, so
  that generated file shows as modified after a local dev run. Revert it; it is not
  part of any change.
- The landing project's `RESEARCH_API_TOKEN` is production-only. Preview deployments
  need the variable added per-branch (`vercel env add ... preview <branch> --yes`).
