#!/usr/bin/env bash
# Set the evidence API's bearer token, then prove the enforcement works.
#
#   ssh -t ubuntu@<IP> 'bash /opt/crosswake/deploy/oci/set-api-token.sh'
#
# Generates a token if you press Enter, or accepts one you paste in. Either way it is written
# to .env.local at mode 600 and echoed once so you can paste the same value into Vercel as
# RESEARCH_API_TOKEN.
#
# While the token is unset the API accepts unauthenticated calls. That is correct only because
# the port is loopback-only, so run this before publishing the API anywhere (tunnel, proxy,
# public IP). The dashboard proxy reads RESEARCH_API_TOKEN too, so both ends must match:
# setting it here without setting it in Vercel makes the dashboard return 401.
set -euo pipefail
ENV_FILE=${ENV_FILE:-/opt/crosswake/.env.local}
APP=${APP:-/opt/crosswake}

read -rp 'Paste a token, or press Enter to generate one: ' TOKEN
if [ -z "$TOKEN" ]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-43)
  echo
  echo 'Generated. Put this in Vercel as RESEARCH_API_TOKEN (same value):'
  echo
  echo "  $TOKEN"
  echo
fi

tmp=$(mktemp)
grep -vE '^(# *)?RESEARCH_API_TOKEN=' "$ENV_FILE" >"$tmp" || true
printf 'RESEARCH_API_TOKEN=%s\n' "$TOKEN" >>"$tmp"
install -m 600 "$tmp" "$ENV_FILE"
rm -f "$tmp"
echo "Written to $ENV_FILE (mode 600)."

cd "$APP"
sudo systemctl restart crosswake@api
sleep 6
printf '  api: %s\n' "$(systemctl is-active crosswake@api)"
printf '  unauthenticated /health -> '
curl -s -o /dev/null -w '%{http_code}\n' --max-time 6 http://127.0.0.1:4112/health
printf '  with the token   /health -> '
curl -s -o /dev/null -w '%{http_code}\n' --max-time 6 \
  -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4112/health
echo
echo 'Expect 401 then 200. Now set the same value in Vercel and redeploy there.'
