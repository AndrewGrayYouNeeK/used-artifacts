#!/usr/bin/env bash
# Starts the test preview (run scripts/preview-setup.sh once first).
#   scripts/preview-start.sh            local, or the forwarded port inside GitHub Codespaces
#   scripts/preview-start.sh --tunnel   also opens a free Cloudflare quick tunnel (random
#                                       https://*.trycloudflare.com URL, no account needed)
set -euo pipefail
cd "$(dirname "$0")/.."

sudo service postgresql start >/dev/null 2>&1 || true

if [ "${1:-}" = "--tunnel" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    curl -fsSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x /tmp/cloudflared
    sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
  fi
  log=$(mktemp)
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000 >"$log" 2>&1 &
  tunnel_pid=$!
  trap 'kill "$tunnel_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do
    APP_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" | head -1 || true)
    [ -n "$APP_URL" ] && break
    sleep 1
  done
  [ -n "$APP_URL" ] || { cat "$log"; echo "Tunnel did not start." >&2; exit 1; }
elif [ -n "${CODESPACE_NAME:-}" ]; then
  APP_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  APP_URL="${APP_URL:-http://localhost:3000}"
fi
export APP_URL
echo "Preview URL: $APP_URL"

npx next dev --hostname 0.0.0.0 --port 3000
