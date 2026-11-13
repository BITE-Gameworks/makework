#!/usr/bin/env bash
# Measures what a desktop joiner goes through while a big workspace's history arrives (JOIN-REPORT.md): the app as it
# is in the working tree (app/src and app/electron mounted over the mwt-app image's copy) runs in a container with no
# network at all, on an offline account, and takes a copy of a workspace's signed commits the way a peer sends them
# (batches of 200, in log order). The copy is mounted read-only; nothing reaches the real workspace's room.
#
#   [JOIN_COPY_STATE=state.json] tools/join-copy.sh <folder> [out dir] [driver options...]
#
# <folder>   holds .makework/commits/*.jsonl and .makework/server.json (a copy of a workspace kept in a folder).
# Driver options (tools/join-copy.mjs): --interval <ms> between batches (default 100, 0 = each after the previous is
# applied), --settle <s> of quiet that counts as done (default 15), --timeout <s> (default 900), --snapshot (start from
# the workspace's snapshot: JOIN_COPY_STATE is its state, e.g. written by tests/p2p/joinCopy.test.ts with
# MAKEWORK_JOIN_COPY_STATE_OUT).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/.." && pwd)
[ $# -ge 1 ] || { echo "usage: tools/join-copy.sh <folder> [out dir] [driver options...]" >&2; exit 1; }
copy=$(cd "$1" && pwd)
out=${2:-$here/results/join-copy-$(date +%Y%m%d-%H%M%S)}
shift $(( $# >= 2 ? 2 : 1 ))
mkdir -p "$out"
out=$(cd "$out" && pwd)
[ -f "$copy/.makework/server.json" ] && [ -d "$copy/.makework/commits" ] || { echo "$copy has no .makework/server.json and commits" >&2; exit 1; }

# The source as it is now: edits during a run would make Vite reload the page under the driver.
source="$out/source"
rm -rf "$source"
mkdir -p "$source"
cp -r "$repo/app/src" "$repo/app/electron" "$repo/app/index.html" "$repo/app/vite.config.ts" "$repo/app/package.json" "$source/"

name=mwt-joincopy
podman rm -f "$name" >/dev/null 2>&1 || true
podman run -d --name "$name" --network none --security-opt label=disable --shm-size 2g \
  -v "$source/src:/app/src:ro" \
  -v "$source/electron:/app/electron:ro" \
  -v "$source/index.html:/app/index.html:ro" \
  -v "$source/vite.config.ts:/app/vite.config.ts:ro" \
  -v "$source/package.json:/app/package.json:ro" \
  -v "$copy/.makework/commits:/app/public/_joincopy:ro" \
  -v "$copy/.makework/server.json:/copy/server.json:ro" \
  ${JOIN_COPY_STATE:+-v "$(cd "$(dirname "$JOIN_COPY_STATE")" && pwd)/$(basename "$JOIN_COPY_STATE"):/copy/state.json:ro"} \
  -v "$here/tools:/mwt-tools:ro" \
  -v "$out:/out" \
  --entrypoint /bin/bash localhost/mwt-app /mwt-tools/join-copy-inner.sh "$@" >/dev/null

echo "[join-copy] running in $name, results in $out"
code=0
podman wait "$name" >/dev/null || code=$?
podman logs "$name" > "$out/container.log" 2>&1 || true
podman rm -f "$name" >/dev/null 2>&1 || true
[ -f "$out/result.json" ] && node -e 'const r=require(process.argv[1]);console.log(JSON.stringify(r.summary,null,1))' "$out/result.json"
exit "$code"
