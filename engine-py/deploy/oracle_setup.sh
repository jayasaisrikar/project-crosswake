#!/usr/bin/env bash
# One-time setup on an Oracle Cloud Always Free Ubuntu VM (non-US region: Binance blocks US IPs).
# Usage on the VM:  bash ~/crypto/deploy/oracle_setup.sh
set -euo pipefail
APP="$HOME/crypto"
cd "$APP"

sudo apt-get update -y && sudo apt-get install -y curl ca-certificates
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
UV="$HOME/.local/bin/uv"

"$UV" sync
mkdir -p logs
sudo timedatectl set-timezone UTC

# Reachability check (HTTP 451/403 here = region blocked by Binance).
curl -s -o /dev/null -w "binance spot: %{http_code}\n" "https://api.binance.com/api/v3/ping"
curl -s -o /dev/null -w "binance perp: %{http_code}\n" "https://fapi.binance.com/fapi/v1/ping"

# Hourly paper step at minute :02 (UTC). Replaces any previous entry.
LINE="2 * * * * cd $APP && $UV run engine live step >> $APP/logs/live.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'engine live step' ; echo "$LINE" ) | crontab -
echo "cron installed:"; crontab -l

echo "first step now:"
"$UV" run engine live step | tee -a logs/live.log
