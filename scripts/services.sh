#!/bin/zsh
# Crosswake background services as macOS launchd user agents.
# Usage: scripts/services.sh install|uninstall|status|restart|logs [service...]
# Agents restart on crash (KeepAlive), log to data/logs/, and never place orders.
set -euo pipefail
REPO="${0:A:h:h}"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$REPO/data/logs"
PREFIX="com.crosswake"
NODE_BIN="$(dirname "$(command -v node)")"
PNPM="$(command -v pnpm)"

# name|command (run from the repo root). The market collector is managed separately:
# its restart replays the full journal chain, so migrate it deliberately.
SERVICES=(
  "awake|/usr/bin/caffeinate -i -s"
  "api|$PNPM -s research:api"
  "signals-spot|$PNPM -s residual:live -- --config configs/residual-spot-v003.json"
  "signals-perp|$PNPM -s residual:live -- --config configs/catchdown-perp-v004.json"
  "signals-daily|$PNPM -s trend:live"
  "costs|$PNPM -s costs:sample -- --interval-seconds 300"
  "context|$PNPM -s context:collect -- --watch"
)

xml() {
  local s=${1//&/&amp;}
  s=${s//</&lt;}
  print -r -- "${s//>/&gt;}"
}
plist() {
  local name=$1 run
  run=$(xml "cd \"$REPO\" && exec $2")
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PREFIX.$name</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-c</string><string>$run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/$name.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.log</string>
</dict>
</plist>
PLIST
}

selected() {
  local name=${1%%|*}
  (( ${#targets} == 0 )) || (( ${targets[(Ie)$name]} ))
}

action=${1:-status}
shift || true
targets=("$@")
for entry in "${SERVICES[@]}"; do
  name=${entry%%|*}
  cmd=${entry#*|}
  selected "$name" || continue
  label="$PREFIX.$name"
  file="$AGENTS/$label.plist"
  case $action in
    install)
      mkdir -p "$AGENTS" "$LOGS"
      plist "$name" "$cmd" > "$file.tmp"
      plutil -lint "$file.tmp" >/dev/null
      mv "$file.tmp" "$file"
      launchctl bootout "gui/$UID/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$UID" "$file"
      echo "installed $label"
      ;;
    uninstall)
      launchctl bootout "gui/$UID/$label" 2>/dev/null || true
      rm -f "$file"
      echo "removed $label"
      ;;
    restart)
      launchctl kickstart -k "gui/$UID/$label"
      echo "restarted $label"
      ;;
    status)
      if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
        pid=$(launchctl print "gui/$UID/$label" | awk '$1 == "pid" && $2 == "=" {print $3; exit}')
        runs=$(launchctl print "gui/$UID/$label" | awk '/runs =/ {print $3; exit}')
        if [[ -n $pid ]]; then state="running pid $pid"; else state="not running"; fi
        echo "$label: $state (starts: ${runs:-0})"
      else
        echo "$label: not installed"
      fi
      ;;
    logs)
      echo "== $name"; tail -n 5 "$LOGS/$name.log" 2>/dev/null || echo "(no log yet)"
      ;;
    *)
      echo "Usage: scripts/services.sh install|uninstall|status|restart|logs [service...]" >&2
      exit 2
      ;;
  esac
done
