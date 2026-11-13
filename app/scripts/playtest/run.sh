#!/usr/bin/env bash
# run.sh "<async js using LH>"   runs it in the running dev app (CDP_PORT, default 9223) with the LH helpers loaded.
# Example: run.sh "await LH.init('Lighthouse'); return await LH.task('general', '@Beacon hi')"
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)" >/dev/null 2>&1
node "$here/cdp.mjs" eval "(async()=>{ $(cat "$here/lh.js") ; if (window.__lhname) await LH.init(window.__lhname); return JSON.stringify(await (async()=>{ $1 })(), null, 1); })()"
