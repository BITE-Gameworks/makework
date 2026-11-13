#!/usr/bin/env bash
# Removes everything the mesh test started: mwt-* containers, volumes (client profiles) and networks, and the podman
# API service up.sh started (if it had to). Images and results/ stay. --quiet: no output (used by up.sh).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
quiet=0
[ "${1:-}" = "--quiet" ] && quiet=1
say() { [ "$quiet" = 1 ] || echo "[down] $*"; }

containers=$(podman ps -a --format '{{.Names}}' | grep '^mwt-' || true)
if [ -n "$containers" ]; then
  say "removing containers: $(echo $containers)"
  # shellcheck disable=SC2086
  podman rm -f -t 2 $containers >/dev/null
fi
volumes=$(podman volume ls --format '{{.Name}}' | grep '^mwt-' || true)
if [ -n "$volumes" ]; then
  say "removing $(echo "$volumes" | wc -l) volumes"
  # shellcheck disable=SC2086
  podman volume rm -f $volumes >/dev/null
fi
networks=$(podman network ls --format '{{.Name}}' | grep '^mwt-' || true)
if [ -n "$networks" ]; then
  say "removing networks: $(echo $networks)"
  # shellcheck disable=SC2086
  podman network rm -f $networks >/dev/null
fi
pidfile="$here/run/podman-service.pid"
if [ -f "$pidfile" ]; then
  pid=$(cat "$pidfile")
  if kill "$pid" 2>/dev/null; then say "stopped podman system service ($pid)"; fi
  rm -f "$pidfile"
fi
rm -f "$here/run/topology.json"
say "done"
