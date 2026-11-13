# Mesh integration test

Runs N real copies of the desktop app (Electron + the current `app/src`, served by one shared Vite dev server) in
rootless podman containers, on local networks with local Nostr relays and TURN, so serverless servers can be tested
with many members without touching the public relays or production TURN. The harness (`harness/`) drives the
clients over CDP.

Dev only: nothing here is part of a build. electron-builder packages only `app/`'s `build.files` whitelist, the
release builder builds `app/` (the only package.json with an electron-builder `build`), and `app/`'s typecheck and
tests never reach this folder.

```sh
./up.sh 10 single            # build mwt-app if the source changed, start infra + 10 clients, write run/topology.json
./run-scenario.sh list       # the harness's scenarios
./run-scenario.sh s1 --join burst
./down.sh                    # remove all mwt-* containers, volumes (client profiles) and networks
```

`up.sh <N> <topology> [--no-turn] [--no-build] [--stagger ms] [--timeout s]` always starts from a clean slate.

| Topology | Clients | What connects them |
|---|---|---|
| `single` | all on `mwt-lan-a` | direct WebRTC (host candidates) |
| `split-bridge` | alternate lan-a / lan-b; client01 + client02 on both | direct within a LAN, members relaying across |
| `split-chain` | round-robin lan-a / lan-b / lan-c; client01 on a+b, client02 on b+c | a lan-a and a lan-c member are 2 hops apart |
| `split-turn` | alternate lan-a / lan-b, nobody on both | only TURN (coturn) across LANs |
| `public` | all on `mwt-pub` (internet) | the real public relays and STUN; only TURN is local |
| `lan` | all on the host's own network (node test) | real relays and STUN, no TURN; reaches the real nodes on the LAN |

`--no-turn` leaves coturn out; the TURN stub then answers 503 (like the worker at its monthly cap).

## Nodes and bots (scenario s8)

```sh
./up.sh 10 single --nodes 2 --bots 20      # 10 apps, 2 nodes, 20 headless bot members
./run-scenario.sh s8 --timeout-min 60      # owner online, owner offline, node restart
```

One 16-thread host holds about 30 members joining at once (apps + bots; `NODES-REPORT.md`). 50 at once
(`up.sh 20 ... --bots 30`, or s9 without `--wave`) overloads it (load 100+): joins time out and nearly every assertion
fails. That is the host, not the app; use a smaller count, or `--wave` in s9.

- `--nodes k` starts k MakeWork nodes (`mwt-node1..k`, `.31+` on the first LAN): the built `dist-node` exactly as
  `docs/nodes.md` deploys it, in image `mwt-node` (`node.Containerfile`, built from `mwt-app` so both run the same
  source), data in the volume `mwt-node-data-k` (kill + start keeps it). `--senders s` is their `--senders`.
  The image holds mediasoup's worker for calls through a node (the prebuilt one fetched at build time, or mwt-app's
  copy; the build starts one worker to prove it runs), and `--rtc-ports a-b` (40000-40199) is its call SFU's range,
  announced on the node's LAN address: members' media all comes in on its first port (the node's `--rtc-port`
  default, one UDP and TCP port for every member), the links between nodes take the rest.
- Nodes aren't members of the servers they host (since 2026-10-12): the member list (`memberListVisible`, the
  harness's `membersVisible` and `members().ui`) leaves them out; `members` / `members().all` still count them. The
  online count (`sync.peers()`) does count the connections to nodes.
- `--bots b` starts b bot members, `--bots-per p` (10) Node processes per container (`mwt-botsNN`, `.40+`, ports
  9300+). A bot (`bot/bot.ts`) is the app's sync code in plain Node (ledger, ServerSync over werift, content streams,
  nodes first) without UI and without registering as a node; the harness drives it over HTTP (`harness/lib/bots.mjs`:
  join, leave, post, fetch files, status, seen times, ledger digest). About 95 MB each when idle.
- Both reach the relays through `--add-host` entries pointing at Caddy and trust the test CA (`NODE_EXTRA_CA_CERTS`).
- s8 adds `nodes.csv` (each node's `status.json` every 5 s: commits, files, the sync scheduler's queued/active/limit)
  and `host.csv` (host load, free memory) to the run folder; node and bot logs are scanned for
  MaxListenersExceededWarning, "stopped draining" and unhandled failures. Findings: `NODES-REPORT.md`.

### s9: larger networks

```sh
./up.sh 10 single --nodes 3 --bots 40 --heal-after 1 --min-stripe-mb 4
./run-scenario.sh s9 --timeout-min 60 --wave 10 --wave-gap-s 20   # --copies 2 --history 1000 --files 8 --file-mb 2 --fallback-max 100
                                           # --stripe-mb 4 --parity 2
```

Checks the hub topology (every member connects to the nodes only; with more than 3 nodes, `--nodes 6`, only to its
group's nodes), the nodes splitting the files (`copies`; in 4 MiB pieces when `--file-mb` is over `--stripe-mb`, with
one parity piece per `--parity` pieces, and no node holding a split file whole; files are split from 20 GB in real use,
so a `--stripe-mb` under 20480 needs `up.sh --min-stripe-mb` at most that), a node killed (files still reachable, copies back after `--heal-after`
minutes), all nodes stopped (members fall back to the member room, above 12 members a grid of rooms: the bots' direct
connections are reported) and back, and two apps in a call connecting directly. The fallback is skipped above
`--fallback-max` members. Bots join all at once unless `--wave` sets a group size.

### s10: calls

```sh
./up.sh 6 single --nodes 2
./run-scenario.sh s10 --timeout-min 60
```

Calls in a mesh and through a node's SFU (ADR 0005), and screen sharing with its quality (ADR 0006), on Chromium's
fake mic (a beep; noise suppression is turned off so it isn't taken for noise) and camera, and Xvfb's screen. Bots
have no media, so every call member is an Electron client. Phases: a mesh call of 3 (hear, levels, camera, direct
peers); a mesh share to 4 viewers (the copies sharing the 8 Mbit/s upload budget, 2 Mbit/s each, the numbers per
profile, a quality change reaching every copy live, and a caller that opens another channel losing its copy while
the 3 left get 2.7 Mbit/s each, ADR 0019); a call of 6 through a node (the default threshold of 5, same node for
all, sound, camera, the share sent once and uncapped); the serving node killed (the call carries on); down to 4
members (back to a mesh); capacity 3 on 2 nodes (no node over 3, and the split call bridged so everyone hears
everyone, ADR 0007); and a
rejoin with calls through nodes forced. Driver helpers: `callState` (mode, node, which remote mic/camera/screen
arrives), `audioLevels` (peak dBFS of each remote stream as played), `setCamera`, `sharePicture`, `stopPicture`,
`setShareQuality`, `shareStats`, `screenSenderParams`, `setNoiseSuppression`. The computer's sound (`screen-sound`)
isn't covered: it needs PipeWire and a real capture device. `--phases mesh,share` runs only those phases (names:
mesh, share, node, node-lost, below, capacity, rejoin; node-lost needs node), handy for looking at a live failure
afterwards: the clients stay in the call. A failed wait says what each member that never got there last saw
(`saw`: mode, how many in the call, which of each other member's mic/camera/screen arrive). A mic "arrives" when
its track is live and not muted, or for audio when its receiver counted bytes: Chromium leaves a remote audio track
flagged `muted` after the sender's gate went quiet although its packets still play. Findings: `CALLS-REPORT.md`.

### s11: calls at scale

```sh
./up.sh 12 single --nodes 4 --bots 30
./run-scenario.sh s11 --timeout-min 90
```

One call bigger than any node takes, spread over every node and bridged (ADR 0007), under churn and server load. Every
Electron client is a call member (bots have no media); bots are server members who join, chat and get presence
meanwhile. `sfu_capacity` defaults to members / nodes, so the call needs every node and they bridge as a full mesh
(4 nodes: 6 bridges).
- **1 spread:** everyone joins at once. No node over its capacity, nobody on the mesh, and everyone hears everyone
  (12 members: 132 directions).
- **2 media:** a camera on one member of each node, then a screen share; every other member gets each.
- **3 churn:** rounds of a third of the members leaving and coming back while the bots chat; the time until everyone
  hears everyone again is measured per round.
- **4 node lost:** the busiest node is killed. Its members move to the other nodes or, past their capacity, to the
  mesh, and members on nodes and on the mesh still hear each other.
- **5 node back:** it starts again, a churn round runs, and nobody is left on the mesh.

Options: `--members`, `--capacity`, `--rounds`, `--hear-s`. The nodes' CPU and memory are in `nodes.csv`. The size
is what one host carries: Electron clients with fake media are the heavy part.

### s12: joining a big workspace

```sh
./up.sh 6 single [--nodes 1] [--bots 10]
BASE_FOLDER=/path/to/workspace-folder ./run-scenario.sh s12 [--history snapshot|full] [--within-s 5]
```

A real workspace's history as the base: `BASE_FOLDER` is a workspace kept in a folder; only its
`.makework/commits/*.jsonl` are read, mounted read-only. A test client can't join the real workspace (an invite has to
be signed by a member), so the owner's app makes a replica: every commit signed again with the app's own code, the
base owner's with the owner client's account and every other author's with a key made for it, user and account ids in
the data mapped to the new keys, a new genesis (new workspace id) and room secret. Same commits in the same order,
same tables. The base's own snapshot is left out; with `--history snapshot` (default) the owner makes a new one, so
joiners start from its state, with `--history full` they take the whole history. Then every other app (and bot) joins
at once with an invite. Each app's page records, on its own clock from its join call, when the channel bar first shows
the workspace's name and at least one channel (`s12.minimum`: within `--within-s`), when its data first arrived and
when it has everything the owner had (`s12.complete`, `--complete-s`). Nodes (`--nodes`) host it like in s8 and become
the source (with a snapshot, once they hold its state); bots' minimum is having the data. Per app, `metrics.json` also
has what arrived before its data (peer authentication steps, hellos, batches), the content it asked for and from whom,
and the KiB it received per half second. The base's file contents aren't copied, so members' requests for them answer
"missing" (expected). Findings: `JOIN-REPORT.md`.

### s13: call presence

```sh
./up.sh 8 single --nodes 2
./run-scenario.sh s13 [--phases burst,stagger,churn,rotate,newcomer,double] [--watch-s 90] [--within-s 5]
HARNESS_ENV="MWT_EXPERIMENTS=nocallroom" ./run-scenario.sh s13 --phases newcomer   # presence only through the nodes
```

Whether every member of a call lists every other one, and keeps listing them. Every second each member's participant
list (`participants()`, what the UI shows) is read, and each (observer, subject) pair is judged from the moment both
are in the call: listed within `--within-s`, never vanishing, listed at the end. Phases: all join at once; one by one
(`--gap-s`); churn rounds and a reload; a room secret rotation mid-call; a member rejoining the workspace mid-call and
joining the call at once; two joins of the call at once (its mic arrives, and leaving works). `instrument.js` traces
every presence sent, relayed, delivered, held or dropped. A relayed presence whose go-between doesn't name the sender
yet is `relay-in-held` (held until the go-between's news, `relay-release`); on builds before 2026-10-17 it was dropped,
`relay-in-dropped`. Both carry `relayKnows`, the size of the go-between's neighbor list here, null when there is none.
It also traces rows written and taken out, and room and access changes, in `W.voiceTrace`. Every member's full state and trace per phase go to
`<run>/s13/<phase>-cNN.json`, with the pairs in `<phase>-pairs.json`. On one LAN the call room always connects members
directly, which hides the path through the nodes; experiment `nocallroom` leaves it out, as where members can't connect to each
other. Findings: `CALLS-REPORT.md` "Participant list".

### s14: call load

```sh
./up.sh 8 single --nodes 2
./run-scenario.sh s14 [--phases idle,mesh3,mesh5,mesh8,silent8,node8] [--mic speech|beep] [--measure-s 20] [--settle-s 15]
./run-scenario.sh s14 --phases mesh8,ui      # the call of 8 with the speaking indicators styled otherwise
```

What a voice call costs each member, by size and path: kbit/s and packets/s over all its connections (taken
connection by connection, so one closing mid-window doesn't skew them), audio streams out and in, streams it passes on,
the main thread's busy time (CDP Performance metrics), frames, DOM changes, and the container's CPU. The mic talks like
a person by default (`speechMic`: syllables and phrases with pauses); `--mic beep` keeps Chromium's fake mic, a 20 ms
beep every 500 ms that makes every speaking indicator flicker. Phase `ui` measures the call of 8 again under stylesheets
put over the app (`uiVariants`: the indicators as before 2026-10-17, without transitions, hidden, without the scroll
fades, and as built again for the spread between two runs, which is a few points of main thread). The container CPU
in `podman-stats.csv` is the share of a core between two samples (podman's own one-shot figure is the average since
the container started). Findings: `CALLS-REPORT.md` "Call load".

### s15: channel switch

```sh
./up.sh 1 single
./run-scenario.sh s15 [--repeat 3] [--chat 100,1000,3000] [--files 2000] [--tasks 500] [--cells 6000] [--doc-lines 2000]
```

How smooth opening a channel is when it holds a lot of data. One client seeds a workspace through the plugins' own
calls (chat channels of each `--chat` size with reactions and replies, a folder, a board, a long doc, a sheet with
formulas) and a small second workspace, then opens each big channel from a small chat `--repeat` times and switches
workspaces both ways, with a Chrome trace of every switch (`PipelineReporter` frame reports, the views' enter
animations, the main thread's tasks). Per switch: when the slide in started, frames wanted / dropped / presented
without the page's update, the longest gap between presented frames, the time until the channel shows its content (no
skeleton left), and the main thread's tasks over 50 ms with what they spent their time on. Then the biggest chat is
scrolled up to its first message: older messages are added above what the reader sees, which must not move. These
clients render in software on Xvfb, so every frame costs more than on a desktop. Findings: `SWITCH-REPORT.md`.

### s16: call hold

```sh
./up.sh 3 single [--nodes 1]          # or split-turn: members reach each other only through TURN
./run-scenario.sh s16 [--phases pair,trio] [--hold-s 120] [--silence-s 4] [--heard-db -60] [--mic speech|beep]
./run-scenario.sh s16 --phases cut [--cut-at-s 30] [--cut-s 10] [--recover-s 30] [--slow-proof-ms 1500]
HARNESS_ENV="MWT_EXPERIMENTS=norecheck" ./run-scenario.sh s16   # the sync timer's hellos dropped while in a call
```

Whether a call keeps its sound for minutes. Each phase puts 2 (`pair`) or 3 (`trio`) members in a mesh call and
holds it for `--hold-s`, while every page samples (`W.holdStart`, instrument.js): every second the loudest each other
member's sound got (dBFS, from its player's analyser), the bytes of each member's mic, every connection's states and
audio/data bytes, which room's connection carries each call peer, how the member reaches it, and the call's mode. A
(listener, speaker) pair drops when, after it was heard, nothing above `--heard-db` comes for `--silence-s`: "no
packets" when the mic's bytes stopped too, else "packets, no sound". The pages also trace what might cut the sound
(`W.voiceTrace`): sync hellos and commit batches in and out, the rooms sync wants, route lists, streams put on and
taken off connections, nodes forgotten and back, the call's mode, the mics shown. Per phase, `<run>/s16/` gets each
member's timeline (`<phase>-timeline-cNN.json`: samples, trace, warnings, connections) and every drop with both
members' events from 10 s before to 2 s after (`<phase>-drops.json`); the summary compares how often each kind of
event comes in the 5 s before a drop with how often it comes in any 5 s of the hold (either member of a pair, both
times). Experiments: `norecheck` (hellos with `reply: true` dropped while in a call: the sync timer's, and the rare
one after a room secret handoff), `noroutes` (members ignore route lists but still answer asks for their own).
The `cut` phase holds a call of 3 and takes the last member off every network for `--cut-s`, `--cut-at-s` into the
hold, while it stays in the call (its app leaves and rejoins the call by itself on going offline and online). Once
back, it checks each proof it gets `--slow-proof-ms` late (`W.slowProofMs`), like a device busy reconnecting to
everyone; on one idle host both sides of a link check at once, and the race the phase is for never shows. Run it with
a node (`--nodes 1`): the others then know through the node that it is back in the call before its call links open.
Drops to and from it are expected: every pair must hear each other again within `--recover-s` of its return, no
member's call may still say "Connecting…" at the end, and any other drop fails as in the other phases. The trace
marks every stream that came from a peer not checked yet (`stream-early`). Findings: `CALLS-REPORT.md` "Call hold
(s16)".

## Node test (the real nodes on the LAN)

```sh
MWT_INVITE=<invite code> ./node-test.sh [--keep] [--remote-ip 192.168.2.213] [--apps 8] [--bots 20] [--down-min 3]
```

Stresses the real MakeWork nodes on the local network, not containers: the one on this computer (found by its
command line, `~/Desktop/node/dist-node`, data `~/.makework-node`; `--node-dir`, `--node-data`) and another one at
`--remote-ip`, which the test treats as a black box (it only sees what members get from it). Both must host the
workspace the invite is for (an invite with no use limit, made in the app). Scenario `nodetest` (`harness/scenarios/
nodetest.mjs`):
- **preflight:** the local node is restarted once under the test so its log is kept. The first app joins, and both
  nodes are authorized and online in its view. The workspace's call settings are read; the test changes none of them.
- **joins:** 7 apps and 20 bots join at once: the whole history, members connected only to the nodes.
- **messages:** a message round through the nodes.
- **call:** 6 apps in the first voice channel through a node, then 8: who serves it, everyone hears everyone, a camera.
- **failure:** the local node stopped. Members see it go and stay off the member room, and the call recovers or
  carries on. A message round and 5 rejoining bots go through the remote node alone. After `--down-min` the node starts
  again: it catches up, comes back online, serves a new call, and everyone converges.
- **cleanup:** every test account leaves without a note. `summary.md` lists them to kick, since they stay in the
  workspace's member list.

It uses a real workspace. Its members see the test accounts join, chat in its general channel and call in its first
voice channel, and the local node is down for a few minutes. Topology `lan`: rootless containers on a bridge can't
reach this computer's own LAN address, which the local node announces, so Vite (port 1421), the apps (CDP 9241+),
the bots (9300+, each container 20 ports apart) and the harness all run on the host's network, bound to 127.0.0.1.
`tools/node-agent.mjs` (127.0.0.1:9411, with a token) does what the harness can't from its container: stop, start,
`status.json`, CPU and memory, and the log of the local node. The node's user id comes from its code, whose pair secret
it keeps to itself; at exit the agent leaves the node running. The run folder adds `nodes.csv` (the local node every
5 s), `nodeviews.csv` (the first app's view of both nodes), `local-node.log` and `node-agent.log`. Findings:
`NODETEST-REPORT.md`.

## How it fits together

- `mwt-lan-a/b/c` (10.231.1-3.0/24) are `--internal`: no route outside, so nothing reaches the internet. Clients
  are `.100+N` (`mwt-client07` = `.107`), Caddy `.10`, coturn `.11`, Vite `.12`, the harness `.250`.
  `mwt-infra` (10.231.9.0/24) links Caddy to the relays (`.21`-`.25`).
- **Relays**: Trystero's Nostr strategy uses 5 relays picked from its default list by the appId (computed by
  `infra/up.mjs` from the installed Trystero). Each client's `--host-resolver-rules` maps those 5 hostnames to Caddy
  on its LAN, which terminates TLS (local CA, trusted in the client's NSS db) and proxies each one to its own strfry
  (`mwt-relay1..5`), so every event still arrives once per relay as in production. `MAP * ~NOTFOUND` blocks every
  other name (STUN hostnames included: Chromium resolves them through the same rules).
- **TURN**: `mwt-vite` runs with `VITE_TURN_URL=https://turn-stub.mwt.test/`; Caddy answers with static coturn
  credentials listing coturn's address on every LAN. coturn relays from its lan-a address.
- **Clients** (`entrypoint.sh client`): Xvfb, socat `127.0.0.1:1420 -> mwt-vite:1420` (the page origin stays
  `http://localhost:1420`, a secure origin), Electron with `--user-data-dir=/profile --remote-debugging-port=9222
  --mute-audio --disable-gpu` and fake media devices, socat `0.0.0.0:9223 -> 9222` for CDP. Profiles and HOME are
  named volumes (`mwt-profile-NN`, `mwt-home-NN`): `podman kill` + `podman start` brings the same account back.
  IPv6 is off in clients (an address leaving DAD after start made Chromium abort the first page load).
- **Vite** (`entrypoint.sh vite`, config `infra/vite.mwt.config.ts`) pre-bundles every dependency at start;
  `tools/warm-vite.mjs` loads the whole module graph before the first client starts.
- `run/topology.json`: topology, LANs, infra addresses, each client's LANs/IPs/CDP URL/host rules/start time, the
  podman API socket the harness gets, and the app version (`git sha+src hash`) baked into the image.

## Tools

- `tools/cdp-eval.mjs <cdp-url> <expression|-> [--console s] [--timeout s]`: evaluate in a client's page, e.g.
  `podman exec mwt-client01 node /mwt-tools/cdp-eval.mjs http://127.0.0.1:9222 'document.title'`, or from the LAN
  `podman run --rm -i --network mwt-lan-a mwt-app node /mwt-tools/cdp-eval.mjs http://10.231.1.101:9223 - < x.js`.
  DevTools only accepts an IP or localhost as Host.
- `podman logs mwt-clientNN` has Electron's log including the page console (`ELECTRON_ENABLE_LOGGING=1`; set
  `MWT_ELECTRON_LOGGING=0` before up.sh to turn it off). `MWT_ELECTRON_ARGS` adds Electron flags.
- `tools/join-copy.sh <folder> [out] [--interval ms] [--snapshot]`: the desktop app joining a copy of a real
  workspace's folder (`.makework/commits`, `server.json`; read-only) with no network at all, fed its history like a
  catch-up, then every channel opened; results in `<out>/result.json`. Needs only the mwt-app image (the working
  tree's `app/src` and `app/electron` are copied in). Findings: `JOIN-REPORT.md`.
