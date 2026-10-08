#!/usr/bin/env bash
# Maps a service name to its command. Execution of orders is not implemented anywhere.
#
# Apps run directly as `node --import tsx <entry>` rather than through `pnpm -s <script>`. The
# pnpm wrapper exists to look up a package.json script; measured with PSS the wrapper chain and
# the tsx CLI cost ~500 MB across the seven units, which buys nothing inside a systemd unit.
# `node --import tsx` registers the same loader in-process instead of spawning a CLI child.
set -euo pipefail
cd /opt/crosswake
case "$1" in
  # v001 shadow replay is retired: the journal is a WAL split per UTC day so retention can expire it.
  collector)    PAPER_MODE=off exec node --import tsx apps/collector/src/main.ts ;;
  retention)    exec node --import tsx apps/retention/src/main.ts --watch ;;
  api)          exec node --import tsx apps/api/src/main.ts ;;
  dashboard)    cd apps/dashboard && exec node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000 ;;
  signals-spot) exec node --import tsx apps/residual/src/main.ts live --config configs/residual-spot-v003.json ;;
  signals-perp) exec node --import tsx apps/residual/src/main.ts live --config configs/catchdown-perp-v004.json ;;
  signals-daily) exec node --import tsx apps/trend/src/main.ts live ;;
  costs)        exec node --import tsx apps/costs/src/main.ts sample --interval-seconds 300 ;;
  context)      exec node --import tsx apps/context/src/main.ts --watch ;;
  *) echo "unknown service $1" >&2; exit 2 ;;
esac
