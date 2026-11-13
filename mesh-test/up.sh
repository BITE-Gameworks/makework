#!/usr/bin/env bash
# Starts the mesh test environment: up.sh <N> <single|split-bridge|split-chain|split-turn|public> [--no-turn]
# [--no-build] [--stagger ms] [--timeout s] [--nodes k] [--bots b] [--bots-per p] [--senders s] [--heal-after min]
# [--min-stripe-mb m].
# Tears down any previous run first. Details in infra/up.mjs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/share/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
fi
exec node "$here/infra/up.mjs" "$@"
