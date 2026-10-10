#!/usr/bin/env bash
# Connect the public signal log in one step. Before running:
#   1. github.com/new → create an EMPTY public repo (no README), e.g. crosswake-signal-log
#   2. github.com/settings/personal-access-tokens/new → fine-grained token,
#      "Only select repositories" → that repo, Permissions → Contents: Read and write
# Then:
#   ssh -t ubuntu@<IP> 'bash /opt/crosswake/deploy/oci/set-signal-log.sh'
#
# The token is stored only in the clone's own git credential file (mode 600) and can do
# nothing except push to that one repository.
set -euo pipefail
APP=${APP:-/opt/crosswake}
ENV_FILE=${ENV_FILE:-$APP/.env.local}
DIR=${SIGNAL_LOG_DIR:-/opt/crosswake-signal-log}

read -rp 'Public repo URL (https://github.com/<you>/<repo>): ' URL
read -rsp 'Fine-grained token: ' TOKEN
echo
URL=${URL%/}
URL=${URL%.git}
if ! [[ $URL =~ ^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
  echo 'Expected https://github.com/<owner>/<repo>' >&2
  exit 1
fi
OWNER=${BASH_REMATCH[1]}
REPO=${BASH_REMATCH[2]}
if ! [[ $TOKEN =~ ^github_pat_[A-Za-z0-9_]{40,}$ ]]; then
  echo 'That does not look like a fine-grained token (github_pat_...)' >&2
  exit 1
fi

# /opt is root-owned; the services run as this user, so they must own the clone.
sudo install -d -o "$(id -un)" -g "$(id -gn)" "$DIR"
cd "$DIR"
[ -d .git ] || git init -q -b main
git config user.name 'Crosswake signal log'
git config user.email 'signal-log@users.noreply.github.com'
git config credential.helper "store --file=$DIR/.git/credentials"
umask 077
printf 'https://x-access-token:%s@github.com\n' "$TOKEN" >"$DIR/.git/credentials"
umask 022
git remote remove origin 2>/dev/null || true
git remote add origin "$URL.git"

# First run seeds the repo with the README and the dependency-free verifier.
if ! git ls-remote --exit-code origin main >/dev/null 2>&1; then
  cp "$APP/deploy/signal-log-repo/README.md" "$APP/deploy/signal-log-repo/verify.mjs" .
  git add README.md verify.mjs
  git commit -qm 'Start the Crosswake signal log'
  git push -q -u origin main
else
  git fetch -q origin main && git checkout -q -B main origin/main
  git branch -q --set-upstream-to=origin/main main
fi
echo "Push access confirmed for $OWNER/$REPO."

tmp=$(mktemp)
grep -vE '^SIGNAL_LOG_REPO_DIR=' "$ENV_FILE" >"$tmp" || true
printf 'SIGNAL_LOG_REPO_DIR=%s\n' "$DIR" >>"$tmp"
install -m 600 "$tmp" "$ENV_FILE"
rm -f "$tmp"

sudo systemctl restart crosswake@signals-daily crosswake@signals-daily-v006 crosswake@status
echo 'Restarted the daily engines; existing signals are backfilled into the log on this run.'
cat <<MSG

Now set this on Vercel (landing project), then redeploy:
  NEXT_PUBLIC_SIGNAL_LOG_BASE=https://raw.githubusercontent.com/$OWNER/$REPO/main
MSG
