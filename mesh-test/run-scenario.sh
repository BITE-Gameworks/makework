#!/usr/bin/env bash
# Runs one harness scenario against the environment up.sh started: run-scenario.sh <scenario> [args...]
# The harness container (image mwt-harness, built from harness/Containerfile with harness/ as context) joins every
# LAN of run/topology.json (it does no WebRTC, so it bridges nothing) and gets:
#   /harness   harness/ (code)          /results   results/ (output, RUN_ID subfolder is the harness's choice)
#   /run-info  run/ (topology.json)     /run/podman/podman.sock   the rootless podman API (PODMAN_SOCK)
# Env: RUN_ID (only if set), TOPOLOGY_FILE/MWT_TOPOLOGY, MWT_SCENARIO; HARNESS_ENV="A=1 B=2" passes more.
# BASE_FOLDER=<a workspace's folder> mounts its .makework/commits read-only as /base/commits (s12).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/share/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
fi
scenario="${1:?usage: run-scenario.sh <scenario> [args...]}"
topology="$here/run/topology.json"
[ -f "$topology" ] || { echo "no run/topology.json: start the environment with up.sh first" >&2; exit 1; }

if [ -f "$here/harness/Containerfile" ]; then
  podman build -q -t mwt-harness -f "$here/harness/Containerfile" "$here/harness" >/dev/null
elif ! podman image exists mwt-harness; then
  echo "no harness/Containerfile and no mwt-harness image" >&2
  exit 1
fi

# Topology lan: the harness is on the host's network like the members (their CDP and the bots are on 127.0.0.1).
mapfile -t nets < <(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (t.hostNetwork) console.log("--network=host");
  else for (const lan of t.lans) console.log(`--network=${lan}:ip=${t.harnessIps[lan]}`);
' "$topology")
socket=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).podmanSocket)' "$topology")

mkdir -p "$here/results"
extra=()
# Without RUN_ID the harness names the run itself (<scenario>-<topology>-n<N>-<time>).
[ -n "${RUN_ID:-}" ] && extra+=(-e "RUN_ID=$RUN_ID")
for kv in ${HARNESS_ENV:-}; do extra+=(-e "$kv"); done
if [ -n "${BASE_FOLDER:-}" ]; then
  [ -d "$BASE_FOLDER/.makework/commits" ] || { echo "BASE_FOLDER has no .makework/commits" >&2; exit 1; }
  extra+=(-v "$(cd "$BASE_FOLDER/.makework/commits" && pwd):/base/commits:ro")
fi

podman rm -f mwt-harness >/dev/null 2>&1 || true
# The code comes from the host (edit and rerun without a rebuild); its dependencies from the image
# (the anonymous volume shadows harness/node_modules, so a host checkout without `npm install` works too).
exec podman run --rm --name mwt-harness --security-opt label=disable "${nets[@]}" \
  -v "$here/harness:/harness" -v /harness/node_modules -v "$here/results:/results" -v "$here/run:/run-info" \
  -v "$socket:/run/podman/podman.sock" \
  -e PODMAN_SOCK=/run/podman/podman.sock -e TOPOLOGY_FILE=/run-info/topology.json -e MWT_TOPOLOGY=/run-info/topology.json \
  -e MWT_SCENARIO="$scenario" "${extra[@]}" \
  -w /harness mwt-harness node /harness/run.mjs "$@"
