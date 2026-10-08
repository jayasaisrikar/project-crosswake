#!/usr/bin/env bash
# Set Telegram signal-delivery credentials without echoing them to the terminal, shell
# history, or any transcript.
#
#   ssh -t ubuntu@<IP> 'bash /opt/crosswake/deploy/oci/set-telegram.sh'
#
# The signal engines read these at start and REFUSE to start when TELEGRAM_ENABLED=true is set
# without a usable token and chat id, so both are validated here before anything is written.
set -euo pipefail
ENV_FILE=${ENV_FILE:-/opt/crosswake/.env.local}

read -rsp 'Telegram bot token (from BotFather): ' TOKEN
echo
read -rp 'Telegram chat id (numeric id or @channel): ' CHAT
echo

# Same shapes packages/notify enforces, so a typo fails here instead of at service start.
if ! [[ $TOKEN =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]]; then
  echo 'That is not a bot token: expected <digits>:<30+ chars>' >&2
  exit 1
fi
if ! [[ $CHAT =~ ^(-?[0-9]+|@[A-Za-z0-9_]{5,})$ ]]; then
  echo 'Chat id must be a numeric id or @channel' >&2
  exit 1
fi

tmp=$(mktemp)
grep -vE '^(# *)?TELEGRAM_(ENABLED|BOT_TOKEN|CHAT_ID)=' "$ENV_FILE" >"$tmp" || true
printf 'TELEGRAM_ENABLED=true\nTELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' \
  "$TOKEN" "$CHAT" >>"$tmp"
install -m 600 "$tmp" "$ENV_FILE"
rm -f "$tmp"
echo "Written to $ENV_FILE (mode 600)."

echo 'Restarting the signal engines...'
sudo systemctl restart crosswake@signals-spot crosswake@signals-perp crosswake@signals-daily crosswake@signals-daily-v006 crosswake@signals-htf-v007
sleep 25
for unit in signals-spot signals-perp signals-daily signals-daily-v006 signals-htf-v007; do
  printf '  %-14s %s\n' "$unit" "$(systemctl is-active "crosswake@$unit")"
  journalctl -u "crosswake@$unit" -n 6 --no-pager |
    grep -o 'channels:.*' | tail -1 | sed 's/^/    /' || true
done
