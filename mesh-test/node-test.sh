#!/usr/bin/env bash
# The node test: the real MakeWork nodes on the LAN under load, in a real workspace both nodes host (scenario nodetest,
# README "Node test"). It changes things in that workspace: its accounts join (and stay in the member list until
# kicked), post in its general channel, call in its first voice channel; the node on this computer is restarted and
# stopped for a few minutes. Nothing in the workspace's settings changes.
#
#   MWT_INVITE=<invite code, no use limit> ./node-test.sh [--keep] [--remote-ip 192.168.2.213]
#     [--node-dir ~/Desktop/node/dist-node] [--node-data ~/.makework-node] [--apps 8] [--bots 20] [scenario options]
#
# Starts tools/node-agent.mjs (the local node's stop, start, status and log), the members (up.sh <apps> lan --bots
# <bots>: on the host's network, the real Nostr relays and STUN), runs the scenario, keeps the agent's and the local
# node's logs in the run folder, and removes the members (unless --keep). The local node is left running.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/share/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
fi
[ -n "${MWT_INVITE:-}" ] || { echo "MWT_INVITE=<invite code> is needed: a code of the workspace both nodes host, with no use limit" >&2; exit 2; }

keep=0
remote=192.168.2.213
node_dir="$HOME/Desktop/node/dist-node"
node_data="$HOME/.makework-node"
apps=8
bots=20
pass=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=1 ;;
    --remote-ip) remote="$2"; shift ;;
    --node-dir) node_dir="$2"; shift ;;
    --node-data) node_data="$2"; shift ;;
    --apps) apps="$2"; shift ;;
    --bots) bots="$2"; shift ;;
    *) pass+=("$1") ;;
  esac
  shift
done

# This computer's address towards the remote node, where LAN members reach its node.
host_ip=$(ip -4 route get "$remote" | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
[ -n "$host_ip" ] || { echo "no route to $remote" >&2; exit 1; }
token=$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')
run_id="nodetest-lan-n${apps}-$(date +%Y%m%d-%H%M%S)"
out="$here/results/$run_id"
mkdir -p "$out"

MWT_AGENT_TOKEN="$token" node "$here/tools/node-agent.mjs" --dir "$node_dir" --data "$node_data" --log "$out/local-node.log" \
  --port 9411 --host 127.0.0.1 > "$out/node-agent.log" 2>&1 &
agent=$!
# The node prints its code (mwn1.<id>.<pair secret>) at start: the secret is blanked in the kept log, in place (the
# node goes on writing to the same file).
hide_secret() {
  node -e 'const fs = require("fs"); const f = process.argv[1];
    if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/(mwn1\.[A-Za-z0-9_-]+\.)[A-Za-z0-9_-]+/g, "$1<hidden>"));' "$1"
}
finish() {
  kill -TERM "$agent" 2>/dev/null || true
  wait "$agent" 2>/dev/null || true
  hide_secret "$out/local-node.log"
  if [ "$keep" = 1 ]; then echo "[node-test] members kept (./down.sh removes them)"; else "$here/down.sh" || true; fi
  echo "[node-test] results in $out"
}
trap finish EXIT
for _ in $(seq 1 50); do
  curl -sf -H "x-token: $token" "http://127.0.0.1:9411/proc" >/dev/null && break
  sleep 0.2
done
curl -sf -H "x-token: $token" "http://127.0.0.1:9411/proc" || { echo "the node agent didn't start: see $out/node-agent.log" >&2; exit 1; }
echo

"$here/up.sh" "$apps" lan --bots "$bots"
status=0
RUN_ID="$run_id" \
  HARNESS_ENV="MWT_INVITE=$MWT_INVITE MWT_AGENT_URL=http://127.0.0.1:9411 MWT_AGENT_TOKEN=$token MWT_REMOTE_IP=$remote MWT_LAN_IP=$host_ip" \
  "$here/run-scenario.sh" nodetest --timeout-min 75 "${pass[@]}" || status=$?
exit "$status"
