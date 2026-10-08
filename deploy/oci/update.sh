#!/usr/bin/env bash
# Update an already-provisioned host: pull main, reinstall, verify, rebuild, restart.
# Usage: bash deploy/oci/update.sh [service...]   (default: every unit)
set -euo pipefail
APP=${APP:-/opt/crosswake}
cd "$APP"

git pull --ff-only
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dashboard:build

bash deploy/oci/services.sh restart "${@}"
bash deploy/oci/services.sh status
