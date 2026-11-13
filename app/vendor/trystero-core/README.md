# @trystero-p2p/core 0.26.0, patched

Trystero's core (MIT, `LICENSE`) as published in 0.26.0 (`dist/` here in `lib/`, `app/.gitignore` ignores every
`dist`), without source maps, with three changes marked `MakeWork:`. `app/package.json` makes it a dependency and
`overrides` makes `trystero` and `@trystero-p2p/nostr` use it, so it works with `npm ci --ignore-scripts` (release
workflow) too. The node build changes `lib/signal-handler.mjs` once more (`nodePacing` in `app/vite.node.config.ts`).

## Why

Nodes logged `incorrect password for overlapping room` (or `handshake timed out`) for members at every start, and
members for each other; they reconnected on the next announce. Never a wrong password: the two peers' handshakes for
one room got out of step, each time because a room said "left" and "here" again while the other peer was mid-handshake.

1. A peer that is passive in several rooms of one app id, which another peer is active in, answers that peer from each
   of those rooms at once: a member in its hub and recovery rooms (or several invite rooms) with a node. The first
   connection wins and the duplicates are destroyed, but they were destroyed before the room was attached to the
   winning connection, and their close handler ran `checkDeactivate` right away: with no connected peer yet, the
   passive room said "left" and "here" again. The node restarted its handshake and failed it on the answer to its
   first challenge.
2. A peer joins a room again passive (a joiner's invite room once it is a member) where the other peer is passive too,
   while another room of the app id keeps their connection. The other peer's passive room, left without peers, said
   "left" to everyone, including the peer that had just rejoined; that peer's new room took it as leaving, said "left"
   itself, and both said "here" again on the next "here": a loop restarting the handshake every round (mesh-test s2:
   200 failures in 2 s between two members).

## Changes

- `lib/signal-handler.mjs` `markPeerConnected` (1): sets `connectedPeer` before destroying the duplicate answering peer.
- `lib/shared-peer.mjs` `registerRoom().connect` (1): attaches the room to the shared connection before destroying the
  duplicate peer.
- `lib/shared-peer.mjs` (2): each shared connection remembers the rooms the other peer said it left
  (`remoteRoomsLeft`), and a passive room going quiet (`setActive(false)` → `advertise(false, quiet)`) doesn't say
  "left" to those peers. Everyone else still hears it, and leaving the room still tells everyone.

None of them changes what goes over the wire, so patched and unpatched apps work together. It is the passive side that
needs them: members' apps more than nodes.

`app/tests/vendor/trysteroCore.test.ts` runs real Trystero peers over werift, a test for each case (each fails without
its change), and one that keeps (2) from leaving a peer with a stale "here". Not fixed here: two peers leaving and
joining the same room within one network hop of each other still race (frames don't say which stay in a room they
belong to). MakeWork avoids that where it can (`rotateSecret` keeps the old hub as the recovery room).

## Updating Trystero

Before raising `trystero` in `app/package.json`, check whether the new release has these fixes. If it does, remove this
folder, its dependency and the `overrides` entry. If not, copy its `dist/*.mjs` and `*.d.mts` here again (without the
`sourceMappingURL` lines) and redo all three changes. Run `trysteroCore.test.ts` and `npm run build:node` (which fails
if `nodePacing` no longer applies) either way. The dev server pre-bundles Trystero with this folder and only notices a
lockfile change: after editing files here, start it once with `npx vite --force`. Reported upstream: not yet
(2026-10-16).
