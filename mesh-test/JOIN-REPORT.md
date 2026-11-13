# Joining a big workspace (2026-10-15)

Users joining Bite Gameworks (17,467 signed commits, 37 MB of history, a 14,915-file folder upload, a signed snapshot
since 2026-10-15 13:41 UTC) waited a long time, or their desktop app froze or went blank. The user's hypothesis was
that the join pulls all or most of the data to the newcomer and stalls or crashes it. Measured on a read-only copy of
the workspace's folder (`.makework/commits` and `server.json` only), never on the live room.

## How it was measured

- **The desktop app as a joiner**: `tools/join-copy.sh <copy> [out] [--interval ms] [--snapshot]`. The working
  tree's app runs in the mwt-app image with `--network none` on an offline account. It joins the copy (an empty
  ledger, the real `ContentLink`, readable folder, UI), and the copy's commits are fed to it the way a peer's
  catch-up arrives: log order, 200 per batch, not waiting for one batch before the next. Then every channel is
  opened. It records the time per batch, long tasks, the longest gap between frames, the JS heap, the processes'
  memory, readable-folder passes and content scans.
- **The real sync between two ledgers**: `app/tests/p2p/joinCopy.test.ts` (skipped unless `MAKEWORK_JOIN_COPY` points
  to the copy). Two `WorkspaceSync`s over the in-memory network: a source with the whole history and an empty
  joiner. Three cases: the whole history, a bootstrap from the snapshot (its state rebuilt from the commits it covers,
  25 MB), and a snapshot whose state the joiner can't fetch.

## Findings

| | What | Status |
|---|---|---|
| J1 | A joiner that started from the snapshot never caught up | **confirmed, fixed** |
| J2 | Batches applied in the order their checks finished, so the history was replayed from commit 0 several times | **confirmed, fixed** |
| J3 | A joiner that refused the snapshot it was sent stayed stuck with it | **confirmed, fixed** |
| J4 | Taking in the whole history freezes or crashes the desktop app | **ruled out** (in isolation) |
| J5 | Readable folder, content scans or a heavy channel view after the join | **ruled out** |

**J1. The snapshot bootstrap never finished (high).** `Ledger.vector()` counted each replica's run of seqs from 0,
and only then took the snapshot's vector as a floor. A member that started from the snapshot holds the commits
after the cutoff but none before it, so for every replica that went on writing after the cutoff its vector stayed at
the cutoff. The source answered every hello with the same tail and the joiner dropped it as already there. The
joiner never counted as caught up, `checkSource` called each source stalled every 10 s and moved to the next, and
the member never settled into its rooms. Every joiner whose source holds the snapshot's state hits this: the
creator's device, and the node once it has fetched the state. Joining took "forever".
Measured: stuck at 118 commits with 4 replicas short (`q4MHKl 1349/1428`), re-sent about once per hello for the 60 s
limit. Fixed: the count goes on from the snapshot's vector. The bootstrap now takes 0.46 s and one batch.
Test: `ledger.test.ts` "counts the commits after the snapshot a member started from…" (fails on the old code).

**J2. Out-of-order batches made the ledger replay everything (medium; mostly nodes).** `WorkspaceSync.receive`
doesn't wait for one batch before taking the next, and `Ledger.accept` stored and applied each batch as soon as
its signatures were checked. When a later batch finished checking first, the earlier one landed behind it, and the
log replayed from that point: from commit 0 while no checkpoint existed yet, and once more for the snapshot.
Measured in node, fast link (89 batches at once): 3 full replays (4.3 s), no data at all for 5.3 s, and on the
fallback path 47 pingpong commits wrongly refused ("Unknown table pingpong/…": they were applied before the
plugin's registration). The desktop app's WebCrypto finishes nearly in order, so there it cost little (see J4).
Fixed: checks still run in parallel, but batches are stored and applied in the order they came in (`acceptTurn`).
Now: 2 full replays (1.8 s; one is the refused snapshot's retry, the other wasn't traced), data after 2.5 s, no
wrong refusals. Test: `ledger.test.ts` "stores and applies batches in the order they came in…" (fails on the old code).

**J3. A snapshot the joiner refuses (medium).** When the joiner gets the state but refuses the snapshot, for example
on an app version without one of the workspace's tables, it keeps only genesis, the snapshot and the commits after
it. Its vector says it has nothing, so the source sends the snapshot path again at every hello. The full-history
fallback only ran when loading the state threw. Fixed: a refused snapshot makes the sync ask that peer for the
whole history. Every later hello to it asks again, in case the first request was answered "busy". Test:
`sync.test.ts` "gets the whole history when the snapshot it was sent can't be used here" (fails on the old code).

**J4. Taking in the whole history doesn't stall the desktop app by itself.** In the container (one machine, 16
threads):

| run | first data | all applied | longest frame gap | long tasks (total) | JS heap | renderer RSS |
|---|---|---|---|---|---|---|
| whole history, a batch every 100 ms | 0.36 s | 11.3 s | 0.79 s | 16 (3.1 s) | 205 MB | 507 MB |
| whole history, a batch every 5 ms (fast link) | 0.38 s | 7.3 s | 0.77 s | 14 (3.0 s) | 210 MB | 551 MB |
| same, with J1–J2 fixed | 0.38 s | 8.0 s | 0.77 s | 16 (3.1 s) | 216 MB | 572 MB |
| from the snapshot (25 MB state), fixed | 0.62 s | 0.63 s | 0.46 s | 3 (0.6 s) | 195 MB | 441 MB |

No crash in any run. The slowest batches are the last two (0.8–0.9 s), the ones around the snapshot commit, which a
member without its state refuses and then replays the history for once (`replay`'s `retry`).

**J5. Ruled out**: the readable-folder pass after each batch costs nothing for a joiner, because files it doesn't
keep aren't written (2 passes, 20–108 ms in total). Content scans (`wanted()`) ran 4 times, 56–115 ms. Opening each
of the 19 channels afterwards blocked the page for at most 269 ms: chat "general", the files channel with
14,915 entries 54–64 ms.

## Not covered, still open

- **The crash/blank window was not reproduced.** What the harness leaves out: WebRTC/Trystero (37 MB through the data
  channel, from a werift node), the content download of the 25 MB state from peers, and other members online. If it
  happens again, the tester's `<userData>/logs/main.log` (packaged builds log there; `MAKEWORK_LOG=1` for a dev run)
  has a `[renderer gone]` line with the reason (`oom`, `crashed`, `killed`) and the `[sync]` timings of the join.
- **Fetching the snapshot's state** tries each peer in turn (`ContentLink.fetchFromPeers`, up to 10 s each when a
  peer doesn't answer), not first the peer that sent the snapshot, which has it. With few peers this is seconds.
  Not changed.
- **One full replay** remains on every member without the snapshot's state, whenever a replay passes the refused
  snapshot commit (`replay`'s `retry`), about 0.8 s in the app. Not changed. Members get the state once someone
  online has it (`members_snapshots.content` is wanted everywhere).

## Over the network: scenario s12 (2026-10-15, later)

`BASE_FOLDER=<workspace folder> ./run-scenario.sh s12` (README): the owner's app holds a replica of the base (every
commit signed again with test keys, same data), a node hosts it, and 5 more apps join it at once with an invite over
the test LAN. Target: each app shows the workspace's name and its channels within 5 s of its join.

**Fixed on the way** (each made the join fail outright, not slow):

| | What | Where |
|---|---|---|
| N1 | An invitee was only admitted by a peer it met in the hub room. Members are passive there, so without a node online nobody could join a workspace (it reached the owner in the member room after ~47 s and was never let in). Invite proofs now count from any of the workspace's rooms; each needs the room secret. | `sync.ts` `hasValidInviteProof` |
| N2 | Content was members-only, so a joiner (and a node hosted after the snapshot) could never fetch the snapshot's state it needs to become one, fell back to the whole history, and got nothing where nobody had that any more (the snapshot's maker compacts it away). Peers admitted by invite may now fetch a workspace's snapshot state, and only that. | `stream.ts` `invitees`, `content.ts`, `node/host.ts` |
| N3 | A snapshot refused because its state wasn't here yet stayed refused: the member kept only the commits after it, for good. It is now asked for again (5 s, doubling up to a minute) and taken up once here. | `sync.ts` `retrySnapshotLater`, `Ledger.retrySnapshots` |
| N4 | The state's download was cancelled as soon as the joiner's first commits came in (`prunePartials`: no row points at a state before it is applied), so every joiner waited for a retry. Content asked for directly is kept while asked for. | `content.ts` `ensureContent` |
| H1 | The harness was from before the workspace rename and the invite rework (`core/servers.ts`, `serverLedger`, codes without tokens), so no scenario could run; its `Ledger.accept` wrapper also dropped the snapshot loader. | `harness/lib/*`, `bot/bot.ts` |

**Measured** (6 apps, 1 node, one host; ms from each app's join call):

| history | found the node | name + channels on screen | everything |
|---|---|---|---|
| snapshot (24 MB state), before N4 | 3.5–4.2 s | 22–28 s | 22–28 s |
| snapshot, all fixed | 3.5–4.2 s | 11.9–15.1 s | 11.9–15.1 s |
| full history (17,470 commits), all fixed | 2.0–2.6 s | 5.8–8.2 s | 20.7–23.9 s |

No app froze or crashed (`s12.responsive`), and every one got everything.

**What keeps it above 5 s** (the screen appears as soon as the data does):
- **Finding a node**: 2–4 s. Joiners are passive and wait for the node's announce, every 4 s (`vite.node.config.ts`).
  Without a node, members announce once a minute: a joiner found the owner after 47 s.
- **The first data the screen needs is ~10 MB.** The history's second commit is the `server.import` from the old
  server's conversion (2026-10-07): 10.13 MB, 8.78 MB and 0.98 MB of it two zip files inline as `data:` URLs (against
  "never put file content into server data"). The channels come with it, so nothing shows before it is all here, at
  3.5–4 MB/s per joiner from the node (5 joiners at once). The snapshot's state is 24 MB: the same inline files plus
  14,915 file rows.
- One joiner of five got "busy" from the node for the state (it serves 4 at first) and retried 5 s later.

Options, each a change for the user to decide: announce every 2 s on nodes (about 1 s off finding one); give the
snapshot a small outline (workspace, categories, channels, members, roles) to show first and the rest after; move
inline `data:` file contents into the content store with one commit, so a new snapshot's state drops ~10 MB;
compress batches and the state on the wire (a protocol version).
