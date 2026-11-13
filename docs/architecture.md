# Architecture: serverless workspaces and nodes

How a MakeWork workspace works: there is no central server. Members (the desktop and web app) and optional **nodes**
(always-on headless members) hold the workspace's data and talk to each other directly over WebRTC.

Code: `app/src/p2p/` (shared by the app and the node), `app/src/node/` (the node), `app/src/system/` (the plugins
that define the workspace's tables and actions). How it behaves under load: `mesh-test/REPORT.md` and
`mesh-test/NODES-REPORT.md`.

## Overview

```
                 Nostr relays (signaling only: who is in a room, WebRTC offers)
                         │
      ┌──────────────────┼──────────────────┐
      ▼                  ▼                  ▼
   node A ◄─────────► node B ◄─────────► node C        nodes: active in the hub room, connected to each other
   ▲  ▲  ▲            ▲  ▲  ▲            ▲  ▲  ▲
   │  │  └── members connect only to the nodes (passive in the hub room) ──┘
   m1 m2 m3 ...                                     a call adds a direct room between its participants
```

With more than 3 nodes, the nodes form groups of up to 3 and a member connects only to its group. Without nodes,
up to 12 members connect to each other; more than that form a grid of rooms (see "Who connects to whom").

- A **workspace** is a signed log of changes. Its id is the hash of its first commit; anyone with the invite
  (`mw2.<id>.<secret>`) can join its rooms and sync.
- **Members** keep the whole log and the files they want. **Nodes** keep the whole log and their share of all files,
  serve them, and carry members' messages to each other.
- Everything is checked by everyone: each commit is signed by its author and accepted only if the author was allowed
  to make it at its place in the log (`p2p/policy.ts`), so every copy ends with the same tables.

## The signed log (`p2p/log.ts`, `p2p/ledger.ts`)

- A **commit** is one request's writes: `{ server, author key, replica, seq, lamport clock, time, action, row ops }`,
  signed with the account key (ECDSA P-256). Commits are ordered totally by (clock, author, replica, seq).
- `Ledger` holds every commit and the **tables** = the result of applying the accepted commits in order. Local writes
  are checked and applied at once, then signed, stored and sent.
- **Late commits.** A commit that sorts before applied ones makes the log replay from that place. Replays start from
  the closest **checkpoint** at or before it. The tables are kept every 256 commits and thinned with age: the last few
  at 256, 1,024 and 4,096 apart, then every 16,384th. Rows are replaced on change, never edited in place, so a
  checkpoint is a copy of each table's map. Late commits arriving within 20 ms replay once, and only rows the
  replayed commits touch are compared for change events.
- **Storage.** The app keeps commits in IndexedDB (or `.makework/commits/*.jsonl` in a workspace folder); the node keeps
  them in `servers/<id>/commits.jsonl`.
- **Policy.** `p2p/policy.ts` has a rule per plugin table: roles and permissions (`p2p/permissions.ts`), channel
  visibility and edit rules (`p2p/visibility.ts`). A table without a rule is owner-only.

## Sync (`p2p/sync.ts`, `p2p/syncQueue.ts`)

- On connect each side sends a **hello**: its version vector (highest seq per replica with nothing missing below it).
  The other side sends what is missing in batches of 200 commits. A re-hello every 20 s repairs anything missed.
- **One source per catch-up.** A member asks one peer for what it lacks: the closest authorized node
  (`NodeLink.order`), else the first peer. It asks each other peer only for what that source lacks (`since` =
  its vector merged with the source's), so a joiner gets each commit about once instead of once per peer. A source
  that sends nothing for 10 s while it has more is replaced. A peer whose hello shows strictly more than the source
  becomes the source; this matters when the first peer is another joiner.
- **Catch-up queue** (one per process, shared by all workspaces). Answers to hellos wait in a FIFO with one entry per
  member, and each turn sends one batch, so a slow member never holds a slot for long. The number running at once
  adapts like TCP's congestion window (start 4, max 64; faster batches raise it, slow or failed ones halve it).
- **Paced sending.** Commits go to each member one batch after another (Trystero waits for each data channel to
  drain).
- **Live commits.** A new commit goes to every direct peer. A member passes commits on to its direct peers that the
  sender doesn't reach itself, so relayed members still get everything.
- **One forwarder per author.** A member in the hub sends its new commits to one node only (the closest), marked
  `fwd`, and that node passes them on to all its peers. Sent to every node, each member got each commit once per
  node. If the forwarder drops them, the others get them with the next hello.

## Who connects to whom (`p2p/sync.ts`, `p2p/roomGroup.ts`, `p2p/mesh.ts`)

WebRTC connections are made through Trystero rooms, signaled over Nostr relays (`p2p/relays.ts`). A server uses
several rooms, held together by a `RoomGroup` that the rest of the code sees as one room. A peer has the same id in
every room, and sends go through the first room the peer is in.

| Room | Who | Active / passive |
|---|---|---|
| hub (the workspace id) | everyone (with node groups: joiners and the first group's nodes) | nodes active, members passive |
| node group (`<id>:group:<g>`) | with more than 3 nodes: a group's nodes and the members with data near it | nodes active, members passive |
| node room (`<id>:nodes`) | with more than 3 nodes: all nodes | active |
| member room (`<id>:members`) | members while no node is reachable; joiners without data | active (joiners passive) |
| grid rooms (`<id>:members:r<n>`, `:c<n>`) | without nodes and more than 12 members: one row and one column each | active |
| call room (`<id>:call:<channel>`) | members in that voice channel | active |

- Trystero never connects two passive peers, so in the hub **members connect only to the nodes**. A member's
  connections are the number of nodes, not the number of members.
- **Nodes announce every 4 s.** A passive member stays silent until it hears an active peer, and Trystero's Nostr
  strategy announces a settled room only once a minute. The node build lowers that interval (`vite.node.config.ts`,
  the build fails if Trystero changes the line), so a joiner finds the nodes within seconds.
- **Nodes pace new connections.** The node build also patches Trystero's signal handler (`nodePacing` in
  `vite.node.config.ts`): at most 8 connections are being set up per room at once. Further announces and offers are
  left unanswered, and those peers try again with their next announce. A burst of joiners otherwise made a node start
  every handshake at the same moment; on a busy machine they timed out and were all retried.
- **Node groups** (`p2p/nodeGroups.ts`). With more than 3 nodes, each member connecting to every node would cost every
  node a connection per member. The nodes are split into groups of at most 3, neighbours by longitude (by user id
  without a place), and everyone computes the same groups from the node rows. A member with data joins the room of
  the group nearest it (by its place when it shares one, else by a hash of its id), and also the next group's room
  while none of its group's nodes answers. Joiners without data use the hub, where the first group's nodes stay
  active. All nodes meet in the node room, and members of different groups reach each other through two nodes.
  A joiner joins its group's room as soon as it knows the groups, and leaves the hub only once it has everything its
  catch-up source had and one of its group's nodes is connected. Leaving after the first batch dropped the
  connection mid catch-up, which then started over (2.5 minutes in mesh-test s9); staying in the hub until caught up
  left every joiner with only the first group's nodes.
- **No node reachable:** members are active in the member room and connect to each other as before.
  - A workspace without nodes: at once.
  - A member of a workspace with nodes: when none has answered for 10 s. Members ping the nodes every 5 s
    (`NodeLink`), and a node silent for 15 s stops counting as reached (WebRTC alone takes about 30 s to notice a
    killed peer). A silent node is still pinged and counts again when it answers. With node groups: after 20 s, so
    the next group's room is tried first.
  - A joiner without data can't tell yet whether the workspace has nodes. It is passive in the member room: it reaches
    members who are active there (a server without nodes) but not other joiners. It turns active only after 45 s
    with nobody at all. When joiners turned active after a few seconds, a burst of 50 met in the member room and
    overloaded everything (mesh-test s9).
  - They leave the member room 15 s after a node connects.
- **Member grid** (without nodes, more than 12 members). A full mesh costs n(n-1)/2 connections (4,950 at 100
  members). Instead each member gets a cell in a grid of about sqrt(n/2) rows and columns (`gridCell`: a hash of its
  user id) and is active only in its row's and its column's room. It connects to about 2·sqrt(2n) members (28 instead
  of 99 at 100) and reaches any other through at most two of them: a row-mate, then that member's column-mate. The
  members of row 0 are also active in the plain member room, where joiners without data find them.
  - The size comes from the workspace's member count, so everyone works out the same rooms. But a grid only works when
    its cells are full: with 10 of 100 members online, many would share a row or column with nobody. So a member uses
    the grid only while the members it has seen online in the last minute (directly, through nodes before they went
    away, or through the grid) fill it: 1.5 per cell to go in, 1 to stay. Otherwise it stays in the member room, a
    full mesh as before. In practice the grid is used when most of a workspace's members are online.
  - A member moves to the grid only once caught up, like a joiner moving to its node group.
- **Separate app ids.** The member room and grid rooms (`makework-members`), call rooms (`makework-call`), the node
  room (`makework-nodes`) and node group rooms (`makework-group`) use their own app ids.
  Trystero shares one connection per peer between rooms of the same app id and tells the other side which rooms it is
  in, with no signaling. Without separate ids, two members who met in the member room or a call would also be
  connected in the hub, passive or not.
- **Calls:** joining a voice channel adds its call room, so call media stays direct between the participants.
- **Older apps** are active in the hub room, so they still connect to everyone.

`Mesh` (one per workspace):
- Tracks direct peers and relays messages one hop through a peer both sides reach. In the hub that is a node, and
  members relay through it at once.
- **Routes** (`shareRoutes`), for nodes in groups and members in the grid: such a peer also tells its direct peers
  its route table (`routes`, kept apart from the direct lists, which decide who passes commits on), each relayed peer
  with the go-betweens on the way. The receiver puts the sender in front, drops a route that names itself or a peer
  twice or has more than 3 go-betweens, and keeps the shortest route per peer (the current one among equally short).
  Lists are numbered. A new peer gets the whole list; after that each change goes as what changed since the list
  before (`base`, `add`, `remove`): losses within the same tick, so a burst of leaves is one change, additions batched
  each second. A whole list on every change would have cost a node relaying hundreds of members megabytes per member
  who left. Every 10–15 s each peer that has a list from here, an empty one too, hears "nothing changed" (`{ n }`).
  A receiver whose list doesn't match a change or `{ n }` (a send that failed) asks for the whole list and keeps the
  old routes until it comes. Dropping them at once made everyone reached through that peer leave and come back. A
  peer whose members' messages start again, or whose connection moved (`peerMoved`), gets the whole list again.
  A relayed message carries the rest of its route (`path`) and every go-between passes it to the next one named. The
  far lists before this (`mesh-far`, ignored now) named everyone a peer reached through others, whoever had told it,
  so connected nodes kept members who had left through each other. Older apps still get the direct lists but no
  routes, so they don't reach members of other node groups or two go-betweens away in the grid until they update.
- Peer lists: each new peer gets the full list of whom this one reaches. Lost connections go to everyone at once,
  since a stale "reaches" claim stops others from passing messages on. New ones go in batches each second
  (`mesh-delta`), plus a full list every 30 s.
- Nobody forwards media, node or member (ADR 0019): a stream goes only over the direct link to its receiver, one copy
  each. Members of a call link directly through the call's room; without a link a pair waits for one.
- TURN (`p2p/ice.ts`, `turn-worker/`) is offered with every connection and used only when nothing else works; a
  failed direct attempt fetches it for the next one, since a call's media has no other way.

## Nodes (`app/src/node/`, `p2p/nodes.ts`, `p2p/placement.ts`)

A node is the built `dist-node` (`npm run build:node`, see `nodes.md`): plain Node.js with WebRTC from `werift`,
its own key, and the hosted workspaces listed in `node.json`.

- **Joining a workspace.** A node registers itself in the `nodes` plugin (`nodes_nodes`, pending) and waits until someone
  with "Manage nodes" authorizes it. It says which peer it is with a hello signed by its key; members verify it against
  its row. A hello that arrives before the member has the row is kept and checked again when the rows arrive.
- **Members prefer nodes:**
  - Catch-up from the closest node.
  - Files from the nodes that keep them.
  - Connections only to nodes (hub).
  - Members ping authorized nodes every 5 s to know the closest and to notice one that stopped answering (15 s).
    Any answer to an earlier ping counts too: a busy node answering in more than 5 s is slow, not gone.

### Files across nodes (RAID 1 copies, RAID 10 pieces, RAID 4/5 parity)

- **Placement.** Each file is kept by `copies` nodes (`nodes_settings`, default 1, Server settings > Nodes), chosen by
  **rendezvous hashing**: every node gets a score per file from the file hash and its user id, and the `copies`
  highest-scoring nodes that aren't gone keep it (`p2p/placement.ts`). Everyone computes the same holders from the
  workspace's data alone. Only a gone node's files move, each to the next node in its ranking, and they move back when it
  returns.
- **Pointers.** Nodes tell each other which files they have (`node-have`: the full list when they meet, then additions
  and removals), so a node knows where every file is.
- **On demand.** A node asked for a file it doesn't keep fetches it from a node that does, into its cache, and serves
  it (`ContentStreams` `onMissing`, waiting up to 8 s; members wait 10 s for an answer, so a peer that went away is
  skipped soon). Members ask a file's holders first (closest first), then the other nodes, then
  members (`NodeLink.orderFor`).
- **Self-healing.** A node not reached for `--heal-after` minutes (default 15) counts as gone. Each remaining node
  recomputes placement, and the files it now keeps are fetched from a surviving copy (pointers first) or a member.
  When the node returns, the extra copies become cache.
- **Cache.** Files a node has but doesn't keep are its cache. The oldest are deleted past `--cache-gb` (default 2), and
  the other nodes are told.
- **Pieces (RAID 10).** Files of 20 GB and more (`stripe_mb`: 0 = never, else 20,480 MB at least, the default; files
  of hundreds of GB are what it is for) are kept in 4 MiB pieces (`p2p/pieces.ts`). Each piece is placed like a file
  (`<hash>:<n>` ranked by rendezvous hashing, `copies` holders), so a big file's pieces spread over all nodes. No node
  ever holds such a file whole:
  - **Taking pieces in.** A node gets a piece from another node (`piece-get`), else as a byte range from a member who
    has the file (`ContentStreams.fetchRange`: a `content-want` with an `end`; holders that predate ranges are stopped
    after it), else by rebuilding it from parity. It keeps pieces in `pieces/<hash>/` (`node/storage.ts`). A node
    asked by another for a data piece it doesn't keep fetches it as a byte range from a member it reaches, checks it
    and passes it on without keeping it: with node groups, members connect only to their group's nodes, so the other
    groups' nodes reach the uploader only this way.
  - **Serving members.** A member asks any node for the whole file as usual. The node streams it piece by piece,
    fetching each piece as it is reached and the next one ahead (8 pieces kept in memory), and the member checks the
    whole file's SHA-256 as always. Members never see pieces.
  - **Piece lists.** The uploader's app hashes each 4 MiB chunk while copying a file of 20 GB or more in
    (`core/stream.ts` `storeFile`), stores the list (32 bytes per piece, 2.4 MB for 300 GB) as content of its own and
    names it in `nodes_pieces` after posting the file (`add-pieces`; one per file, the first stays; policy: as
    yourself, never changed). Nodes check every piece they take in against it, so a bad piece is refused at once
    instead of failing a 300 GB download at the end. Files without a list (added another way) are taken unchecked.
  - **Pointers.** Which pieces a node has goes to the other nodes as one bitmap per file (`node-have` `pieces`, base64;
    data piece i is bit i, parity piece g bit `count + g`), sent in full when nodes meet and at most every 2 s per
    changed file: a list of piece keys ran to megabytes.
  - **Placement** is worked out once per change of the nodes, the settings or the data (a 300 GB file has 75k
    pieces), and a file whose piece can't be had now is skipped for that pass and tried again 15 s later.
- **Parity (RAID 4/5).** With `parity` P (2–16; 0 = copies), each piece has one holder, and each group of P pieces
  has a parity piece, the XOR of the group (`<hash>:p<g>`), kept by a node that holds none of the group's pieces when
  there is one. The pieces of a group go to different nodes when there are enough (each to the first node in its
  ranking not taken by an earlier piece of the group): placed independently, a whole group sometimes landed on one
  node, and losing it lost more than one parity piece can rebuild. A piece whose node is gone is rebuilt from the
  rest of its group and the parity piece, after asking nodes and members for it. Storage cost:
  (P+1)/P of the file instead of `copies` times. A gone node can move other pieces of its groups too (their "first
  free" node changes), which costs some healing traffic.
- **Settings.** `nodes_settings` (`copies`, `stripe_mb`, `parity`), changed with `set-storage` by members with "Manage
  nodes" (Server settings > Nodes: copies, "Split big files into pieces" with the size in GB, 20 at least, "parity
  per 4 pieces"). Tests lower the 20 GB minimum (`setMinStripeBytes`, a node's `MAKEWORK_TEST_MIN_STRIPE_MB`).
- **Status.** `status.json` and `list` show, per workspace: files kept, still to fetch, cached, below their copies, the
  pieces held, and files kept in pieces that are here whole all the same (`wholeStriped`, should be 0).

The signed history is **not** split: every node and member keeps all of it, because checking any change needs the
state before it.

## Files between peers (`core/content.ts`, `core/stream.ts`, `p2p/stream.ts`, `p2p/content.ts`)

- **Identity.** Content is identified by SHA-256 (`mwc:<hash>` in rows) and never stored in workspace data.
- **Transfer.** It moves in 4 MiB chunks: the receiver asks (`content-want`), the holder sends a chunk and waits for
  its ack before the next. A receiver resumes from its partial file; a stalled transfer stops after 30 s.
- **Senders.** A member serves one receiver at a time. A node serves several, adapting between 4 and `--senders`
  (default 32): one more per round while every chunk is acked within a third of the idle timeout, halved when one
  takes more than half of it.
- **What a member keeps.** `ContentLink` decides: its own uploads, synced files and channels up to the auto-download
  size, and chat images. The rest stays a placeholder until opened.

## Other live data

- **Presence:** cursors, typing, what a member has open (`p2p/presence.ts`). Short-lived, sent over mesh channels
  (relayed by nodes in the hub), never stored. A member says which channel it is in to everyone (when it changes
  and every 30 s), but sends its state (cursor, selection, typing) and channel events only to members in the same
  channel, so a node relays each cursor move to a channel's viewers instead of to every member. A member coming into
  a channel gets the others' state at once.
- **Voice presence:** in memory and sent peer to peer (`p2p/voice.ts`); call media goes over the call room.
- **Private messages** (`dm/`): a separate Trystero room per pair of accounts, sealed with keys from the two accounts'
  ECDH, and left on the user server (`user-server/`) when the other side is offline.

## Limits and what comes next

Tested with `mesh-test` (scenario s9, see `mesh-test/NODES-REPORT.md`, "Larger-network items"), all on one 16-thread
host:
- **Hub:** 100 members with 3 nodes, and 50 with 6 nodes in two groups: every member connected only to the nodes of
  its group, files from the nodes, healing after a node was killed, pieces rebuilt from parity.
- **Bursts of joiners:** 30 joining at the same second all had the history within 49 s. 50 at once still overloads
  the test host (all members' WebRTC setup on 16 threads; the nodes stayed nearly idle). Waves worked up to 100.
- **Without nodes:** 30 and 50 members fell back to the grid (p50 2–12 connections instead of 29–49). 100 members
  switching at the same second (about 1,300 connections at once) overloaded the test host.
- **Relay fan-out:** each commit reaches an app about twice instead of 3–5 times; at 100 members messages still take
  about 5 s, which this host's load explains (it is saturated before the messages start).

- **Hub capacity.** A node holds one WebRTC connection per member online (werift, JavaScript), and every member's
  presence and live commits pass through it. Node groups cap a member's connections at 3, and each node's at the
  members of its group.
- **No nodes:** the grid needs most of a workspace's members online (see above); otherwise members connect to everyone.
  Sizing it by the members online would need everyone to agree on that number.
- **Open:**
  - Piece lists for big files added through the readable folder (`electron/mirror.js` hashes them in the main
    process; they are split unchecked now), and members checking pieces while they download.
  - Spreading the fallback over a few seconds per member, so a whole workspace doesn't switch rooms at once.
  - A member overlay sized by who is online.

Calls through a node (a mediasoup SFU, `node/sfu.ts`, `p2p/sfu.ts`) are described in `nodes.md` and decisions 0005
and 0007 (`decisions.md`).
