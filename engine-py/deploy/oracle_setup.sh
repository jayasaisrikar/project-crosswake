#!/usr/bin/env bash
# One-time setup on an Oracle Cloud Always Free Ubuntu VM (non-US region: Binance blocks US IPs).
# Usage on the VM, from a PINNED release checkout (docs/RUNBOOK.md section 1):
#   git clone <repo> ~/crypto && cd ~/crypto && git checkout <release-tag> && bash deploy/oracle_setup.sh
# Local only: logs stay on the VM, nothing is pushed anywhere. Telegram is used only if you add
# --send yourself AND set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
set -euo pipefail
APP="${APP:-$HOME/crypto}"
cd "$APP"

sudo apt-get update -y && sudo apt-get install -y curl ca-certificates util-linux logrotate
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
UV="$HOME/.local/bin/uv"

"$UV" sync --frozen                       # exactly uv.lock; production never re-resolves
mkdir -p logs
sudo timedatectl set-timezone UTC
sudo timedatectl set-ntp true || true

# Reachability check: anything but HTTP 200 (451/403 = region blocked) aborts the setup.
for url in "https://api.binance.com/api/v3/ping" "https://fapi.binance.com/fapi/v1/ping"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
  echo "$url -> $code"
  if [ "$code" != "200" ]; then
    echo "ABORT: Binance not reachable from this VM (HTTP $code). Use a non-US region." >&2
    exit 1
  fi
done

# History bootstrap: without data/cleaned the first steps run on a 200-day live fetch, then the bar
# cache (data/paper/live_cache) keeps later steps small. A full `engine download && engine clean`
# is optional and large.
echo "tip: optional full history: $UV run --frozen --no-sync engine download && $UV run --frozen --no-sync engine clean"

# Cron: paper step at :02 under flock (no overlap) + timeout (> engine deadline of 10 min), health at :20.
STEP="2 * * * * cd $APP && flock -n /tmp/engine-step.lock timeout 50m $UV run --frozen --no-sync engine live step >> $APP/logs/live.log 2>&1"
HEALTH="20 * * * * cd $APP && timeout 10m $UV run --frozen --no-sync engine health --alert >> $APP/logs/health.log 2>&1"
# `|| true` keeps pipefail from aborting when there is no crontab yet / nothing left after grep (O5).
{ crontab -l 2>/dev/null | grep -v -e 'engine live step' -e 'engine health' || true; echo "$STEP"; echo "$HEALTH"; } | crontab -
echo "cron installed:"; crontab -l

# Log rotation (weekly, 8 generations, compressed).
sudo tee /etc/logrotate.d/crypto-engine >/dev/null <<EOF
$APP/logs/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
EOF

echo "first step now:"
"$UV" run --frozen --no-sync engine live step | tee -a logs/live.log
