# Node stress test report: 2 nodes under a swarm of 7–50 members

2026-10-10 · app `e5e0fb9` plus the working-tree changes below · scenario `s8` in `mesh-test/` · raw data in
`mesh-test/results/s8-*`

## Summary

> **Update 2026-10-10:** the fixes recommended here and the larger-network design (members connect to nodes, nodes
> split the files) are built and tested up to 100 members. See [After the changes](#after-the-changes-2026-10-10).
> Then the larger-network items (single forwarder, node pings, pieces and parity, node groups, a grid without nodes)
> were built and tested too: see [Larger-network items](#larger-network-items-2026-10-10-later). 30 joining at once
> and 6 nodes in two groups work; 50 joining at once, and 100 switching to the grid at once, still overload the one
> test host.

**Question:** do the built MakeWork nodes (`dist-node`, as deployed per `docs/nodes.md`) hold up when a swarm of members
joins at once? Do they still show the MaxListenersExceededWarning? And what limits a server's size?

**Answer:** the nodes are not the bottleneck.

- **No warnings or crashes:** in every run, 0 MaxListenersExceededWarning, 0 "stopped draining", 0 unhandled failures
  and 0 crashes, in both nodes and all bots.
- **Load:** each node stayed under 40% of one core and about 320 MB of memory while serving 29 joiners. A restarted
  node was back with every commit within 13 s.
- **Nodes only is faster:** with the owner offline and the nodes as the only source, every member had the full
  3,000-message history in about 15 s at 20 and at 30 members.

The limits come from elsewhere:

1. **Message latency grows with the size of the history.** A commit that arrives out of order makes every member replay
   the whole log. At 3,000 commits each replay costs about 105 ms. With 20 members chatting, messages took 2.7 s (p50)
   and 5.2 s (p95), against 0.17 s and 0.3 s for the same test with a 300-commit history.
2. **Joiners get the whole history from every member they connect to.** With the owner and the others online, each
   joiner received every commit 5 times at 20 members and 12.6 times at 30. Joining took 33–114 s, against 14–15 s
   when only the 2 nodes answered.
3. **The full mesh:** every member connects to every other member. This machine (16 threads) carried 30 members.
   At 40 and 50, the WebRTC handshakes failed after signaling (4,000–5,500 failed attempts) and most members never
   connected. That limit is this single host, but the connection count grows with the square of the members, which is
   what stands between this design and "hundreds online".

Two bugs were found and fixed during the test:

- **New members didn't use nodes first for up to a minute** (app bug, `p2p/nodes.ts`).
- **One slow member could hold the catch-up queue's only slot for minutes** (the queue added the day before,
  `p2p/syncQueue.ts`).

## Setup

| | |
|---|---|
| Nodes | 2 containers running the built node (`npm run build:node`, `npm install --omit=dev`, Node 22) from the same source as the clients (image `mwt-node`, `node.Containerfile`). Default `--senders 8`; `--geoip off`; data in a volume (kill + start keeps it). |
| Apps | 2–20 Electron clients, as in `REPORT.md` (one container each, harness over CDP). |
| Bots | 0–30 headless members (`bot/bot.ts`): the app's own ledger, ServerSync over werift, content streams and node ordering in plain Node, driven over HTTP. They never register as nodes. About 95 MB idle, about 280 MB with 30 connections. |
| Network | One internal LAN, local Nostr relays (strfry behind Caddy, as in `REPORT.md`), local coturn. Nodes and bots reach the relays through `--add-host` and the test CA. |
| Data | Server A and server B: 3,000 chat messages (3,029 commits with setup) and 6 files of 4 MiB as chat attachments. A side server (300 messages, 1 file) on node2 only, so its catch-up queue serves two servers. |
| Host | Ryzen 7 1700X (8 cores / 16 threads), 31 GB RAM, podman 5.8.7. Every member, node, relay and harness shares it. |

**Scenario `s8`:**

1. The owner (client01) creates the server, writes the history and uploads the files. Both nodes host it, the owner
   authorizes them, and the run waits until both hold everything.
2. **Phase A (owner online):** every other app and every bot joins at once. Measured: time to the full history, time
   to see everyone online, files (apps sync the channel; bots fetch, nodes first), a message round from everyone
   (3 per member, 500 ms apart), convergence after one re-hello round, and ledger work.
3. Everyone leaves A.
4. **Phase B (owner offline):** the same on server B, but the owner's container is killed before the swarm joins.
5. **Restart:** node1 is killed during B, members post meanwhile, node1 is started again, and the run times its
   catch-up.

Also sampled every 5 s: each node's `status.json` (catch-up queue: queued/active/limit; commits; files) and network
bytes (`/proc/net/dev`, since rootless podman reports 0), container CPU/memory, host load and free memory.

## Results

| Run | Members (apps + bots) | Verdict | History p50 / max, A (owner online) | History p50 / max, B (nodes only) | Copies of each commit, A / B | Message p50 / p95 (A) | Host load max |
|---|---|---|---|---|---|---|---|
| `s8-smoke-2` (300 msgs, 2×2 MiB) | 7 (2 + 5) | ✅ 17/17 | 1.4 / 2.5 s | 0.5 / 0.5 s | – | 0.04 / 0.09 s | – |
| `s8-single-n20-…235543` | 20 (20 + 0) | ✅ 17/17 | 34.9 / 37.8 s | 15.5 / 15.7 s | – | 3.1 / 5.5 s | 64 |
| `s8-n20-v2-…001153` | 20 (20 + 0) | ✅ 17/17 | 33.1 / 34.5 s | 14.1 / 14.4 s | 5.2 / 2.0 | 2.7 / 5.2 s | 51 |
| `s8-n20-h300-…001734` (300 msgs) | 20 (20 + 0) | ✅ 17/17 | 19.6 / 24.3 s | 3.5 / 3.5 s | 7.8 / 1.8 | **0.17 / 0.3 s** | – |
| `s8-n30-…002223` | 30 (10 + 20) | ✅ 17/17 | apps 113.5 / 121.5 s, bots 57.8 / 133.5 s | 15.0 / 15.6 s | 12.6 / 2.4 | 7.6 / 16.2 s | 71 |
| `s8-n40-…003021` | 40 (10 + 30) | ❌ stopped | 13 of 39 after 6 min | not reached | – | – | 100 |
| `s8-single-n50-…000137` | 50 (20 + 30) | ❌ stopped | about 0 of 49 after 4 min | not reached | – | – | 130 |

In every run up to 30 members:

- **Messages:** every message reached every member.
- **Convergence:** all members and both nodes ended with the same commits.
- **Files:** every member got every file.
- **Node restart:** back with every commit within 12.7 s. `status.json` is written every 10 s, so the true time is
  at most that. Members kept posting through the outage.

### Nodes

| Run | Phase | CPU max (one core = 100%) | Memory max | Sent | Catch-up queue: queued / active max | Limit range |
|---|---|---|---|---|---|---|
| n20-v2 | A | 35–36% | 262–270 MB | 244–246 MB | 2 / 15 | 4–22 |
| n20-v2 | B | 36–37% | 284–306 MB | 264–287 MB | 0 / 19 | 21–34 |
| n30 | A | 38–39% | 260–282 MB | 277–307 MB | 0 / 2 | 1–14 |
| n30 | B | 39–40% | 297–319 MB | 317–341 MB | 7 / 25 | 12–35 |
| any | restart (node1 catching up) | 118–121% | about 105 MB | – | 0 / 0 | 4 |

- **Network:** "Sent" is history plus files; each file went to roughly half the joiners from each node.
- **Catch-up limit:** it grew from 4 to 35 while batches went out quickly (all 19–25 joiners served at once in
  phase B). It dropped to 1–2 only when the host was saturated.
- **Files from nodes (bots, n30):** in phases A and B, 74 and 71 of 120 downloads came from nodes and the rest from
  members. A node serves 8 members at once and answers "busy" to the others (106 and 311 busy answers), who then ask
  a member. Nodes were at 40% CPU, so `--senders` could be raised.

### Where 40 and 50 members failed

Signaling works: offers and answers cross the relays. The WebRTC handshakes then don't finish on the starved host.

- **Bot logs:** "could not connect to peer … after exchanging SDP" appeared 4,223 times at 40 members and 5,550 at 50.
  Each failure is retried, which adds load.
- **Load:** 100 and 130 on 16 threads. Apps used about 33% CPU each and bots about 16% each, just connecting.
- **Electron probes:** they timed out, so the apps' own state wasn't readable.
- **Nodes:** they reached at most 16 (at 40) and 6–7 (at 50) peers, logged no warnings and never went above 40% CPU.

Both runs were stopped after phase A, because the rest would only have waited out its timeouts. Their timelines, node
samples and container logs are kept in their folders.

## Findings, ranked by severity

### F1. Message latency grows with the size of the history (high, fixed: see After the changes, A1)

When a commit arrives that sorts before ones already applied, `Ledger` replays the whole log. That happens often:
catch-ups from several senders interleave, and members post at the same time. Apps did 60–85 replays each per phase,
at either history size. Each replay costs time in proportion to the history:

| History | Time per replay | Replay time per client per phase | Message p50 / p95 (20 members) |
|---|---|---|---|
| 300 messages | 15–18 ms | about 1.2 s | 0.17 / 0.3 s |
| 3,000 messages | 102–107 ms | 8.4–8.6 s | 2.7 / 5.2 s (7.6 / 16.2 s at 30 members) |

Messages wait behind replays, so latency in a busy moment follows server size. Bite gameworks has about 15,000 commits:
expect roughly 0.5 s per replay.

**Recommendations:**
- Replay from a checkpoint (keep table snapshots every few hundred commits and replay from the one before the late
  commit) instead of from the start.
- Merge the late commits that arrive in one tick into a single replay.

### F2. Joiners get the whole history from every member they connect to (high, fixed: A2)

On connect, each side sends what the other lacks (`sync.ts`). A joiner with nothing gets the full history from every
member it reaches. Duplicates are dropped before signature checks, but they still cost bandwidth, parsing and replays
(F1).

| | Copies of each commit received | Time to full history |
|---|---|---|
| 20 members, owner and members answering | 5.2 | 33 s |
| 30 members, owner and members answering | 12.6 | 58–114 s |
| 20–30 members, only the 2 nodes answering | 2.0–2.4 | 14–15 s |

**Recommendation:** a joiner gets its catch-up from one source: the closest authorized node (`NodeLink.order`), else
one member. Other members answer a hello with a large gap only when no node is online, or after a delay if the first
source stalls.

### F3. New members didn't use nodes first (high, fixed)

A node says hello when a member connects, and again once a minute. A member that has just joined gets that hello before
the data holding the node's row, and `NodeLink` dropped it. For up to a minute, new members asked any peer for files
instead of nodes first. That's exactly the moment nodes matter most.

- **Evidence:** in `s8-smoke-2` phase B, with the owner offline, 0 of 10 bot downloads were credited to a node.
- **Fix:** `app/src/p2p/nodes.ts` keeps the last unverified hello per peer and checks it again when node rows change.
  Test: `app/tests/p2p/nodes.test.ts`, which fails without the fix.
- **After the fix:** in n30, nodes served 60% of downloads, and the rest came from members after "busy" answers.

### F4. A slow member could hold the catch-up queue for minutes (medium, fixed)

The catch-up queue (`p2p/syncQueue.ts`, added 2026-10-09 for the MaxListenersExceededWarning) gave each catch-up its
slot until its last batch. On the saturated host at 50 members, node2's limit halved down to 1. One slow member then
kept that slot for about 4 minutes while 2 others waited (`nodes.csv` of the n50 run).

- **Fix:** one batch per turn. A catch-up with more to send goes to the back of the queue, so a slow member holds a slot
  for one batch at a time. Hellos for a member already queued or sending are ignored.
- **Tests:** the rotation test in `app/tests/p2p/syncQueue.test.ts`; the sync tests still check one batch in flight per
  member and no double catch-up.
- **Stress runs:** in n30 and n40 the queue never held more than 7 entries, so the runs don't show the difference
  directly.

### F5. The full mesh sets the size limit (medium, addressed by the hub topology: A3, A5)

Every member connects to every other: 435 connections at 30 members, 780 at 40, 1,225 at 50, and 4,950 at 100. Here
the limit was the shared host, between 30 and 40 members. On real machines each member pays for its own n − 1
connections, and so does each node: a node with 100 members online holds 99 WebRTC connections in JavaScript (werift).
Connection setup was the expensive part here, not steady traffic.

**Recommendation:** for "hundreds online", members should connect to the nodes and a few peers rather than everyone.
`mesh.ts` already relays one hop; letting nodes act as hubs extends that.

### F6. Nodes answer "busy" past 8 receivers (low, senders now adapt up to 32)

With 29 joiners, 40% of bot downloads fell back to members after 106–311 "busy" answers. The default `--senders 8` is
conservative for a node at 40% CPU. Consider a higher default, or an adaptive limit like the catch-up queue's.

### F7. MaxListenersExceededWarning (resolved as far as tested)

The warning appeared 0 times in all 7 runs, in nodes and bots, together with 0 "stopped draining" failures. Commit
batches now go to each member one after another, and the node raises the listener limit to 100.

This build was not run against the old one, so the runs show only that the warning stays away at these sizes. They
don't reproduce the original warning.

## After the changes (2026-10-10)

The recommendations above, plus the larger-network work decided with the user, are built:

- **Replays:** from checkpoints, coalesced.
- **Catch-up:** one source per catch-up, the closest node first.
- **Hub topology:** members connect only to nodes, to each other only while no node is reachable, and directly in a
  call.
- **Split storage:** nodes split the files (RAID 1, `copies` per server), point to each other's files, fetch on
  demand and heal.
- **Senders:** adaptive.

The design is in `../docs/architecture.md`. A new scenario, **s9**, checks it: 3 nodes, `copies` 2, 1,000 messages and
8 files of 2 MiB. Its steps:

1. Everyone joins.
2. One node is killed while the owner adds files.
3. All nodes are stopped, then started again.
4. Two apps join a call.

### Results

| Run | Members (apps + bots) | Verdict | Time to full history | Connections per member | Message p50 / p95 | Notes |
|---|---|---|---|---|---|---|
| `s9-smoke3` | 9 (3 + 6) | ✅ 16/16 | 4.5 s | 3 (the nodes) | 0.03 / 0.06 s | healed 119 s after a node was killed (heal-after 1 min) |
| `s9-v2-n30` (burst) | 30 (10 + 20) | ✅ 16/16 | p50 123 s apps, 192 s bots | 3 | 0.22 / 0.33 s | fallback: in the member room after 43 s, back in the hub 29 s after the nodes returned |
| `s9-v4-n50` (burst) | 50 (10 + 40) | ❌ stopped | 3–5 of 49 after 240 s | – | – | host load 100–112, see A5 |
| `s9-v5-n50` (waves of 10 every 20 s) | 50 (10 + 40) | ✅ 14/14 | p50 17 s apps, 10.5 s bots, from each one's join | 3 | 0.69 / 1.1 s | 309 of 320 bot downloads from nodes; healed in 94 s |
| `s9-v5-n100` (waves) | 100 (10 + 90) | ✅ 14/14 | p50 16 s apps, 7.4 s bots, max 20 s | 3 | 6.2 / 8.3 s | 300 connections in all, where a full mesh needs 4,950; healed in 90 s |

The fallback (all nodes stopped) runs only up to 40 members: a full mesh of more would overload this host. It
passed at 9 and 30 members.

s8 again with 2 nodes, against the first runs above:

| Run | Message p50 / p95 (A) | Copies of each commit A / B | Full history A | Full history B (nodes only) |
|---|---|---|---|---|
| 20 apps, before | 2.7 / 5.2 s | 5.2 / 2.0 | 33 s | 14 s |
| 20 apps, after | **0.15 / 0.27 s** | 4.6 / 1.9 | 37 s | 23 s |
| 30 (10 + 20), before | 7.6 / 16.2 s | 12.6 / 2.4 | 114 s apps, 58 s bots | 15 s |
| 30 (10 + 20), after | **0.25 / 0.44 s** | **2.9 / 1.9** | 68 s apps, 60 s bots | 49 s |

Nodes at 100 members (staggered):

| | |
|---|---|
| Memory | 320–410 MB each |
| Data sent | 700–760 MB each (history, files, relayed messages and presence) |
| Catch-up queue | never more than 3 at once, limit 4–21 |
| Warnings and crashes | 0 MaxListenersExceededWarning, 0 "stopped draining", 0 crashes in every run |

Rootless podman's CPU numbers turned out to be averages since each container started. They understate peaks, so the
CPU figures in this report are rough; the host load is the reliable figure.

### What the results show

- **A1. Message latency doesn't grow with history any more (F1 fixed).**
  - With 3,000 commits and 20 members, p50 fell from 2.7 s to 0.15 s; at 30 members, from 7.6 s to 0.25 s.
  - Replays per client dropped from about 80 to 15–45, at 9–47 ms each instead of 105 ms.
- **A2. Each commit arrives about once per node (F2 fixed).**
  - Catch-ups come from one source, so a joiner gets the history about once.
  - Live commits still arrive once per node, since every node passes each one on; see A6.
  - In s8 phase A, where the owner and members also answer, it went from 12.6 to 2.9 copies at 30 members.
- **A3. Members connect only to nodes (F5 addressed).**
  - At 9, 30, 50 and 100 members, every member had exactly 3 direct connections, one per node.
  - Calls connect their two members directly, and both members still see everyone through the nodes.
- **A4. Split storage works.**
  - The nodes keep 2 copies of each file between them and serve members from the nodes that keep it: 96–99% of bot
    downloads came from nodes.
  - With a node killed, every member still got every file, including ones added during the outage, within 30–42 s.
  - Each file had its 2 copies again 89–119 s after the kill, with heal-after at 1 minute.
- **A5. A burst of joiners is the weak spot (open).**
  - 30 members joining at the same second all got in, but it took 2–3 minutes.
  - 50 at the same second didn't get in on this host. Every member's WebRTC setup (werift in the bots, Chromium in the
    apps) competes for 16 threads; handshakes time out, are retried, and load rises to 100+.
  - Joining in waves of 10 every 20 s worked up to 100 members in seconds each.
  - In real use every member has its own machine, but a node still sets up one connection per joiner.
  - Next steps:
    - Pace new connections on the nodes (accept a few at a time, others wait).
    - Repeat the burst test on several machines.
- **A6. At 100 members, message latency rises to about 6 s (open).**
  - Every node passes every commit to every member: 100 members posting 2 messages each makes about 60,000 relayed
    sends, and every member gets each commit three times.
  - Recommendation: one node passes each author's commits on (picked like file holders, by rendezvous hashing); the
    others only answer hellos.
- **A7. Falling back without nodes works, but slowly.**
  - Members join the member room about 40 s after the nodes die, because WebRTC needs about 30 s to notice a killed
    peer.
  - They return to the hub 19–29 s after the nodes come back.
  - Node pings could notice a dead node sooner.
- **A8. Joining a server whose only source is the nodes is slower than with a full mesh at 30 members.**
  - s8 phase B went from 15 s to 49 s, because the nodes connect a burst of passive joiners one by one (see A5).
  - In s9 with staggered joins, joining took 7–17 s.

### Found and fixed while testing the changes

| Problem | Fix |
|---|---|
| Two members who met in the member room or a call were also connected in the hub, passive or not. Trystero shares one connection per peer between rooms of the same app id and announces room membership over it. | The member room and call rooms use their own app ids. |
| Joiners waited up to a minute for a node: a passive member stays silent until it hears an active peer, and Trystero's Nostr strategy announces a settled room once a minute. | The node build announces every 4 s (`vite.node.config.ts`). |
| Joiners falling back to the member room after a few seconds met there in bursts and overloaded everything. | Joiners are passive in the member room; they turn active only after 45 s with nobody at all. |
| A lost connection reached the other members up to 1 s late, and meanwhile they didn't pass messages on to it (a message could wait for the 20 s re-hello). | Lost connections go out at once. |
| Trystero's 10 s room handshake timed out on a busy machine, and the retries made it busier. | 30 s. |
| A member asking a node that had just died waited the full 30 s. | Content requests wait 10 s for an answer; a node fetching on demand answers within 8 s. |

Tests for these:
- `tests/p2p/roomGroup.test.ts`, `placement.test.ts`.
- `sync.test.ts`: the hub topology, member room fallback, joiners, calls, one source per catch-up.
- `ledger.test.ts`: replays from checkpoints are the same as full replays, in any arrival order.
- `stream.test.ts`: on-demand fetch, adaptive senders.
- 289 tests pass.

## Larger-network items (2026-10-10, later)

The open items from "After the changes" ("Larger networks") are built. The design is in
`../docs/architecture.md`.

| Item | What changed |
|---|---|
| One forwarder per author (A6) | A member in the hub sends its new commits to its closest node only (`fwd`), and that node passes them on. |
| Dead nodes noticed sooner (A7) | Members ping the nodes every 5 s; a node silent for 15 s stops counting as reached. |
| Presence fan-out | Cursors and other state go only to members in the same channel. The channel itself goes to everyone when it changes and every 30 s. |
| Pacing on nodes (A5) | The node build sets up at most 8 connections per room at once (a Trystero patch, like the 4 s announce). |
| RAID 10 | Files over `stripe_mb` are kept in 4 MiB pieces, each on `copies` nodes. A node puts the file together for a member. |
| RAID 4/5 | With `parity` P, each piece is kept once, plus one XOR piece per P pieces. A lost piece is rebuilt. |
| Node groups | With more than 3 nodes, groups of up to 3. A member connects to its group only; groups reach each other through two nodes. |
| Grid without nodes | With more than 12 members online, rows and columns of rooms: about 2·sqrt(2n) connections each instead of n−1. |

s9 got options for these:
- `--stripe-mb` and `--parity` set the storage.
- `--nodes 6` makes two groups; the connection check then expects the member's group only.
- The fallback now runs up to 100 members and reports the bots' direct connections in the grid.

Files are 8 × 9 MiB (3 pieces each, split above 4 MiB). Unless noted, everything else is as in "After the changes".

### Results

| Run | Members (apps + bots) | Nodes, storage | Verdict | Full history | Message p50 / p95 | Notes |
|---|---|---|---|---|---|---|
| `s9-v7-n30-burst` | 30 (10 + 20) at once | 3, pieces × 2 | ✅ 16/16 | all in 49 s (p50 apps 41 s, bots 33 s) | 0.18 / 0.31 s | before (`v2-n30`): apps 123 s, bots 192 s |
| `s9-v7-n50-burst` | 50 (10 + 40) at once | 3, pieces × 2 | ❌ 13/16 | 31 of 49 in 240 s, all by the message round | 0.46 / 0.74 s | see B2; earlier `v6` attempt: 2 of 49 |
| `s9-v7-n50-g6-parity` | 50 (10 + 40), waves | 6 in 2 groups, parity per 2 | ✅ 16/16 | p50 apps 141 s, bots 26 s | 1.1 / 2.9 s | apps slow: moved to their group mid catch-up (fixed, see below) |
| `s9-v9-n50-g6-parity` | 50 (10 + 40), waves | 6 in 2 groups, parity per 2 | ❌ 14/16 | all in 74 s (p50 apps 45 s, bots 13 s) | 0.77 / 1.6 s | make before break; the grid stayed off without nodes and slow pongs failed the hub check (both fixed, see below) |
| `s9-v10-n50-g6-parity` | 50 (10 + 40), waves | 6 in 2 groups, parity per 2 | ❌ 15/16 | all in 86 s (p50 apps 38 s, bots 18 s) | 1.1 / 1.8 s | every member on its group's 3 nodes; grid without nodes; 5 bots back on all 3 nodes just after the 180 s limit (B7) |
| `s9-v7-n100` | 100 (10 + 90), waves | 3, pieces × 2 | ❌ 12/16 | p50 apps 15 s, bots 5.9 s | 5.4 / 8.6 s | join, files, healing pass; the grid fallback with 100 at once overloaded the host (B6) |

### What the results show

- **B1. Each commit arrives about twice instead of 3–5 times; latency at 100 is this host's.**
  - Copies of each commit per app: 5.04 → 2.11 at 30 members, 3.22 → 1.98 at 100.
  - At 100 members messages still took 5.4 s (p50), against 6.2 s before. The host was at load 35–45 on 16 threads
    before the round started, and every member verifies and applies each of the 200 new commits.
- **B2. Bursts: 30 at once now join in 49 s; 50 at once still overload this host.**
  - At 30: everyone had the history within 49 s, against 2–3 minutes before.
  - At 50, load rose from 5 to 47 within 20 s of the join, before any member fell back. Bots with no connection used
    25% CPU each: once a passive Trystero peer hears an active one, it announces too, so each joiner receives every
    other joiner's announces on all 5 relays. Handshakes then time out every 30 s.
  - The nodes stayed at about 15% CPU. Their pacing can't help when the joiners themselves are starved.
  - In real use each joiner has its own machine; this needs a test across several machines.
- **B3. Pieces and parity work, but downloads of striped files are slower.**
  - The nodes keep pieces only: 48 pieces needed for 8 files with 2 copies, 50–52 held (pieces fetched before all
    nodes were authorized; the hourly prune removes them). With parity: 24 data and 16 parity pieces.
  - With a node killed, every member still got every file, rebuilt pieces included, within 30–66 s. Each file had
    its pieces or copies back 84–144 s after the kill (heal-after 1 minute).
  - Bots took 344–391 s for 8 × 9 MiB (p50 15–25 s per file), 152–157 s once joiners used all 6 nodes (`v9`,
    `v10`): the node asked first gathers the pieces from the other nodes before sending. Members fetching pieces
    straight from their holders is the next step.
- **B4. Node groups work.**
  - With 6 nodes, every member had exactly 3 connections, all to its own group's nodes (`v10`).
  - Messages crossed groups through two nodes: all 4,900 deliveries, p50 0.8–1.1 s.
  - Joining took 74–86 s for all 49 once members kept the hub until caught up and connected in their group (149 s
    and 141 s for the apps' p50 before), and files 152–157 s (391 s before).
  - Each node used 270–440 MB.
- **B5. Without nodes, the grid works at 30 and 50.**
  - 30 members: p50 12 / max 16 direct connections of 29 others; messages p50 0.4 s.
  - 50 members: p50 6–7 / max 16–18 of 49 with 3 nodes, p50 2 / max 6 with node groups (`v10`, 15 s after the
    fallback, still forming); messages p50 2.4–4.9 s, p95 13–28 s while the grid formed (two hops).
  - Members fell back 34–39 s after the nodes died with 3 nodes (43 s before), 50 s with groups (the second group is
    tried first).
- **B6. 100 members switching to the grid at once overloaded this host.**
  - About 1,300 connections were being set up at the same second. Load went from 12 to 170, and after 4 minutes the
    bots had p50 0 connections; 15,658 of 19,800 deliveries were missing.
  - The return to the nodes and the call failed in the same overload.
  - Spreading the fallback over a few seconds per member is still open (docs/architecture.md, "Limits").
- **B7. Returning to the nodes after all of them restarted took longer: 61–122 s (19–29 s before), up to 180 s for
  the last bots with 6 nodes.**
  - The restarted nodes got no connection for their first ~45 s while the host was at load ~80 (the grid of 50 still
    running), then everyone at once.
  - In `v10`, 35 of 40 bots were on all 3 of their nodes within 180 s; the other 5 had left the member room by
    129–150 s, with 2 nodes, and had the third at about 180 s. Messages reached everyone throughout.
- **B8. Warnings:** 0 MaxListenersExceededWarning in the nodes in every run. The bots had 6 each in the failed burst
  of 50 and in `v9`'s full-mesh fallback, both under overload, and none in `v10`.

### Found and fixed while testing these

| Problem | Fix |
|---|---|
| Joiners turned active in the member room after 20 s instead of 45 s: the timer was `min(45 s, 2 × fallback)`, meant for tests. A burst of 50 then made a full mesh among itself (`v6`: 2 of 49 joined). | `lonelyMs` is an option (45 s; short in tests). |
| With node groups, a member moved from the hub to its group after its first batch of history, which dropped the connection mid catch-up (apps took 141 s instead of about 15 s). Waiting in the hub until caught up was worse (`v8`: 24 of 49 in time), because only the first group's nodes are in the hub. | Make before break: the group's room as soon as the groups are known, and the hub until caught up with the source and connected to a node of the group (`v9`: all 49 in 74 s, apps p50 45 s, bots 13 s). |
| The grid is sized by the server's member count, so that everyone agrees on the rooms. With few of them online, members share a row or column with nobody and are cut off. The tests had every member online, so they passed. Found while reading the code after the runs. | A member uses the grid only while the members it saw online in the last minute fill it (1.5 per cell to go in, 1 to stay); otherwise the member room as before. Test: 5 online out of 15 stay fully connected. |
| That count was only taken once a member was already falling back, when the nodes that showed it everyone were gone, so it counted itself only: the grid stayed off and 50 members made a full mesh (`v9`: p50 0 connections, messages 130 s). | Counted on every room check. Test: with a node gone, 9 members go straight to the grid, never more connections than their row and column. |
| A node's answer to a ping only counted if it answered the latest ping. Pings go out every 5 s, so a busy node answering in more than 5 s was marked silent after 15 s and never came back while it stayed slow (`v9`: bots flickered between 2 and 3 nodes and failed the hub check). | Any answer to one of the member's pings counts. Test: a node answering slower than the pings stays counted. |
| Parity pieces were placed one by one, so all pieces of a group sometimes landed on one node (about 1 in 9 with 3 nodes); losing it lost more than one parity piece can rebuild. Found through a flaky unit test. | A group's pieces go to different nodes when there are enough. Tests: distinct nodes with and without a gone node; the three-node rebuild passes 5 of 5 (it failed about 1 run in 3). |

Tests: 308 pass (new: grid, sparse grid, grid after the node goes, node groups, forwarder, presence to viewers, node
pings and slow pongs, pieces and their placement, and three nodes on the fake network keeping copies and rebuilding
from parity).

## Test harness changes

- **Sign-in:** the harness now makes accounts offline. `register` needs the user server (email code) since the email
  accounts work, and the test LANs have none. It now imports a locally made account file instead. This also unblocks
  the older scenarios s0–s7.
- **New pieces:** `up.sh --nodes/--bots/--bots-per/--senders`; image `mwt-node` (node plus bots); `bot/`;
  `harness/lib/{bots,nodes}.mjs`; `podman.exec`/`logs`; scenario `s8`; node network from `/proc/net/dev`.

## Limits of this test

- **One host:** all members share 16 threads, so above 30 members the results measure this machine. Bots are lighter
  than the app, but still about 16% CPU and 280 MB each with 30 connections.
- **Network:** latency between containers is near zero; real distances add round trips to every batch and chunk.
- **Coarse sampling:** `status.json` is written every 10 s, so queue samples are coarse.
- **File sources for apps:** not recorded; only bots record whether a file came from a node or a member.
- **No old build:** no run of the build from before the sync changes, for comparison.

## Reproduce

```sh
cd mesh-test
./up.sh 20 single --nodes 2 --bots 0          # or: ./up.sh 10 single --nodes 2 --bots 20
./run-scenario.sh s8 --timeout-min 60         # --history 300, --files 0, --no-restart, ...
./down.sh

# Larger-network items (s9): 6 nodes in two groups with parity, bots in waves; or 3 nodes and a burst (no --wave)
./up.sh 10 single --nodes 6 --bots 40 --heal-after 1
./run-scenario.sh s9 --timeout-min 60 --file-mb 9 --stripe-mb 4 --parity 2 --wave 10 --wave-gap-s 20
./down.sh
```
