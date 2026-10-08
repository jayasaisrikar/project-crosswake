# Crosswake on Oracle Cloud Always Free (Ampere A1)

Runbook for moving the collector and backend services off the laptop onto an
Always Free Arm VM. The UI is deployed separately to Vercel and reads the evidence
API over the network; every service on this box binds `127.0.0.1`.

## Split of responsibilities

| Where          | What                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| OCI (this box) | `collector`, `api` (evidence), `signals-spot`, `signals-perp`, `signals-daily`, `signals-daily-v006`, `signals-htf-v007`, `digest`, `retention`, `costs`, `context`   |
| Vercel         | `apps/dashboard`, proxying `/api/evidence/*` to the OCI API via `RESEARCH_API_BASE` |

The dashboard's pages are client components that call its own `/api/evidence/*` route,
which runs server-side and forwards to `RESEARCH_API_BASE` (falling back to
`http://127.0.0.1:$RESEARCH_API_PORT`). Only that one env var differs between the local
and Vercel deployments.

Because the Vercel proxy must reach the API, the evidence API needs a **public HTTPS
hostname** once the UI moves off the laptop. Until that exists, run the dashboard on the
box and use the SSH tunnel below.

## What Always Free actually gives you (as of 2026)

| Resource                               | Limit                                              |
| -------------------------------------- | -------------------------------------------------- |
| Ampere A1 (`VM.Standard.A1.Flex`), Arm | **2 OCPU / 12 GB RAM** total, one or two instances |
| AMD micro (`VM.Standard.E2.1.Micro`)   | 2 instances, 1/8 OCPU / 1 GB each                  |
| Block volume                           | 200 GB total (boot + block)                        |
| Egress                                 | 10 TB/month                                        |
| Region                                 | **home region only**                               |

Notes that matter here:

- The Arm allowance was halved from 4 OCPU / 24 GB to **2 OCPU / 12 GB**. Provision
  within 2/12 from the start; instances above the limit get disabled and then deleted.
- 2 OCPU / 12 GB is comfortably enough for this workload. The AMD micro at 1 GB is not.
- If you get **"Out of host capacity"**, that is the normal state of most regions for
  A1. Retry, or retry over a few days. Upgrading to Pay As You Go removes the capacity
  restriction while staying free inside 2 OCPU / 12 GB (Oracle places a temporary
  ~US$100 authorisation hold on the card, then releases it).

`ap-hyderabad-1` (India South) has a **single availability domain**, so "try another
AD" is not an option there — retrying or upgrading to Pay As You Go are the only levers.

## 1. Create the instance

Compute → Instances → **Create instance**:

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Image       | Canonical **Ubuntu 24.04** (aarch64)                                   |
| Shape       | **Ampere → VM.Standard.A1.Flex**                                       |
| OCPUs       | **2**                                                                  |
| Memory      | **12 GB**                                                              |
| Boot volume | **150 GB** — raw journals grow ~1.7 GB/day, so 50 GB fills in ~5 weeks |
| Networking  | Create/select a VCN, **assign a public IPv4 address**                  |
| SSH keys    | Upload your public key (`~/.ssh/id_ed25519.pub`)                       |

The default security list already allows inbound SSH 22. Leave it that way unless you
are deliberately publishing the API (step 6) — nothing else on the box listens publicly.

## 2. Get the code and the deploy scripts onto the box

`deploy/` is not committed to the repository, so the installer cannot be pulled — copy
it over alongside the code:

```bash
# from the repo root on the laptop
scp -r deploy/oci ubuntu@<IP>:~/
```

Then on the VM:

```bash
ssh ubuntu@<IP>
bash ~/oci/setup.sh https://github.com/jayasaisrikar/project-crosswake.git
```

`setup.sh` installs Node 24 + pnpm 10.32.1, clones to `/opt/crosswake`, installs with
`--frozen-lockfile`, runs `typecheck`, `test` and `dashboard:build`, creates
`/opt/crosswake/.env.local` from the template and installs the `crosswake@.service`
unit. Once `deploy/` is committed you can use a clean clone instead.

## 3. Secrets

```bash
# from the laptop — copy the working keys across (never into Git)
scp .env.local ubuntu@<IP>:/opt/crosswake/.env.local
sudo chown ubuntu:ubuntu /opt/crosswake/.env.local && chmod 600 /opt/crosswake/.env.local
```

## 4. Start the backend services

```bash
cd /opt/crosswake
bash deploy/oci/services.sh enable collector api signals-spot signals-perp signals-daily signals-daily-v006 signals-htf-v007 digest retention costs context
bash deploy/oci/services.sh status
bash deploy/oci/services.sh logs collector
```

`dashboard` is deliberately left disabled here — Vercel serves the UI. Enable it only
for the local tunnel path in step 5. The collector opens a fresh journal under
`/opt/crosswake/data` on first start; the laptop's history is not copied and does not
need to be.

## 5. Reach it before the public hostname exists

```bash
ssh -N -L 3000:127.0.0.1:3000 -L 4112:127.0.0.1:4112 ubuntu@<IP>
```

Then <http://127.0.0.1:3000> (dashboard, if enabled) and 4112 (evidence API).

## 6. Publish the evidence API for Vercel

The API is read-only but unauthenticated, so do not expose it raw on a public IP. Two
workable options:

- **Cloudflare Tunnel** — `cloudflared` dials out, no inbound ports, TLS on a hostname
  you own, and Cloudflare Access can require a service token. Recommended given the
  rest of the stack is already Cloudflare.
- **Caddy on the box** — reverse proxy with automatic Let's Encrypt, requires an A
  record pointing at the public IP and inbound 80/443 open in the VCN security list.

Then set `RESEARCH_API_BASE=https://<hostname>` in the Vercel project and redeploy.

## 7. Updates

```bash
ssh ubuntu@<IP> 'bash /opt/crosswake/deploy/oci/update.sh'
```

Pulls `main`, reinstalls, re-runs typecheck/tests, rebuilds the dashboard and restarts
the units. The collector counts as an ordinary unit here: its restart replays the
journal chain, so only run updates when that replay cost is acceptable.

## 8. The open 24h gate

This box removes the laptop-sleep cause of the earlier reliability failures. Let the
collector run unbroken for 24h, then:

```bash
pnpm ops:report -- --from <ISO> --to <ISO> --symbols BTCUSDT,ETHUSDT,SOLUSDT
```

and record the result in `docs/status.md`. Watch disk with `du -sh /opt/crosswake/data`.

## Troubleshooting

- **`out of host capacity`** on create → retry, or upgrade to Pay As You Go.
- **Still out of capacity _after_ upgrading to PAYG** → the upgrade is asynchronous. Wait
  for the "upgrade is complete" confirmation email (typically ~1 day, sometimes longer)
  before retrying; until then the account still provisions at free-tier priority.
- **Unit start-loops with `pnpm: not found`** → corepack shims live in
  `/usr/local/bin`; re-run `sudo corepack enable` and check `command -v pnpm` as
  `ubuntu`.
- **Dashboard 502/blank right after enabling** → `pnpm dashboard:build` output must
  exist; `journalctl -u crosswake@dashboard -n 50`.
- **Vercel shows `evidence_api_offline`** → `RESEARCH_API_BASE` is unset, wrong, or the
  tunnel/proxy is down. The proxy turns any failure into a 503 with that body.
- **DuckDB / native module errors** → the lockfile carries
  `@duckdb/node-bindings-linux-arm64`; reinstall with `--frozen-lockfile` rather than
  letting an existing lock be ignored.
