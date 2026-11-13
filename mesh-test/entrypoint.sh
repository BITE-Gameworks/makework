#!/usr/bin/env bash
# Entry point of the mwt-app image (run under tini).
#   vite    the shared Vite dev server on 0.0.0.0:1420 (test config: every dependency pre-bundled at start)
#   client  one MakeWork desktop client: Xvfb, Electron pointed at http://localhost:1420/ (forwarded to mwt-vite, so
#           the page has a secure origin), CDP on 0.0.0.0:9223. Electron exiting stops the container, so
#           `podman kill` + `podman start` restarts the same profile (named volumes on /profile and /home/test).
#           On the host's network (topology lan, MWT_HOST_NET=1) clients share one network: each has its own display
#           (MWT_DISPLAY_NUM), CDP port (MWT_CDP_PORT, on 127.0.0.1) and reaches mwt-vite on localhost:MWT_VITE_PORT.
#   *       runs the given command (tools: node /mwt-tools/cdp-eval.mjs ...)
set -euo pipefail

mode="${1:-client}"
case "$mode" in
  vite)
    cd /app
    exec node node_modules/vite/bin/vite.js --config vite.mwt.config.ts --host "${VITE_HOST:-0.0.0.0}" --port "${VITE_PORT:-1420}" --strictPort
    ;;
  client) ;;
  *) exec "$@" ;;
esac

host_net="${MWT_HOST_NET:-}"
[ -n "$host_net" ] || : "${VITE_ADDR:?VITE_ADDR is required (the address of mwt-vite on the LAN of this client)}"
display="${MWT_DISPLAY_NUM:-99}"
cdp_port="${MWT_CDP_PORT:-9222}"
vite_port="${MWT_VITE_PORT:-1420}"
export HOME=/home/test DISPLAY=":$display"
mkdir -p "$HOME"

# Trust the test CA (Caddy's certificate for the redirected relay hosts and the TURN stub). Chromium reads the
# user's NSS database; kept on the HOME volume, so a restart finds it.
nssdb="sql:$HOME/.pki/nssdb"
if [ -f /certs/ca.crt ]; then
  mkdir -p "$HOME/.pki/nssdb"
  [ -f "$HOME/.pki/nssdb/cert9.db" ] || certutil -d "$nssdb" -N --empty-password
  certutil -d "$nssdb" -L -n mwt-ca >/dev/null 2>&1 || certutil -d "$nssdb" -A -t "C,," -n mwt-ca -i /certs/ca.crt
fi

# Leftovers of a killed run (the container's filesystem survives `podman kill` + `podman start`).
rm -f "/tmp/.X$display-lock" "/tmp/.X11-unix/X$display" /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie

# Chromium aborts every request in flight when an address changes; an IPv6 address leaving DAD right after start
# did that to the first page load. up.sh turns IPv6 off for clients; this covers a run without that.
for _ in $(seq 50); do [ -z "$(ip -6 addr show tentative 2>/dev/null)" ] && break; sleep 0.1; done

Xvfb ":$display" -screen 0 1600x1000x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
if [ -z "$host_net" ]; then
  socat TCP-LISTEN:1420,bind=127.0.0.1,fork,reuseaddr "TCP:${VITE_ADDR}:1420" &
  socat TCP-LISTEN:9223,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:9222 &
fi
for _ in $(seq 100); do [ -e "/tmp/.X11-unix/X$display" ] && break; sleep 0.05; done

args=(
  /app --no-sandbox --user-data-dir=/profile
  "--remote-debugging-port=$cdp_port" --remote-allow-origins=*
  --mute-audio --disable-gpu --password-store=basic
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
)
[ -n "${HOST_RULES:-}" ] && args+=("--host-resolver-rules=${HOST_RULES}")
# shellcheck disable=SC2206
[ -n "${MWT_ELECTRON_ARGS:-}" ] && args+=(${MWT_ELECTRON_ARGS})

echo "[mwt] ${MWT_CLIENT:-client} starting Electron (app ${MWT_GIT_SHA:-unknown}), vite ${VITE_ADDR:-localhost:$vite_port}"
export MAKEWORK_DEV_URL="http://localhost:$vite_port/"
exec "/app/node_modules/electron/dist/$(cat /app/node_modules/electron/path.txt)" "${args[@]}"
