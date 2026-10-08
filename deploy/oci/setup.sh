#!/usr/bin/env bash
# One-time setup for an Oracle Cloud Always Free Ampere (arm64) Ubuntu 24.04 VM.
# Run as the default "ubuntu" user:  bash setup.sh https://github.com/OWNER/REPO.git
# Nothing is exposed publicly: the dashboard and API bind to 127.0.0.1; use an SSH tunnel.
set -euo pipefail
REPO_URL=${1:?usage: setup.sh <git-repo-url>}
APP=/opt/crosswake

case "$(uname -m)" in
  aarch64|arm64) ;;
  x86_64) echo "warning: expect Ampere A1 (aarch64); continuing on x86_64" >&2 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
command -v systemctl >/dev/null || { echo "systemd not found; this script targets Ubuntu 24.04 VMs" >&2; exit 1; }

sudo apt-get update
sudo apt-get install -y ca-certificates curl git build-essential unzip
if ! node --version 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
sudo timedatectl set-timezone UTC

sudo mkdir -p "$APP" && sudo chown "$USER" "$APP"
if [ ! -d "$APP/.git" ]; then git clone "$REPO_URL" "$APP"; fi
cd "$APP"
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm dashboard:build

[ -f .env.local ] || cp .env.example .env.local
chmod 600 .env.local

# deploy/ is not committed, so the bundle may have been copied outside the repo.
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ ! -d "$APP/deploy/oci" ]; then
  mkdir -p "$APP/deploy"
  cp -r "$SELF_DIR" "$APP/deploy/oci"
fi

sudo cp "$APP/deploy/oci/crosswake@.service" /etc/systemd/system/
sudo sed -i "s/^User=.*/User=$USER/" /etc/systemd/system/crosswake@.service
sudo systemctl daemon-reload
cat <<EOF

Setup complete on $(uname -m).

Next:
  1. Set the keys:  scp .env.local ubuntu@<IP>:$APP/.env.local
  2. Start:         cd $APP && bash deploy/oci/services.sh enable
  3. Check:         bash deploy/oci/services.sh status
  4. Tunnel (laptop): ssh -N -L 3000:127.0.0.1:3000 -L 4112:127.0.0.1:4112 ubuntu@<IP>
     then open http://127.0.0.1:3000

The collector opens a fresh journal under $APP/data on first start.
EOF
