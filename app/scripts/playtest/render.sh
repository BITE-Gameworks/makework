#!/usr/bin/env bash
# render.sh <design-channel> <out.png>   a rough picture of a design channel (the canvas itself can screenshot black on some displays)
here="$(cd "$(dirname "$0")" && pwd)"
"$here/run.sh" "return await LH.render('$1')" | python3 -c "import sys,json,base64;d=json.loads(sys.stdin.read());open('$2','wb').write(base64.b64decode(d.split(',',1)[1]));print('saved $2')"
