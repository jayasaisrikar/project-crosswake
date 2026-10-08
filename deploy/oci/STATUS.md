# Crosswake OCI migration status

Updated 8 October 2026, 18:35 IST. Tracks moving the backend off the laptop onto an
Oracle Cloud Ampere VM, with the dashboard deployed to Vercel.

## Current state

**Deployed and collecting on OCI.** The Ampere instance (`129.159.224.68`) runs six
backend units under systemd from `/opt/crosswake` — `collector`, `api`, `signals-spot`,
`signals-perp`, `costs`, `context` — with `dashboard` deliberately inactive. Verified
after install: collector `connected: true` on BTC/ETH/SOL, `late: 0`, `rejected: 0`,
211.8 MB RSS, fresh journal `2026-10-08-d90302d6`, and `NRestarts: 0` on every unit.

The instance is provisioned at **1 OCPU / 6 GB with a 45 GB boot volume**, not the agreed
2 OCPU / 12 GB and 150 GB. Those are OCI control-plane changes and cannot be made over
SSH — the box has no API credentials.

**The disk has been fixed.** The boot volume was grown to 150 GB in the console, then the
guest was rescanned (`/sys/class/block/sda/device/rescan`), the partition extended with
`growpart /dev/sda 1` and the filesystem grown online with `resize2fs`. The layout happened
to be the easy case — root (`sda1`) is the *last* partition, with the free space directly
after it, so no partition shuffling was needed. `df` now reports 145 GB total, 141 GB free.

Growth is **~5–7 GB/day** (two measurements: 5.14 and ~7.3; market activity varies), so
141 GB is roughly **3–4 weeks**. All seven units stayed healthy through the resize.

Measured consumption against the Always Free caps: A1 at 1/6 of 2/12 (50%), block volume
150 of 200 GB (75%), egress 25.8 GB/month of 10 TB (0.26%). A full disk **cannot** produce
a bill — block volumes do not auto-expand — it just stops the collector. The only ways to
be charged are creating or expanding resources past these caps.

CPU is not the constraint: all six units together sit around **0.3% CPU** with `late: 0`,
so the shape resize is optional rather than necessary.

The laptop stack was stopped, then restarted to demo the workbench, so **both machines
currently collect BTC/ETH/SOL** into separate data directories.

`deploy/` is untracked, so `setup.sh` now copies itself into `$APP/deploy/oci` when that
directory is missing.

## Decisions

- **Host**: OCI `VM.Standard.A1.Flex`, Ubuntu 24.04 aarch64, **2 OCPU / 12 GB**
  (the Always Free Arm allowance was halved from 4/24 in 2026), home region
  `ap-hyderabad-1`.
- `ap-hyderabad-1` has a **single availability domain**, so the console's standard
  "try another AD" advice is unavailable. Capacity is the only blocker.
- **Backend only** on the box: `collector`, `api`, `signals-spot`, `signals-perp`,
  `costs`, `context`. Every one binds `127.0.0.1`.
- **UI served from the box for now**, reached over an SSH tunnel; the `dashboard` unit is
  enabled there. Vercel remains the intended home, reaching the API through
  `RESEARCH_API_BASE` once the API has a public HTTPS hostname.
- Account upgraded to **Pay As You Go** (see the upgrade note below).
- Boot volume **150 GB**, not the 50 GB default — see disk growth.

## Steps

| #   | Step                                                         | State                              |
| --- | ------------------------------------------------------------ | ---------------------------------- |
| 1   | Audit repo + confirm arm64 native deps                       | Done                               |
| 2   | Run the installer's dependency pipeline locally              | Done — 110 tests pass              |
| 3   | Make the dashboard's API base configurable for Vercel        | Done, verified                     |
| 4   | Write the deploy runbook and `update.sh`                     | Done                               |
| 5 | Create the instance | Done — **1 OCPU / 6 GB, 45 GB boot** |
| 6 | Run `setup.sh`, copy `.env.local`, enable backend units | Done — six units active, 0 restarts |
| 7 | Publish the evidence API + set `RESEARCH_API_BASE` on Vercel | Pending — UI now served from the box over a tunnel |
| 8 | Start the 24h coverage run | **Running since 08 Oct 14:16 UTC on OCI** |

## Blocker: A1 capacity, and the PAYG upgrade is asynchronous

Every create attempt returns `Out of capacity for shape VM.Standard.A1.Flex in
availability domain AD-1` — including at 1 OCPU / 6 GB, and after upgrading to Pay As
You Go.

The upgrade does **not** take effect immediately. Oracle's upgrade guide: _"It will take
a few days for Oracle to upgrade your Free Tier account. Once upgraded you will get the
confirmation mail for the same."_ Reports put it at about a day, with 5+ day outliers.
Until the confirmation email arrives, the account still provisions at free-tier priority,
which is why upgrading changed nothing. **Do not retry before the email.**

If capacity is still unavailable once the upgrade is live, the fallback is a polite retry
loop (5–10 min interval; aggressive polling draws 429s and abuse flags). Preferred host is
an always-on machine, not the Mac, which sleeps.

Card verification, per Oracle's billing docs: **US$1 authorisation at signup, US$100 at
upgrade**, and "the credit card authorizations are immediately reversed on the Oracle
side." The residual delay is entirely the bank's; the free-tier FAQ quotes 3–5 days.

## Findings from the laptop stack (now stopped)

- **Raw journal growth is ~1.7 GB/day** (3.34 GB over 48.4 h; `data/` is 5.35 GB total).
  A 50 GB boot volume fills in about five weeks, so the OCI boot volume is set to
  **150 GB**. A bigger disk only delays the problem: the collector never prunes old
  journals, so archiving/rotation is the real fix and is not implemented.
- **The 24h gate still fails.** `ops:report` over 2026-10-07T12:49Z → 2026-10-08T12:49Z:
  `storedSeconds` 86351/86400 (99.9% wall-clock coverage) but `completeFraction` **0.525**,
  `maxClosureDelayMs` **1,078,475** (~18 min), `disconnects` **55**, late events observed in
  health samples **28,215**, peak memory 330 MB, `passed24HourGate: false`. That window
  predates the keep-awake agent, so laptop sleep is the likely cause.
- **Shadow engine runs but produces nothing**: 193,680 steps, 2 relationships, not frozen,
  0 candidates, 0 trades, 0 open positions.
- **`scripts/services.sh` is zsh-only** (`${0:A:h:h}`); running it under `bash` fails with
  `A: unbound variable`. Invoke it via its shebang or `pnpm services:status`.
- **Crosswake's dashboard was not running at all.** The Next server on `*:3000` is a
  `next dev` for **EIF-2027** (`Developer/Git-Repos/EIF-2027`), a different project, and is
  unaffected by this work. Crosswake's own dashboard is not in `SERVICES` and was never a
  launchd agent, so nothing restarts it.
- **The residual runners restart themselves and hit Binance 429s** — `signals-perp` logged
  `ADAUSDT fetch failed: Error: Transient HTTP 429`. Both reached `starts: 2` (one SIGKILL
  each) and depended on launchd `KeepAlive`.
- Cutover requires stopping the laptop stack _and_ uninstalling the launchd agents, or both
  sides collect in parallel and the agents resurrect on reboot.

## Changes made

- `apps/dashboard/app/api/evidence/[...path]/route.ts` — `apiBase()` honours
  `RESEARCH_API_BASE` (absolute http(s) URL, normalised to origin) before falling back to
  `http://127.0.0.1:$RESEARCH_API_PORT`; an unparseable value returns `null`, which the
  route already maps to `503 invalid_api_port`.
- `.env.example` — documents `RESEARCH_API_BASE`.
- `deploy/oci/setup.sh` — arch/systemd guard, and a next-steps block with the tunnel command.
- `deploy/oci/update.sh` — new: pull, install, typecheck, test, dashboard build, restart.
- `deploy/oci/README.md` — new: runbook, free-tier limits, Vercel split, troubleshooting;
  boot volume raised to 150 GB.

## Verification

- `pnpm test` — 110 passed (14 files). `docs/status.md` claims 95; stale.
- `pnpm typecheck:dashboard` — clean.
- Proxy behaviour against a live evidence API via `next dev`: default → `127.0.0.1:4112`
  `200`; `RESEARCH_API_BASE=http://127.0.0.1:4113` with `RESEARCH_API_PORT=abc` → `200`
  from 4113 (base wins); `RESEARCH_API_BASE='not a url'` → `503 invalid_api_port`;
  `/api/evidence/protocols` → `{"protocols":["v001","v002"]}`; traversal path → `404`.
- `deploy/oci/*.sh` pass `bash -n`.
- Before the stop: `zsh scripts/services.sh status` showed awake, api, costs, context
  running (1 start each) and signals-spot/perp running (2 starts each); collector PID 41418
  continuous for 48 h, `connected: true`, `rejected: 0`.
- After the stop: no Crosswake processes, no loaded agents, no plists, `caffeinate` gone,
  `:4112` free, `data/collector.lock` released. `data/collector.pid` still holds `41418`
  (stale, harmless — rewritten at next launch).
- The laptop's 5.35 GB `data/` was **not** deleted and was not migrated; the OCI collector
  opens a fresh journal and no acceptance gate depends on laptop history.
- Running `next dev` generates `apps/dashboard/AGENTS.md` and `CLAUDE.md` (Next 16
  `agentRules`). Removed after verification; expect them back whenever a dev server runs.

## Next actions

1. Wait for the OCI upgrade confirmation email, then create the instance at
   2 OCPU / 12 GB with a **150 GB** boot volume, reusing `crosswake-vcn` and the existing
   SSH key.
2. Decide on raw-journal rotation before the OCI box takes over.
3. Restart the laptop stack (`pnpm services:install` plus a collector start) if collection
   needs to resume before OCI capacity appears.
