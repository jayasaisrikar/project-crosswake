#!/usr/bin/env bash
# Deploy the current origin/main to a provisioned host.
# Usage: bash deploy/oci/update.sh [service...]      default: api dashboard
#
# Two things this does deliberately:
#   * `git pull --ff-only` cannot work on a host that carries any local difference, and the
#     host is a deploy target, so it is reset to origin/main instead of merged.
#   * The collector is NOT restarted by default. Its restart replays the whole journal chain
#     before it collects again, which leaves a gap in the coverage window. Move it only when
#     its own code changed:  bash deploy/oci/update.sh collector
set -euo pipefail
APP=${APP:-/opt/crosswake}
cd "$APP"

git fetch origin main
git clean -fd -e deploy/oci/env
git reset --hard origin/main
git log --oneline -1

corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dashboard:build

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then targets=(api dashboard); fi
bash deploy/oci/services.sh restart "${targets[@]}"
bash deploy/oci/services.sh status
