#!/usr/bin/env bash
# Deploy the current origin/main to a provisioned host.
#
# Usage:  bash deploy/oci/update.sh [service...]      explicit list wins
#         SKIP_COLLECTOR=1 bash deploy/oci/update.sh  never touch the collector
#         DRY_RUN=1 bash deploy/oci/update.sh         print the derived set and stop
#
# With no arguments the restart set is DERIVED from the diff instead of hardcoded:
#   apps/<app>/...      the units that run that app
#   packages/<pkg>/...  every app that imports it, directly or through another package
#                       (shared code, so the blast radius is whatever pulls it in)
#   configs/<file>      the unit whose run.sh line names that config
#   anything else       no restart (docs, tests, deploy scripts)
#
# A hardcoded list silently leaves units on stale code whenever a commit looks unrelated
# to them; that has already happened twice here - the journal/WAL change and the trend
# engine change. Deriving the set is the difference between a deploy you can trust and one
# that quietly keeps serving last week's logic.
#
# Two things this still does deliberately:
#   * `git pull --ff-only` cannot work on a host that carries any local difference, and the
#     host is a deploy target, so it is reset to origin/main instead of merged.
#   * The collector's restart replays the journal chain and leaves a coverage gap, so it is
#     moved only when its own code moved. SKIP_COLLECTOR=1 overrides even that.
set -euo pipefail
APP=${APP:-/opt/crosswake}
cd "$APP"

units_for_app() {
  case "$1" in
    collector) echo collector ;;
    api) echo api ;;
    dashboard) echo dashboard ;;
    residual) echo 'signals-spot signals-perp' ;;
    trend) echo 'signals-daily signals-daily-v006' ;;
    htf) echo signals-htf-v007 ;;
    digest) echo digest ;;
    costs) echo costs ;;
    context) echo context ;;
    retention) echo retention ;;
    *) echo '' ;;
  esac
}

# Every package that imports any of the given packages, at any depth.
transitive_packages() {
  local frontier=$1 seen=' ' found=' '
  while [ -n "$frontier" ]; do
    local next=''
    for p in $frontier; do
      case "$seen" in *" $p "*) continue ;; esac
      seen="$seen$p "
      for dir in packages/*/; do
        local q=${dir#packages/}
        q=${q%/}
        case "$seen$found" in *" $q "*) continue ;; esac
        if grep -rqs "packages/$p/" "$dir" --include='*.ts'; then
          found="$found$q "
          next="$next $q"
        fi
      done
    done
    frontier=$next
  done
  echo "$found"
}

BEFORE=$(git rev-parse HEAD)
git fetch origin main --quiet
AFTER=$(git rev-parse origin/main)
git clean -fd -e deploy/oci/env
git reset -q --hard origin/main
echo "== $(git log --oneline -1)"

changed=$(git diff --name-only "$BEFORE" "$AFTER")
apps_changed=$(printf '%s\n' "$changed" | sed -n 's|^apps/\([a-z0-9-]*\)/.*|\1|p' | sort -u)
pkgs_changed=$(printf '%s\n' "$changed" | sed -n 's|^packages/\([a-z0-9-]*\)/.*|\1|p' | sort -u)
cfgs_changed=$(printf '%s\n' "$changed" | sed -n 's|^configs/\([^/]*\)$|\1|p' | sort -u)

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  if [ -z "$changed" ]; then
    echo '== no file changes; nothing to build or restart'
    bash deploy/oci/services.sh status
    exit 0
  fi

  pkgs_all=$(printf '%s\n%s\n' "$pkgs_changed" \
    "$(transitive_packages "$(printf '%s ' $pkgs_changed)")" | sort -u | tr '\n' ' ')

  apps_all=$(printf '%s\n' $apps_changed)
  for p in $pkgs_all; do
    for dir in apps/*/; do
      if grep -rqs "packages/$p/" "$dir" --include='*.ts' --include='*.tsx'; then
        apps_all="$apps_all
${dir#apps/}"
      fi
    done
  done

  affected=''
  for app in $(printf '%s\n' "$apps_all" | sed 's|/$||' | sort -u); do
    affected="$affected $(units_for_app "$app")"
  done
  for cfg in $cfgs_changed; do
    for svc in $(sed -n "s|^  \([a-z0-9-]*\)).*configs/${cfg}.*|\1|p" deploy/oci/run.sh); do
      affected="$affected $svc"
    done
  done

  targets=($(printf '%s\n' $affected | grep -v '^$' | sort -u || true))
  echo "== apps:     $(printf '%s ' $apps_changed)"
  echo "== packages: $(printf '%s ' $pkgs_all)"
  echo "== configs:  $(printf '%s ' $cfgs_changed)"
fi

if [ "${SKIP_COLLECTOR:-0}" = '1' ]; then
  targets=($(printf '%s\n' "${targets[@]:-}" | grep -v '^collector$' || true))
  echo '== SKIP_COLLECTOR=1: collector left running (restart it deliberately if its code moved)'
fi

if [ "${DRY_RUN:-0}" = '1' ]; then
  echo "== DRY RUN: would restart [$(printf '%s ' "${targets[@]:-}")]"
  exit 0
fi

corepack prepare pnpm@10.32.1 --activate >/dev/null
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

build_dashboard=0
if printf '%s\n' "$changed" | grep -q '^apps/dashboard/'; then build_dashboard=1; fi
case " ${targets[*]:-} " in *' dashboard '*) build_dashboard=1 ;; esac
if [ $build_dashboard -eq 1 ]; then
  pnpm dashboard:build
  case " ${targets[*]:-} " in *' dashboard '*) ;; *) targets=(dashboard "${targets[@]:-}") ;; esac
fi

if [ ${#targets[@]} -eq 0 ]; then
  echo '== no unit code changed; nothing to restart'
else
  echo "== restarting: ${targets[*]}"
  bash deploy/oci/services.sh restart "${targets[@]}"
fi
bash deploy/oci/services.sh status
