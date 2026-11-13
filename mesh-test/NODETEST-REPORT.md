# Node test report: the real nodes on the LAN

Scenario `nodetest` (`./node-test.sh`, README "Node test"): the node on this computer (`~/Desktop/node/dist-node`,
pid under `tools/node-agent.mjs`) and the one at 192.168.2.213 (black box), both hosting MakeWork Dev
(`h1AA00m2…`), loaded by 8 apps and 20 bots on the host's network (topology `lan`).

## Run 1 (2026-10-17 16:52, `results/nodetest-lan-n8-20261017-165236`): stopped in the preflight

11/12 checks passed; the run stopped at the nodes check, before any load.

- The agent restarted the local node under the test, and it wrote its status again in 2 s. Its log shows no failure.
  It found a member after 0.5 s, and the build has every node-side fix from 2026-10-17 (`onPeerMember`,
  `heldRelayed`, `announce`, `callKey`).
- The first app joined with the invite and had the workspace's 245 commits in 0.7 s.
- **The local node never came online for the new app**, while the remote one did at once. "Online" means the
  node's signed hello was accepted (`NodeLink.receiveHello`). The app was connected to both nodes all along: 4
  connections, 2 of them host-host on this computer, none failed. The local node had the app's commits (247, the same
  as the app). So it had the new member and was connected to it, but no accepted hello arrived within 90 s. A node
  says hello on connecting, again once members' messages pass (today's fix), and every 60 s.
- Both nodes report the same public address (93.195.224.31). From this computer, 192.168.2.213:8080 answers "no route
  to host" (likely a firewall rejecting the port); the invite page isn't needed for this, but if UDP is blocked too,
  members can't send call media to that node.

## Run 2 (2026-10-17 17:02, `results/nodetest-lan-n8-20261017-170215`): every phase, 22/32

Invite "LiveMeshTest2" (no practical use limit). The local node was restarted under the test 3 s before the first
join, and stopped for 3 minutes in the failure phase.

What works:
- Messages: every message reached every member in all three rounds (2,268 deliveries each, 0 lost).
- Restart: back with all 448 commits 12 s after start, and online again for members after 12 s. Every member and the
  node ended with the same 532 commits.
- The remote node alone: while the local one was down, 5 bots joining again had the whole history in 6 s (p50).
- Nothing in any log: no unhandled failure, listener leak or stopped drain in the local node or the bots.
- The local node peaked at 102 % of one core (failure phase) and 66 % during the joins, with RSS up to 295 MB; this
  computer also ran 8 apps and 20 bots.

Findings, worst first:
1. **Calls through a node never worked.** `sfu_calls` is on (5+ members, capacity 20), so a call of 6 asks a node:
   - The remote node answers "serves", but no member's media ever reaches it: "leaving node AkgU51: its media never
     connected (UDP/TCP to the node blocked?)" 10 times, with the transports stuck at `connecting`. Its call port isn't
     reachable from this computer. That fits 192.168.2.213 rejecting TCP 8080 ("no route to host"): a firewall that
     lets out what the node starts (syncing works) but not what members start (call media).
   - Members ask different nodes first (they don't see the same nodes online, finding 3). The call split: some members
     got media through the local node ("media through node STRG3s connected"), the rest stayed on the mesh. The local
     node then served the call too, and waited for the remote one to link them ("both serve it: waiting for that node to
     link (smaller user number)"), which never happened. This computer's firewall allows 1025-65535 TCP and UDP, so
     the block is on the remote side, or the remote's link never started (its log will tell).
   - Result: no call of 6 or 8 had everyone hearing everyone, before or after the failure.
2. **A joiner can refuse its own join and stay outside for good** (app bug, `p2p/workspaces.ts` `ledger.ready()` →
   `settled` → `sendProfile`). The joiner sends its profile, with the invite, after 3 s without new commits (`settled`).
   c04's catch-up paused longer than that partway: it had 200 of the 245 commits, and the invite, made just before the
   run, was among the missing. Its own members plugin refused: "That invite has expired, been revoked or reached its use
   limit." The app said "You couldn't join the workspace" and never tried again. c04 stayed a joiner the whole run:
   - members' messages never reached it, so no node said hello and it saw no node online;
   - it fell back to the member room;
   - it was alone in every call.

   This caused the camera, call-of-8 and member-room failures. **Fixed (2026-10-17):** a join now also waits until its
   invite's row is in the history (`p2p/workspaces.ts` `hasInvite`/`waitFor`, up to 10 minutes; closing the workspace
   ends the wait). Covered by `tests/p2p/workspaces.test.ts` ("waits for its invite before sending the profile, when the
   history arrives with a pause"), which reproduced the run's error before the fix.
3. **A new member never saw the local node online** (same as run 1, now traced). The first app's direct connection to
   the local node opened in the invite's room and closed 180 ms later (`direct-`). It never formed again in the hub, and
   no hello from the local node ever arrived, not even through the remote node or with its 60 s timer. The remote node's
   hellos came at once and every 60 s. The local node logged 24 "could not connect … after exchanging SDP" and 11
   handshake timeouts with joiners in invite rooms; its other connections worked (the members it already had, and
   members after its own restart). The members ended in two groups: most saw 18 online, 10 bots and c04 only 11-13,
   never the 29 test members and nodes. Not explained yet. Caveat: every test member runs on the local node's own
   computer. A run with members on another machine of the LAN would show whether this is about a node and members on
   one host.
4. **Slow through the nodes:**
   - messages p50 9.1 s and p95 16.8 s (12.6 s / 24.9 s with only the remote node, 13.0 s / 21.6 s after the restart);
   - joins: the whole 245 commits after 32 s for apps (p50) and 62 s for bots (p95 82 s), with many failed connection
     attempts in invite rooms.

   The container nodes of s8 were several times faster with a bigger history.

### The remote node's log (run 2, from its machine)

- **Its media port is closed to members.** Every member that tried (9 users, again and again) got: "user U send got no
  media in 20 s: members must reach this node's media port (--rtc-port) over UDP or TCP". With TCP 8080 answering "no
  route to host", this is a firewall on 192.168.2.213 refusing connections that others start; syncing works because
  the node starts those itself. Fix on that machine: open UDP and TCP on its `--rtc-port` (default 40000) and UDP on
  its `--rtc-ports` range (the link between nodes).
- **The link between the two nodes uses the router's public address.** The remote node, with the smaller user number,
  opened the call and asked the local one again and again ("serves the call: no"; once, right after the local node's
  restart, "error not a node of this server"). When both served, it linked: "linked (this end 93.195.224.31:40095,
  theirs 93.195.224.31:40029)", and later ":40002 / :40082". Both ends are the same public address, since both nodes
  are behind the same router. The link's transports announce only the public address (`node/sfuBridge.ts` `listen()`:
  `announcedAddress: this.ctx.address()`). So it needs the router to send the packets back into the network (hairpin
  NAT) and to forward each port to the right machine, with both nodes on 40000-40100 behind one address. That can't
  work for both, and both links closed soon after. Members' call transports offer the node's LAN address as well
  (`main.ts` `lanAddress`, "and at 192.168.2.123 on this network"); the link between nodes didn't. **Fixed
  (2026-10-17):** a node sends its LAN address with its link details (`PipeTuple.lan`), and a node with the same public
  address links there (`node/sfuBridge.ts` `target`). Test: `tests/node/sfuBridge.test.ts` "links two nodes behind
  the same router over their LAN addresses". Both nodes need the new build for it, and each machine has to let the
  other in on its `--rtc-ports` range (UDP).
- **It also fails to connect to joiners in invite rooms:** about 10 "could not connect … after exchanging SDP" and 9
  handshake timeouts. So finding 3's failed connections happen on both nodes, not only on this computer's.
  What stays unexplained is why the local node's hello never reached the first app while the remote one's did.

Since run 2 the preflight records each node hello an app gets (`node-hello` in the trace: which node, clock skew,
online / waiting for the node's row / refused), waits 150 s (past the nodes' 60 s hello), writes the app's view of the
nodes to `preflight-nodes.json` when one stays offline, and goes on with the nodes that are online.

## Run 3 (2026-10-17 17:45, `results/nodetest-lan-n8-20261017-174544`): 25/32, both nodes on the new build

Better than run 2 (22/32):
- **The join fix works.** No member refused its own join, nobody fell back to the member room, and the camera check
  passes.
- **The call recovered when the local node stopped:** everyone heard everyone again on the mesh within 13 s.
- **The LAN link between the nodes is used:** "accepted link … (this end 93.195.224.31:40060, theirs
  192.168.2.213:40079)". The remote node sends its LAN address, so it runs the new build.

Still failing:
- **Calls through the remote node.** Apps logged "leaving node …35714523: its media never connected (UDP/TCP to the
  node blocked?)" 18 times. The local node's SFU transports all connected (16 of 16). Members bounce off the remote,
  its part of the call empties, it unlinks ("bridge … closed"), and it links again when the next member tries. So no
  call of 6 or 8 had everyone hearing everyone. **The firewall on 192.168.2.213 still blocks its `--rtc-port`.**
- **The local node is never online for a new member** (finding 3, now narrowed down).
  - The first app connected to it in the invite's room (15:46:42.817, authenticated) and lost it from that room 164 ms
    later, right after joining the hub. From 15:46:44 it had a working hub connection to it: 4 connections, all
    host-host, none ever failed.
  - That connection was never authenticated: no `auth` event for it again, so it never counted as a direct peer, its
    hello never got through, and members saw one "direct non-node peer" each.
  - Its hellos never came through the remote node either.
  - The local node logged about 20 failed connections and 6 handshake timeouts with joiners in invite rooms, and 3
    failures in the hub.
  - Next run: the trace records each challenge sent, each authentication message received (kind, whether it answered
    our challenge, peer known after it), and each room's peer joins and leaves (`auth-challenge`, `auth-in`,
    `room-peer+`/`room-peer-` in `preflight-nodes.json`).
- **Message latency is unchanged:** p50 8.5 s and p95 16.1 s; 16.7 s / 30.0 s with the remote node alone.

### The remote node's log (run 3)

- **The LAN link works from both ends:** "linked (link …, this end 93.195.224.31:40079, theirs 192.168.2.123:40060)".
  Microphones and a camera go across it both ways ("sent mic …", "took mic …", "took camera …").
- **Every link closes after its members leave.** Each member put on the remote node gets "send/recv got no media in 20
  s: members must reach this node's media port (--rtc-port)", leaves it, and once that node's part of the call is
  empty it closes the link ("bridge … closed"). The remote's media port is still closed to members; nothing else in
  its call path failed.
- **Failed connections are with bots.** The members both nodes fail to connect to are the same peers
  (`L48ZQOCO…`, `GvboUts7…`, `7p9abFL…` and more). 18 of those 20 peers are the test's bots, which use the same WebRTC
  library as the nodes (werift), on this computer's network. The other 2 only had handshake timeouts. The apps
  (Chromium) connect host-host to both nodes. So most of the failed attempts in both nodes' logs, and the slow bot joins
  (p50 72 s), come from the test's bots, not from what real members would meet. Node-to-node connections, also werift,
  work. Worth a look later: werift on a machine with several interfaces (docker0, a bridge, the LAN).
- **Still open:** the first app's hub connection to the local node was never authenticated (an app, not a bot). The
  next run's authentication trace covers it.

## Run 4 (2026-10-17 18:25, `results/nodetest-lan-n8-20261017-182513`): 29/32

- **Both nodes online for the new member within 4 s**, and no app had a stray non-node peer. Why the local node failed
  to show in runs 1-3 isn't known; the authentication trace is in place if it comes back.
- **Mesh calls work end to end:** 6 and then 8 members hear each other and get the camera, and the call carries on when
  the local node stops.
- **No call went through a node:**
  - The remote: 20 times "leaving node: its media never connected". Its firewall still blocks the media port.
  - The local: it answered "busy" 38 times, because its calls were off. 22 times it logged "Calls through this node
    are off: call media can't listen on port 40000 (UDP and TCP): uv_udp_bind() failed [ip:'192.168.2.123',
    port:40000]: address already in use".
  - The node only opens its call worker, and binds the port, at the first call (`main.ts` `sharedWorker`, `openSfu`).
    40000 and the whole 40000-40100 range sit inside Linux's range for automatic ports (`ip_local_port_range`
    32768-60999 here). So any program's socket can be handed 40000 before then. This computer had 8 apps and 20 bots
    opening hundreds of WebRTC sockets on 192.168.2.123; on a normal machine it could be the MakeWork app or a browser.
  - The restart in the failure phase bound it fine (the worker holds 192.168.2.123:40000 now), and a new call of 6
    then went partly through the local node.
  - Proposed fix: bind the media port when the node starts (open the call worker then), and/or default to a port
    below 32768.
- **Messages:** p50 10.2 s and p95 18.9 s at first, 3.6 s / 6.2 s after the local node's restart.
- **Online counts:** members still never reach the 29 expected. The check counts members and nodes the test brought;
  not looked into yet.
