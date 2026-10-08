#!/usr/bin/env bash
# Maps a service name to its command. Execution of orders is not implemented anywhere.
set -euo pipefail
cd /opt/crosswake
case "$1" in
  collector)    exec pnpm -s collect ;;
  api)          exec pnpm -s research:api ;;
  dashboard)    exec pnpm --filter @crosswake/dashboard start ;;
  signals-spot) exec pnpm -s residual:live -- --config configs/residual-spot-v003.json ;;
  signals-perp) exec pnpm -s residual:live -- --config configs/catchdown-perp-v004.json ;;
  costs)        exec pnpm -s costs:sample -- --interval-seconds 300 ;;
  context)      exec pnpm -s context:collect -- --watch ;;
  *) echo "unknown service $1" >&2; exit 2 ;;
esac
