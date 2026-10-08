#!/usr/bin/env bash
# bash deploy/oci/services.sh enable|disable|status|restart|logs [service...]
set -euo pipefail
ALL=(collector api dashboard signals-spot signals-perp signals-daily costs context)
action=${1:-status}; shift || true
targets=("${@:-${ALL[@]}}")
for s in "${targets[@]}"; do
  unit="crosswake@$s"
  case $action in
    enable)  sudo systemctl enable --now "$unit" ;;
    disable) sudo systemctl disable --now "$unit" ;;
    restart) sudo systemctl restart "$unit" ;;
    status)  printf '%-14s %s\n' "$s" "$(systemctl is-active "$unit")" ;;
    logs)    echo "== $s"; journalctl -u "$unit" -n 8 --no-pager ;;
    *) echo "usage: services.sh enable|disable|status|restart|logs [service...]"; exit 2 ;;
  esac
done
