# Calls test report: mesh calls, calls through a node, screen sharing

2026-10-13 · app `1b9d920` plus the working-tree changes (calls through nodes phase 1, stream quality, the fixes
below) · scenario `s10` in `mesh-test/` (`./up.sh 6 single --nodes 2`, `./run-scenario.sh s10 --timeout-min 60`) ·
raw data in `mesh-test/results/s10-*`

## Summary

**Question:** do calls work end to end on real clients and real nodes? That means sound, camera and screen share in
a mesh call and through a node's SFU (ADR 0005), the screen-share quality (ADR 0006), and a call surviving its node.

**Answer:** yes, after ten fixes. The last run passed 32 of 32 checks
(`results/s10-single-n6-20261013-213600`). Before the fixes, no call through a node had ever carried sound or
pictures, and a mesh call's members often didn't hear each other.

| run | result | what it showed |
|---|---|---|
| `…-185211` | 13/31 | No SFU call ever formed; mesh sound missing |
| `…-fix-194401` | 18/32 | SFU calls formed, but no media: "caps is not an object" on every member |
| `…-204357` | 16/32 | Node path sends; mesh presence lost; consumers refused; a dead node kept |
| `…-210913` | 24/32 | Mesh and share all pass; the node call splits into several routers |
| `…-212401` | 28/32 | Node call passes; leaving a dead node silences every mic |
| `…-213600` | **32/32** | Everything passes |

## Numbers from the passing run

| phase | hear everyone (p50 / max) | where | peak dBFS (p50) | other |
|---|---|---|---|---|
| 1 mesh (3) | 17.3 s / 17.3 s | mesh | -18 | camera 1.0 s |
| 2 share (5) | – | mesh | – | picture 1.0 s / 1.2 s |
| 3 node (6) | at once | node1, switch 1.0 s | -9 | camera 1.1 s, picture 1.0 s |
| 4 node lost | back in 20.3 s | node2 | -12 | node1 killed |
| 5 below (4) | 0.6 s | mesh | -9 | – |
| 6 capacity 3 (6) | – | all 6 on node1 | -21 | nobody unheard |
| 7 rejoin (2, forced) | – | node1 | -34 | – |

Screen share in a mesh with 4 viewers (each copy capped at 2.5 Mbit/s): smooth 1280x720 at 19 fps, 0.71 Mbit/s;
balanced and sharp 1920x1080 at 8–9 fps, about 0.35 Mbit/s, with the encoder `cpu`-limited once. That is six
Electron clients and Xvfb on one host, so the frame rates say more about the host than about the app. Through a node,
the sharer uploads one copy at the profile's 4 Mbit/s, uncapped.

## What was wrong (all fixed)

Calls through a node, client (`app/src/p2p/sfu.ts`):
1. **`Device.load` was given the capabilities bare.** mediasoup-client takes `{ routerRtpCapabilities }` and threw
   "caps is not an object", so no member ever sent or received through a node.
2. **Closing a producer stopped the app's own track.** mediasoup-client's `stopTracks` defaults to true. Leaving a
   node that died closed the producers and so ended the member's mic, which the mesh sends too: silence everywhere
   after a node loss. Producers are now made with `stopTracks: false`.
3. **Stale and ended tracks.** A queued run used the streams it was queued with ("not sending mic: track ended"),
   and a producer kept its old track after the mic chain restarted. The link uses the newest streams, skips ended
   tracks, and swaps a new track in with `replaceTrack`.
4. **A kind turned off was closed only locally.** The node still had the producer and refused a second one of the
   same kind, so a camera turned off and on again never came back. The node is now told (`close`).
5. **A closed producer left viewers on a dead track.** A consumer's track doesn't end when the node's producer
   closes. The `producerClosed` notice now closes the consumer and clears the view.
6. **Notices ran outside the link's queue.** Two at once made two recv transports; the node kept the second, so
   consumers on the first got nothing. They now run in the queue.
7. **A dead node was never left.** The call stayed "through the node" with nobody hearing anybody. A node gone from
   the online nodes, or a transport that failed, now sends the call back to the mesh and on to the next node (20 s
   in the test).

Calls through a node, node side (`app/src/node/sfu.ts`):
8. **`router.canConsume` was given a bare id** and refused every consumer. It takes `{ producerId, rtpCapabilities }`.
9. **Members joining at once each made their own router.** Each `open` awaited `createRouter` and stored its own call,
   and only the last one stayed. Members on the others had connected transports and producers that nobody could
   consume, and they heard of nobody. They now share the router being made.

Mesh calls (`app/src/p2p/voice.ts`):
10. **One lost presence message left a member out of the call.** Members first reach each other through a node's
    relay; the call's own room connects them directly later. A peer that was reachable already never fires
    `onPeers` again, so the relayed presence was all they got. When it was lost, its mic arrived but nobody knew whose
    it was, and they sent nothing back. Presence now goes out again on every new direct connection, and every 20 s
    while in a call.

Harness:
- A remote audio track stays `muted` in Chromium after the sender's noise gate went quiet, even though its packets
  arrive and play. `callState` now counts the receiver's bytes for audio.

## At scale (s11, 2026-10-14)

12 Electron members, 4 nodes with capacity 3, 30 bots chatting. Final run **26/26**
(`results/s11-single-n12-20261014-012334`), and again 26/26 in the full suite on rebuilt images
(`results/s11-single-n12-20261014-042515`; recovery after the node was killed 28.3 s). One suite run in between failed
25/26: a member on a node never heard one other member after the kill, because the node refused a consume once and the
app dropped it. Consumes are now retried every 1.5 s, up to 10 tries. A later regression run failed 20/26
(`results/s11-single-n12-20261014-104859`): a member's direct connection to its node broke right after the join. The
node stayed "online" through the mesh relay, every call request failed, and the member stayed there unheard for 16
minutes. Now a request that finds no direct connection to the joined node makes the member move on, like a failed
transport. The rerun passed 26/26 (`results/s11-single-n12-20261014-111808`).
- **Spread:** the call spreads over the nodes each member reaches (members reach only their node group). A node whose
  members reach no other node with room takes them past its capacity, as their last resort, so nobody falls to the
  mesh and the call stays whole over the bridges.
- **Media:** cameras on four nodes reach everyone in 3-5 s, and a screen share in 2 s.
- **Churn:** three rounds of a third of the members leaving and coming back; everyone hears everyone again in under 1
  s once back.
- **Node lost:** the busiest node killed; its members move, and everyone hears everyone 30.8 s after the kill.

Two bugs found on the way:
- **Node groups capped the call.** A call could only use the nodes each member reaches, so the overflow went to the
  mesh, and a call split between nodes and the mesh lost directions. Fixed with the soft capacity (ADR 0007).
- **A late end wiped a member's new stream.** A member that moved node lost its new mic when the end of its old one
  arrived late. Fixed by clearing the view only for the producer it shows (found with the new `[bridge]`/`[sfu]` logs
  and the per-phase bridge snapshots).

## Participant list (s13, 2026-10-17)

Reported: in a workspace with nodes, some members in the same call are missing from each other's participant list.
Scenario `s13` (`./up.sh 8 single --nodes 2`) polls every member's list (`voice/state.ts` `participants()`) each
second and records, per pair, when the other first shows and every time it vanishes. `instrument.js` traces every
presence sent, relayed, delivered, dropped, written and taken out (`W.voiceTrace`, dumped per member to
`<run>/s13/<phase>-cNN.json`).

| run | call room | result |
|---|---|---|
| `s13-all-try3` | on | 56/56 pairs within 5 s in every phase (burst, stagger, churn, reload, rotate); 14 relayed presences dropped, covered by the direct links |
| `s13-nocallroom-try4` | off (`MWT_EXPERIMENTS=nocallroom`) | burst: the owner lists everyone after 8.7 s; other phases pass |
| `s13-newcomer-nocall-try5` | off | a member rejoining the workspace mid-call and joining it: it and the 7 callers see each other after **18.8 s** |
| `s13-newcomer-try6` | on | the newcomer sees 3 of the 7 callers after 13.4 s (their call-room links came late) |

On one LAN the call room always connects members directly, which hides the path through the nodes. On real networks many
member-to-member connections fail; then presence goes only through a node, which is what `nocallroom` simulates.

Line numbers below are those before the fixes.

**Cause: `Mesh.deliver` (`app/src/p2p/mesh.ts:435`) drops a relayed message unless the go-between's neighbor list, as this
member last heard it, contains the sender.** Two ways that list is missing or behind:
1. **A peer that turns member mid-connection never gets the go-between's full list.** A joiner connects to the nodes in
   its invite's room while its access is "invite". Member-level actions (mesh lists, relays, voice) are blocked both
   ways while either side isn't a member (`RoomGroup.allowed`), and a blocked message from a peer that already has
   access is dropped, not held (`roomGroup.ts:248`). When the join lands, `refreshPeerAccess` raises the peers to
   "member" in place: `authorizePeer` fires `onPeerJoin` only for a peer's first access and `setLocalAccess` fires
   nothing (`roomGroup.ts:62-80`). So `Mesh.peerJoined`'s full list (and VoiceLink's first presence) went out while
   blocked and never again. Deltas are ignored without a full list (`receiveDelta`), and the next full list comes
   with the 30 s timer. Until then every message the node relays to the new member is dropped (try5: all 8 callers'
   presences at 0.8 s, `relayKnows: null`), and the new member reaches nobody through that node.
2. **A just-connected sender isn't in the go-between's list yet.** Node deltas are batched for 1 s (`deltaAfterMs`). The
   newcomer's own presence reached every caller through the other node at 0.0 s and was dropped there (the node's
   list had 8 peers, not the newcomer; try5 `newcomer-c01.json`).

Presence goes once per new route (`onPeers`, `onDirectPeers`) and then only with the 20 s refresh, so a dropped one
stays lost until that tick: 18.8 s in try5. It can be later: the refresh is dropped too while the list is still
missing, up to the node's 30 s list. Probably the same cause as the 17.3 s first mesh call below (s10's members are
joiners too). Not checked yet.

Also found:
- **The call room splits after a room secret change.** `joinCall` joins `<ws>:call:<id>` under the secret current at
  that moment, and `rotateSecret` never moves the "call" room (it isn't in `joined`). After the rotation in try3, the
  two members who rejoined the call were alone together in the new secret's call room, and the five who stayed were
  in the old one. Presence still went through the node, so the list was fine. But mesh media doesn't go through nodes
  (`mediaVia`), so in a mesh call (under `sfu_min_members`) members on different sides would not hear each other.
- **Two `joinVoice` at once leave a stale mic chain, and then leaving throws.** `resumeCall` and a join started in
  the same millisecond (try4, newcomer). The second `startMic` → `startMicInput` stops the old input (its source
  disconnected from everything). Then `startMicSend` → `stopMicSend` → the old `stop()` runs `input.disconnect(first)`
  (`voice/state.ts:678`), which throws `InvalidAccessError: … not connected`. `micSend` keeps the dead chain, so every
  later `leaveVoice` throws in `stopMic`: `setCall(null)` never runs and `leaveServerless` fails too.

Fixed (2026-10-17, same day):
- `RoomGroup.onPeerMember` says when members' messages with a connected peer start or stop. The mesh then sends its
  list again and announces the peer. `RoomGroup` holds members' messages while either side isn't a member yet, and the
  mesh's lists name only peers members' messages reach.
- `Mesh.deliver` holds a relayed message whose go-between doesn't name the sender yet, for up to 5 s
  (`heldRelayed`), and lets it through on the go-between's next list or delta.
- A peer whose direct connection closes while a neighbor still reaches it is relayed at once. A later run
  (`s13-fixed-newcomer-nocall`) showed the newcomer vanishing from 5 lists for 2 s: it left the member room for the
  hub, and the members waited `relayAfter` before relaying it.
- On `rotateSecret` a call keeps its room under the old secret and joins the one under the new secret too.
- `voice/state.ts` runs joins and leaves one after another, a join of the call it is in does nothing, and audio
  teardown never throws.
- Harness: `callState` and `audioLevels` read `call().workspaceId`. Since the server→workspace rename they returned
  null, so s10/s11's call checks couldn't pass.

| run (after the fixes) | call room | result |
|---|---|---|
| `s13-fixed2-all` | on | **27/27**: every phase (burst, stagger, churn, reload, rotate, newcomer, double), all 56 pairs within 5 s, nothing vanished or dropped |
| `s13-fixed2-nocall` | off | **22/22**: burst, churn, reload, newcomer (14 presences held, all let through), double |
| `s13-fixed3-all` | on | **27/27** after the review fixes (`onPeers` told again, the rotation's fallback) |
| `s13-fixed3-nocall` | off | 26/27, every phase: the reloaded member is listed after 5.4 s, nothing dropped or held (its app reconnecting to the nodes after the reload; 5.0 s and a pass in the two runs before) |

Unit tests: `tests/p2p/sync.test.ts` covers a new member reaching the others through the node as soon as its join
lands, the features that greet a new peer (`onPeers`) telling it again then, and a call's members kept together
across a secret change. `tests/p2p/mesh.test.ts` covers a relayed message
held until the go-between names the sender (and a forged sender still dropped), and relaying at once when a direct
connection closes.

## Call load (s14, 2026-10-17)

Reported: in calls the whole app slows down, and the machine's network use stays high for the whole call. Scenario
`s14` (`./up.sh 8 single --nodes 2`): voice only, each phase settled, then measured on every member. Median per member;
download was about the same as upload, audio streams out were always N−1, and nothing was forwarded for other members.

### Before (`results/s14-try1`, Chromium's beeping fake mic)

| phase | upload kbit/s | packets out/s | main thread busy | style recalcs/s |
|---|---|---|---|---|
| idle | 3 | 2 | 3 % | 0 |
| mesh 3 | 94 | 120 | 8 % | 42 |
| mesh 5 | 180 | 234 | 11 % | 60 |
| mesh 8 | ~310 | ~400 | 16 % | 61 |
| mesh 8, all muted | 145 | 402 | 5 % | 0 |
| 8 with calls through nodes on (stayed mesh) | 313 | 409 | 15 % | 61 |

What it showed, and what was done (all in the working tree, 2026-10-17):

- **No silence suppression.** Every copy of a mic sent 50 packets a second even muted, and at that rate the packet
  headers outweigh the audio. Fixed: Opus DTX in mesh calls (`app/src/p2p/dtx.ts`: `usedtx=1` in every description a
  member is given, through Trystero's `rtcPolyfill`, the vendored core unchanged) and `opusDtx` for sound through a node.
- **A running call didn't move to a node** when calls through nodes were switched on: `SfuLink` re-checked the
  settings only when the call's members changed. Fixed: it re-checks on every `nodes_settings` change, both ways.
- **The main thread's cost was the speaking indicators**, and not their script (about 1 %): every change makes the
  page draw a frame, and a running CSS transition costs every frame it runs, even a composited `transform` one (a
  Chrome trace: 60 main frames a second updating the dots' transitions, 6 elements restyled per frame). The 90 ms
  transition on each dot's size restarted on every level change, so while anyone spoke one was always running.
  Stopping every requestAnimationFrame loop (the dev `PerfMeter`'s too) changed nothing, and neither did turning the
  scroll fades off. Fixed: one meter for all players (100 ms, one batch of changes per tick, so at most 10 frames a
  second however big the call), speaking kept per speaker (a flip re-runs only that speaker's indicators), levels
  written only while speaking and in quarter steps, levels shown without a transition, speaking on/off fading by a
  colored copy's opacity.
- **"Idle is already expensive" (41 % of a core) was the measurement**: podman's one-shot stats give the average since
  the container started. Between two samples an idle client uses about 3 % (8 % in the run below, with the call's
  other clients busy on the same host). `harness/lib/podman.mjs` now reports CPU between samples, for every scenario
  (s8's node CPU figures were the same average).
- **The fake mic flickers**: a 20 ms beep every 500 ms, so every indicator went on and off twice a second, which no
  voice does. s14 now gives every client a mic that talks like a person (`speechMic`, `--mic beep` for the old one).

### After (`results/s14-final`, speech-like mic, 30 s windows)

| phase | upload kbit/s | packets out/s | main thread busy | style recalcs/s | container CPU |
|---|---|---|---|---|---|
| idle | 3 | 2 | 3 % | 0 | 8 % |
| mesh 3 | 83 | 94 | 4 % | 8 | 27 % |
| mesh 5 | 170 | 192 | 5 % | 14 | 39 % |
| mesh 8 | 291 | 332 | 8 % | 26 | 60 % |
| mesh 8, the indicators' styles from before | 290 | 333 | 12 % | 48 | 73 % |
| mesh 8, no transitions at all | 290 | 334 | 7 % | 10 | 53 % |
| mesh 8, no indicators | 295 | 337 | 6 % | 10 | 49 % |
| mesh 8, as built again | 289 | 330 | 9 % | 30 | 64 % |
| mesh 8, all muted | 33 | 64 | 4 % | 0 | 30 % |
| 8 through a node | 51 | 48 | 6 % | 16 | 40 % |

- **Network:** a muted call of 8 sends 33 kbit/s and 64 packets/s per member (was 145 and 402); speech with its
  pauses saves about a fifth of the packets too. Through a node a member sends one copy: 51 kbit/s and 48 packets/s
  instead of 291 and 332, and receives the same as in a mesh.
- **Main thread:** in a call of 8 the indicators now cost 2-3 points above none at all (8-9 % against 6 %), where the
  styles from before cost 6. Two measurements of the same thing differ by about a point. Every member still receives
  N−1 streams in a mesh, so bigger calls should go through a node: from 5 members by default (`sfu_min_members`).
- **Not measured here:** a real GPU and screen (these clients render in software on Xvfb, so a frame costs more than
  on the user's machine), and a big workspace's DOM (these pages have about 300 elements). How much of the slowdown the
  user saw these fixes remove needs a call in their own app.

## Call hold (s16, 2026-10-20)

Reported: in mesh calls, members stopped hearing each other 10–20 s in. Members were on different networks in a
small workspace, with a node online or not, and it was first seen on 2026-10-20 (after the route lists, ADR 0015).
The user's hypothesis was that the sync timer's re-hello drops connections during calls. s16 holds calls of 2 and 3
for 120 s each and samples every second who hears whom, with the sync, room, mesh and connection events around any
drop.

| run | setup | pair (2) | trio (3) | notes |
|---|---|---|---|---|
| `s16-single-nonodes-2` | one LAN, no nodes (member room + call room) | 2/2 heard, 0 drops | 6/6 heard, 0 drops | 14 timer hellos out, 28 hellos in per member in the trio; every connection stayed `connected` |
| `s16-single-node1-1` | one LAN, 1 node (hub; the call room connects members) | 0 drops | 0 drops | 18 timer hellos out, 40 in; the node sent no route lists (it reaches everyone directly) |
| `s16-split-turn-1` | two LANs, TURN only | 0 drops | 0 drops | every connection of the lan-b member over the TURN relay |
| `s16-single-node1-events` | as `node1-1`, with the call event log | 0 drops | 0 drops | `Call:` lines only for links opening and the pair's end |

- **Not reproduced.** No pair dropped for 4 s or more in any setup. The sync timer's re-hellos went over the call's
  own connections throughout every hold without cutting anything, so the hypothesis didn't hold here. Route lists
  aren't sent between plain members, and a node that reaches everyone directly sends none. The `norecheck`/`noroutes`
  experiments and a build from before the route lists weren't run, since there was no drop to compare.
- **Found on the way (fixed):** since the workspace order change (2026-10-20), leaving a workspace threw in the
  workspace bar, and Solid then dropped the queued effects. The order froze, and so did every scenario's
  `createServer`, because `prepare` leaves old workspaces first. The bar now renders a button only while its data is
  there, and `removeWorkspace` drops the workspace from the order before its data (AGENTS.md, "Rules"). Also `mesh-test/Containerfile` didn't copy the
  postinstall script (`app/scripts/clean-modules.mjs`, 2026-10-19), so no image built, and instrument.js still read
  the far lists that today's mesh rewrite removed.
- **What the containers don't cover:** real NAT and public relays, real devices, and nodes on older builds. For these
  the app now keeps the call's events: Call diagnostics > "Call events", plus `Call:` console lines. "Copy as text"
  from a call that went silent shows what came just before.

## Stuck "Connecting…" after a reconnect (s16 cut, 2026-10-21)

Reported: after a member reconnects mid-call, its own call view says "Connecting to the call…" for good, while the
others hear it.

**Cause: `RoomGroup` dropped a stream from a peer this device hadn't verified yet** (`listen`, `onPeerStream`), while
it held that peer's messages until then (`early`). Each side of a new link places its streams the moment it has
checked the other's proof (`Mesh.peerJoined` → `reroute`), once both already know of each other's call rows through
a go-between (the node). The faster side's mic came before the slower side had checked its proof. It was dropped, and
nothing sent it again: the sender's mesh had it on the link, and Trystero emits a stream once. The member coming back
is usually the slower one (it checks everyone's proof at once), so it is the one that can't hear and stays
"Connecting…". A first join in a workspace without a node is safe: the call goes over member-room links verified long
before.

**Fixed:** `RoomGroup` holds such streams (`earlyStreams`, by stream id, at most 64 per peer) and hands them over once
the peer is verified or this device becomes a member. They are dropped when the peer leaves or is refused, and a
held stream with no live track is skipped (`tests/p2p/roomGroup.test.ts`, `tests/p2p/mesh.test.ts` "gets the mic of
a member who checked this one's proof first").

New s16 phase `cut`: a call of 3, the last member off every network for 10 s and back while in the call, then
checking proofs (and room secrets handed over) 1.5 s late (`--slow-proof-ms`, `W.slowProofMs`). The trace marks each
stream from a peer not verified yet (`stream-early`).

| run | build | setup | result |
|---|---|---|---|
| `s16-single-n3-20261021-173312` | fixed | no node, no delay | pass |
| 3 runs, 17:36–17:44 | old | no node, no delay | pass: not reproduced, both sides check at once on one idle host |
| 3 runs, 17:45–17:53 | old | 1 node, no delay | pass; the cut lasted 27 s, because the harness waited on the cut page (fixed) |
| `s16-single-n3-20261021-175626`, `-175917` | old | 1 node, proofs late | pass: the room secret handed over verified the peer first, undelayed |
| `s16-single-n3-20261021-180301` | old | 1 node, proofs and secrets late | **fail**: c03 never hears c01 and c02 again and stays "Connecting…"; both mics `stream-early` at +45.8 s, proofs checked at +47.3 s, no mic after |
| `s16-single-n3-20261021-180656`, `-180937` | fixed | 1 node, proofs and secrets late | **pass** 10/10: both mics held at +44.0 s, shown at +45.5 s |
| `s16-single-n3-20261021-182725` | fixed, after the second review | 1 node, proofs and secrets late | **pass** 11/11 (with `s16.cut.slow`) |

Also found:
- A member that joined with an invite that is still open proves that invite again on every connection, and the other
  member hands it the room secret each time (`handOffSecret`). Harmless, but extra signing and a secret change
  checked on every reconnect.
- Not changed here: `RoomGroup.early` keeps 16 messages per peer and drops the rest without a word. Most come again on
  a timer, but `relay-media` orders are sent once, so one lost there leaves a member whose media goes through another
  member unheard.

## Still open

- **The first mesh call often takes 17.3 s before everyone hears everyone.** The first voice presence between two
  members is often lost, and the next 20 s refresh heals it: 17.3 s is the time to that tick, and the one 1.1 s run
  lost nothing. A run that sent the refresh only to members known to be in the call never healed and failed (two
  members never heard each other). Probably the relayed-presence drops in "Participant list (s13)" above.
  Later calls take under a second.
- ~~**Node capacity.**~~ Fixed on 2026-10-13 (ADR 0007). The check is exact (`SfuCall.tryJoin`), and the nodes
  serving a split call bridge to each other. s10 is 33/33 (`results/s10-single-n6-20261013-223308`): capacity 3 with 6
  members puts 3 on each node, and everyone hears everyone. A bridge across real networks (different hosts, NAT) is
  untested.
- **Not covered by these runs:** the computer's sound through a node (`screen-sound` needs PipeWire and a real
  capture device), simulcast and preferred layers (phase 2), real networks (the test LAN is one host, round trips
  under 1 ms).
