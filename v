#!/usr/bin/env sh
# m12 launcher — run everything with:   ./v
#
#   UI + API   -> port 8801   (loopback by default; front with Caddy, or SSH-tunnel to reach it)
#   Telemetry  -> port 8802   (mTLS; only listens once INGEST_CA/CERT/KEY are set — safe to expose)
#
# Point your own systemd unit at this script (see the bottom of this file).
set -e
cd "$(dirname "$0")"

# 1. Secrets must exist. .env is gitignored, so a fresh download won't have one.
if [ ! -f .env ]; then
  echo "error: .env missing." >&2
  echo "  cp .env.example .env   # then set M12_USER and run: npm run hash-password" >&2
  exit 1
fi

# 2. Build the UI if it isn't built. The server itself has no runtime deps, so a
#    prebuilt dist/ means it can run without node_modules at all.
if [ ! -f dist/index.html ]; then
  echo "[v] dist/ not found — building the UI (needs npm)..."
  if [ ! -d node_modules ]; then
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
  fi
  npm run build
fi

# 3. Run. Ports are fixed here and override whatever .env says (shell env wins
#    over --env-file). exec so systemd's signals reach node directly.
echo "[v] starting m12 — UI http://127.0.0.1:8801  |  ingest :8802"
exec env PORT=8801 INGEST_PORT=8802 node --env-file=.env server/index.js

# --- example systemd unit (/etc/systemd/system/m12.service) ---
#   [Unit]
#   Description=m12
#   After=network.target
#   [Service]
#   WorkingDirectory=/root/m12
#   ExecStart=/root/m12/v
#   Restart=on-failure
#   [Install]
#   WantedBy=multi-user.target
