#!/usr/bin/env bash
# Entry point of the mwt-node image (podman runs it with --init).
#   node   a MakeWork node (the built dist-node) with its data in /data (a named volume, so kill + start keeps it);
#          calls through it (mediasoup) listen on RTC_PORTS, announced on NODE_IP
#   bots   BOTS stress-test bot members (bots.mjs), ports 9300+
#   *      runs the given command (e.g. node /node/makework-node.mjs code --data /data)
# Both trust the test CA (NODE_EXTRA_CA_CERTS) and reach the local relays through --add-host entries from up.sh.
set -euo pipefail
mode="${1:-node}"
case "$mode" in
  node)
    : "${NODE_IP:?NODE_IP is required: the address of this node on its LAN}"
    echo "[mwt] node ${MWT_NODE:-node} (app ${MWT_GIT_SHA:-unknown}) on ${NODE_IP}, senders ${SENDERS:-32}, heal after ${HEAL_AFTER:-15} min, rtc ${RTC_PORTS:-40000-40199}"
    exec node --trace-warnings /node/makework-node.mjs start --data /data --address "$NODE_IP" \
      --url "http://${NODE_IP}:8080" --port 8080 --geoip off --senders "${SENDERS:-32}" \
      --heal-after "${HEAL_AFTER:-15}" --cache-gb "${CACHE_GB:-2}" --rtc-ports "${RTC_PORTS:-40000-40199}"
    ;;
  bots)
    echo "[mwt] ${BOTS:-1} bots from bot${BOT_BASE:-1} (app ${MWT_GIT_SHA:-unknown})"
    exec node /node/bots.mjs
    ;;
  *) exec "$@" ;;
esac
