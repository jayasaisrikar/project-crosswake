#!/usr/bin/env bash
# Per-instance cgroup limits.
#
# The unit template is shared, so per-service values need drop-ins. Without these, a single
# service that grows without bound can take the whole box down (and with `Restart=always` it
# would then restart into the same condition). MemoryHigh throttles first, MemoryMax is the
# hard stop; a killed unit is restarted by the unit's own Restart=always.
#
# Values sit at roughly 2-3x the measured working set, so they bound the blast radius without
# cutting into normal operation. Total worst case across all seven units is ~4 GB against
# 5.8 GB of RAM plus 2 GB of swap.
set -euo pipefail

UNITS=(
  "collector:768M:1G"
  "api:384M:512M"
  "dashboard:384M:512M"
  "signals-spot:384M:512M"
  "signals-perp:384M:512M"
  "costs:384M:512M"
  "context:384M:512M"
)

for entry in "${UNITS[@]}"; do
  name=${entry%%:*}
  rest=${entry#*:}
  high=${rest%%:*}
  max=${rest#*:}
  dir="/etc/systemd/system/crosswake@$name.service.d"
  sudo mkdir -p "$dir"
  printf '# Installed by deploy/oci/limits.sh\n[Service]\nMemoryHigh=%s\nMemoryMax=%s\n' \
    "$high" "$max" | sudo tee "$dir/limits.conf" >/dev/null
  echo "  crosswake@$name -> MemoryHigh=$high MemoryMax=$max"
done

sudo systemctl daemon-reload
echo "daemon reloaded; units pick the limits up on their next start"
