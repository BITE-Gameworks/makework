# MakeWork node

A node is a computer that stays on and hosts serverless workspaces: an admin adds it to a workspace, and it joins the
workspace's room as part of it (no invite), keeps its signed history and its share of the files, which it serves to
members (the closest node that keeps a file first). Members connect to the nodes rather than to each other, so a
workspace with nodes grows with the number of nodes, not of members (see `architecture.md`).
It can also show an invite page per workspace. Code in `app/src/node/`, shared protocol in `app/src/p2p/nodes.ts`, adding a
node in `app/src/p2p/pair.ts`.

## Install

Get `makework-node.tar.gz` from https://makework.dev/download. On the machine (Node.js 22 or newer):

```sh
tar -xzf makework-node.tar.gz
cd makework-node
npm install --omit=dev        # werift (WebRTC in JavaScript), maxmind (GeoIP reader) and mediasoup (calls)
node makework-node.mjs start --url https://mw.example.com --port 8080
```

To update, unpack a newer download over that folder, run the install again and restart the node. Its data is kept
elsewhere (see Data folder).

## Building it

With the source: `npm run build:node` in `app/` writes `dist-node/makework-node.mjs` and `dist-node/package.json`, the
same files as the download (`.github/workflows/release.yml` packs them on a release tag). During development,
`npm run node -- <command>` builds and runs it. `dist-node/vendor/node-domexception` is the app's stand-in for a
deprecated package under mediasoup (`app/vendor/node-domexception/README.md`), so the install prints no deprecation
warning.

## Commands

| Command | |
|---|---|
| `start [--port 8080] [--url URL] [--address IP] [--geoip country\|off] [--senders 32] [--receivers 8] [--cache-gb 2] [--heal-after 15] [--rtc-port 40000] [--rtc-ports 20000-49999]` | Runs the node and prints its code. Options are saved in `node.json`. |
| `code [--new]` | Prints the node's code; `--new` makes another and the old one stops working. |
| `unhost <workspace>` | Stops hosting it and deletes the node's copy of its history. |
| `list` | Hosted workspaces, who added the node, and what the running node last reported. |

**Adding the node to a workspace.** In the app, someone with "Manage nodes" (by default the owner and administrators)
opens Workspace settings > Nodes > Add a node and pastes the node's code (`mwn1.<node id>.<pair secret>`), optionally
with an invite page path. The app finds the node in a room only that code opens (signaling through the Nostr relays,
then WebRTC, like a workspace: no open port needed), checks the node's key against the code, adds the node's row
already authorized, and sends it the workspace's id and room secret, sealed to the node's key. The node saves it in
`node.json` and starts hosting it. It needs no invite: every member counts a node a member added as part of the
workspace, and it gets the next room secret after a kick or ban like a member. Removing it in Workspace settings > Nodes
shuts it out; `unhost` deletes its copy. Anyone with the code can make the node host their workspace, so keep it to
yourself (`code --new` replaces it). `host <invite>` and `link` from before 2026-10-16 are gone.

**Invite pages.** A node shows a page per workspace at `<url>/<path>`, the path set on the node in Workspace settings >
Nodes. It shows the newest open invite created with "Show on the nodes' invite pages" (that invite's token is kept
readable in the workspace, as it is public anyway), or says no invite is open. Nodes never make invites.

`--senders` is the most members that get files from it at once, per hosted workspace; the number adapts below it (4 at
first, more while every chunk is confirmed quickly, half when one is slow). Others hear "busy" and try another node or
member, then again later. Each holds one 4 MiB chunk in memory and they share the upload.

`--receivers` is the most members whose new uploads it takes at once, for all hosted workspaces together. Each
uploader's files come one after the other, different uploaders' files at the same time; with more uploaders than
that, they take turns file by file. `list` shows how many are being taken and how many wait.

**Files across nodes.** Each file is kept by `copies` nodes (Workspace settings > Nodes, default 1), picked the same way
by every node and member from the workspace's data (rendezvous hashing, `app/src/p2p/placement.ts`). Nodes tell each other
which files they have; a node asked for a file it doesn't keep fetches it from one that does (into its cache) and
serves it. `--cache-gb` is room for those: the oldest cached files go past it. A node not reached for `--heal-after`
minutes counts as gone and the others copy its files, so each file has its copies again; when it comes back, the extra
copies become cache.

**Big files in pieces.** Files of 20 GB and more ("Split big files into pieces" in Workspace settings > Nodes, `stripe_mb`;
20 GB is the default and the least, a workspace can choose more) are kept in 4 MiB pieces, each placed like a file, so they
spread over all nodes (RAID 10). With "parity per N pieces" each piece is kept once plus one parity piece per N (RAID
4/5): less disk, and a piece whose node is gone is rebuilt from the rest of its group. No node holds such a file whole:
nodes take their pieces from each other or as byte ranges from the uploader, check each against the file's piece list
(made by the uploader's app), and serve members piece by piece. `MAKEWORK_TEST_MIN_STRIPE_MB` lowers the 20 GB for
tests only.

**Announcing and pacing.** This build announces itself on the Nostr relays every 4 s (Trystero's default is a
minute): members wait in a workspace's room until they hear a node, so joining takes seconds. It sets up at most 8
connections per room at once; members joining in a burst wait for their next announce (a few seconds each).

**More than 3 nodes.** The nodes of a workspace form groups of up to 3, neighbours by place, and each member connects only
to its nearest group; the nodes connect to each other and pass messages between groups. Members joining for the
first time find the first group's nodes.

**Calls through a node.** A call of `sfu_min_members` members (Workspace settings > Nodes, default 5) stops being sent
member-to-member: one node of the call's group forwards it (a mediasoup router, ADR 0005), so a call with many people
costs each member one connection instead of a dozen. The node is the call's arbiter — it decides whether it serves,
who may join, and what they may send — so every member agrees on the mode; a call that loses its node falls back to
the mesh. The node sees the media of the calls it serves (it forwards it), unlike a mesh call, where members send to
each other. Every member's media comes in on one port, `--rtc-port` (UDP and TCP; default the first port of
`--rtc-ports`, else 40000), announced as the node's public address (`--address`): open it in the firewall, and on a
node at home forward it on the router (UDP and TCP, to the node's machine). Behind a router the node also offers its
LAN address, so members on its own network reach it directly (a router rarely lets them in through its public
address). The log says `Call media on port N` at start; `[sfu] call C: user U send ICE connected` when a member's media
arrives, and `got no media in 20 s` when a member started using a transport (its first send or receive) and nothing
arrived (the port isn't reached). Each call's line (looked at every 5 s, logged when it changed) says what goes through the node:
`[sfu] call C: 3 members here; user 11 sends screen (to 1), mic (to 1); user 22 receives 2; user 33 recv not
connected` (the counts are members receiving through this node: user 33 still gets the call over the mesh; above 12 members the line gives totals and names only the
members not connected), and `[sfu] call C: closed` when it ends. A member whose media never connects
stays on the mesh call meanwhile, so nobody loses the call, and asks that node again after 1 minute, then 2, 4, up
to 15. `sfu_calls`, `sfu_min_members`,
`sfu_capacity` and `sfu_forced` (always, however small the call) are in Workspace settings > Nodes. `sfu_capacity` is
the number of a call's members one node takes before members go elsewhere: the next members go to the next node, a
member who reaches no node with room is taken past it, and the nodes serving the call
link to each other (ADR 0007), so it stays one call. Media between those nodes goes over UDP in the `--rtc-ports`
range (default 10000-59999; only these links use it), encrypted (SRTP), to the address each announces, so a node needs
`--address` (or a STUN answer) for that. Two nodes behind the same router (the same public address) link over their
LAN addresses instead, so that range must be open on each machine's firewall for the other one. A node at home starts with `--rtc-ports 40000-40100` and forwards UDP and TCP
40000 (members) and UDP 40001-40100 (links), plus TCP 8080 (`--port`) for its invite pages unless a web server in front
of it serves `--url`; syncing and files need no open port. Workspace settings > Nodes > "How to add a node?" lists the
same. Without a public address the node serves no call at all (members couldn't reach it). One mediasoup worker
process serves the calls of every workspace the node hosts, and a new one starts if it dies. `--rtc-ports` takes a range
of whole ports (1 to 65535, one port allowed);
a range saved by an older version that isn't one stops the node at start with a note.

`--data DIR` (or `MAKEWORK_NODE_DATA`) picks the data folder, default `~/.makework-node`. `<workspace>` is a workspace id
or the start of one. Adding the node and `unhost` edit `node.json`; a running node picks the change up.

## Data folder

- `node.json` settings, the pair secret (half of the node's code) and hosted workspaces (with their room secrets: keep
  the folder private)
- `key.json` the node's key (its identity in every workspace; mode 600)
- `servers/<id>/commits.jsonl` each workspace's signed history
- `content/<hash>`, `parts/<hash>.part` files and unfinished downloads, shared between workspaces: the files this node
  keeps and its cache. `pieces/<hash>/<n>` (and `p<g>` parity) the pieces of big files it keeps. Once an hour,
  content and pieces no hosted workspace needs any more are deleted, and the oldest cached files past `--cache-gb`
- `geoip/dbip-country-lite.mmdb` DB-IP's free country database (CC BY 4.0), downloaded monthly (4 MB, 8 MB on disk
  and in memory, read only once a member shares their location); members are shown at a point for their country
  (`app/src/node/countryPlaces.ts`, made by `app/scripts/country-places.mjs`). `--geoip off` skips it.
- `status.json` written every 10 s for `list`: per workspace the files kept here, still to fetch, cached, with fewer
  copies than asked, the pieces held, and files kept in pieces that are here whole (should be 0); the catch-up queue

## Behind HTTPS

The web server is plain HTTP; put a reverse proxy in front, for example Caddy:

```
mw.example.com {
  reverse_proxy localhost:8080
}
```

## As a service (systemd)

```ini
[Unit]
Description=MakeWork node
After=network-online.target

[Service]
WorkingDirectory=/opt/makework-node
ExecStart=/usr/bin/node makework-node.mjs start
Restart=always
User=makework

[Install]
WantedBy=multi-user.target
```

## Network

WebRTC connections need UDP. A node behind NAT works like any member, but a public address (or forwarded UDP) makes
it reachable for everyone. Nodes don't use the TURN server. The public address is found once at start through STUN
(Cloudflare, Google) unless `--address` is given; it and the city it is in are shown to the workspace's admins.
