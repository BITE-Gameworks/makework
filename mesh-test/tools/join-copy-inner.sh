#!/usr/bin/env bash
# Inside the join-copy container (tools/join-copy.sh): Xvfb, the Vite dev server and the desktop app on loopback only,
# then the driver (tools/join-copy.mjs). Electron's and the driver's output go to /out.
set -uo pipefail
export HOME=/home/test DISPLAY=:99 MAKEWORK_LOG=1
mkdir -p "$HOME" /profile

Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp -ac >/out/xvfb.log 2>&1 &
cd /app
node node_modules/vite/bin/vite.js --config vite.mwt.config.ts --host 127.0.0.1 --port 1420 --strictPort >/out/vite.log 2>&1 &
for _ in $(seq 600); do curl -sf -o /dev/null http://127.0.0.1:1420/ && break; sleep 0.1; done
for _ in $(seq 100); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.05; done

MAKEWORK_DEV_URL=http://localhost:1420/ "/app/node_modules/electron/dist/$(cat /app/node_modules/electron/path.txt)" \
  /app --no-sandbox --user-data-dir=/profile --remote-debugging-port=9222 --remote-allow-origins='*' \
  --mute-audio --disable-gpu --password-store=basic >/out/electron.log 2>&1 &
electron=$!

node /mwt-tools/join-copy.mjs http://127.0.0.1:9222 /copy/server.json /out "$@"
code=$?
cp /profile/logs/main.log /out/main.log 2>/dev/null
kill "$electron" 2>/dev/null
exit "$code"
