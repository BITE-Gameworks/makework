# Mesh integration test report: serverless servers with 2–20 clients

2026-10-08 · app `072006f` · harness and infrastructure in `mesh-test/` · raw data in `mesh-test/results/<run>/`

## Summary

**Question:** when several clients are on the same server, do they fail to see each other, fail to communicate, or
take too long to synchronize?

**Answer:** on one network, members **always found and saw each other** in every run, up to 20 clients: 380 of 380
connections were direct, none failed. The problem is **synchronization**, and it gets much worse with group size.

- Messages arrive within milliseconds up to about 10 members.
- From about 15 members on, a **commit broadcast storm** builds up.
- At 20 members a single round of messages took up to **89–100 s** to arrive, and under steady chatting up to
  **256 s**. Some members were still missing 70–156 of 190 messages after 4 minutes.
- Sync traffic for one test grew from 5 messages (2 clients) to **1.39 million data-channel messages / 1.1 GB**
  (20 clients), for a server with only 48 commits.

The cause is a race in `Ledger.accept` combined with forward-to-everyone flooding. An in-page experiment that only
adds a duplicate check before verification removed the storm completely on the same hardware:

| 20 clients | Without the fix | With the fix |
|---|---|---|
| Latency (p95 / max) | 34 s / 89 s | 0.02 s / 0.02 s |
| Commit traffic | 1.1 GB | 14 MB |
| Duplicate accepts | 80,868 | 0 |

Six more problems were found:
- **Permanent divergence after leave + rejoin:** sequence numbers are reused, so members who were offline never get
  the new messages.
- **Members two hops apart never see each other:** presence, voice and the online count stop at one hop.
- **Slow visibility across networks:** 17–27 s through a member relaying, 68 s through TURN.
- **A server joined just before a crash disappears.**
- **About 12 s to find the first peer when 20 join at once.**
- **One of the 5 hardcoded public relays is dead.**

## Fix status (2026-10-08, same rig and host, image rebuilt from the patched source)

The serverless stabilization (`app/src/p2p/{ledger,sync,mesh,servers,relays}.ts`, `src/core/db.ts`) was
verified with the same scenarios. **Every scenario now passes** except three efficiency checks, explained below.
Unit tests: 121 pass, including new ones for the race, forwarding, rejoin and relaying.

| Finding | Before | After |
|---|---|---|
| F1 storm, S1 at 20 clients | 1,392,056 commit messages / 1,107 MB, 80,868 duplicate accepts, latency p95 34 s / max 89 s | **993 messages / 1.5 MB, 0 duplicates, p95 0.02 s / max 0.02 s** |
| F1, S3 messaging at 20 clients | paced p95 210 s, up to 156/190 missing after 240 s, 2.4 GB | **all delivered, paced p95 11 ms, burst p95 3.9 s, 0 duplicates**, 1.0 deliveries per commit (was 19) |
| F1, S2 with 5 servers and 20 clients | latency p95 29–71 s, max 116 s, a message missing | **p95 0.6–0.7 s, max 0.8 s, 24/24** |
| F2 leave + rejoin (S4b/c) | 3 seq collisions; offline members never got the messages | **0 collisions; caught up after 13–15 s; all converged (19/19)** |
| F5 kill 1 s after joining (S4a, `--settle-s 0`) | server gone after restart | **server kept; back online and caught up** |
| F4 TURN only (S6) | data and visibility after 68 s | **3.5 s / 3.2 s** |
| F4 bridge, 10 clients (S5) | visible after 17 s | **2.9 s** |
| Mixed versions (2 old + 3 new clients) | – | **connect, sync and converge**; only the old clients still show duplicate accepts |

The three efficiency checks still failing:
- **S3 burst at 20 clients: 2.11 deliveries per commit**, against a limit of 2. These are copies from a 20 s re-hello
  landing during the burst. They're dropped by signature before verification, so they cost almost nothing.
- **Mixed versions:** the 2 old clients still flood and race; they need the update.

Still open (deferred to the dedicated server):
- **F3:** two-hop members still don't see each other.
- **F6:** the first peer in a 20-client burst join took 13.7 s (p50) after the change, against 10.8 s before. Every
  connection now also gathers TURN candidates (380 allocations at once on the loaded test host). For the same reason,
  bridge visibility at 20 clients only improved from 26 s to 21 s; the burst join dominates there.
- **Already-diverged servers:** a member missing commits from someone's earlier rejoin gets them by leaving and
  joining again (a full fetch).

## Setup

| | |
|---|---|
| Clients | 2–20 real copies of the desktop app: Electron 44.5.1 / Chrome 152, Vite dev mode, `app/src` at `072006f`. One rootless podman container each, with its own profile, account and IP. |
| Signaling | 5 local strfry Nostr relays posing as the 5 public relays Trystero 0.26.0 picks for appId `makework` (via `--host-resolver-rules`, Caddy TLS, a local CA). Each event is delivered once per relay, as in production. No app code changed. |
| TURN | Local coturn 4.7; `VITE_TURN_URL` points at a local credentials stub. Production TURN was never used. |
| Networks | `--internal` podman networks with no internet. `single`: one LAN. `split-bridge`: two LANs, 2 members on both. `split-chain`: three LANs in a row. `split-turn`: two LANs, no shared member. `public` (S7 only): internet with the real public relays. |
| Driving | `mesh-test/harness`: Playwright over CDP. It drives the real UI (S0) or the app's own modules (`core/serverless.ts`, `core/account.ts`, the chat API). An init script records every RTCPeerConnection, Nostr WebSocket, data-channel message and `Ledger.accept`/`replay` call. |
| Host | Ryzen 7 1700X (8 cores / 16 threads), 31 GB RAM, podman 5.8.7 |

## Results by scenario

All runs below are the valid ones. Earlier runs invalidated by harness bugs are listed under
[Harness issues](#harness-issues-found-and-fixed).

| Scenario | Clients | Verdict | Key numbers |
|---|---|---|---|
| S0 UI smoke: register, create, invite menu, join, "(2 online)", typed messages | 3 | ✅ 20/20 | Data 1.3–1.8 s after join; typed message seen in 4–5 ms |
| S1 scale ramp, burst join | 2 / 5 / 10 / 15 / 20 | ✅ 9/9 each | see [F1](#f1-commit-broadcast-storm-critical); everyone always saw everyone |
| S1 sequential join | 10 / 20 | ✅ 9/9 each | message max 100.6 s at 20 |
| S2 invite chain + 5 overlapping servers | 20 | ❌ 22/24 | Every invite worked, including from non-owners (data in about 0.9 s each); no leaks between servers; leaving one server kept the other connected. Messages p95 29–71 s, max 116 s; c16 missed one message in server E within 120 s |
| S3 messaging, 10 per client, paced then burst | 10 | ❌ 10/14 | All delivered. Paced p95 7 ms, burst p95 7.7 s. **9,320 duplicate accepts** |
| S3 messaging | 20 | ❌ 4/14 | Paced p95 **210 s**, max 256 s. Up to 156 of 190 messages missing after 240 s. 2.4 GB of commit traffic, 182,589 duplicate accepts |
| S3 messaging with dedupe fix (experiment) | 20 | ✅ 12/14 (only the efficiency checks fail) | Paced p95 17 ms, burst p95 5.6 s, all delivered, 0 duplicates, 122 MB |
| S4a kill + restart 3 clients (after settling) | 10 | ✅ | Back online and caught up in about 2.5 s |
| S4b leave + rejoin, then post while 2 members are offline | 10 | ❌ | **Seq reuse: 3 colliding commits; the offline members never got them** ([F2](#f2-permanent-divergence-after-leave--rejoin-high)) |
| S4c half offline for 60 s, then heal | 10 | ❌ | Offline writes worked and everyone saw everyone after about 2.2 s, but the offline half each missed 3 messages ([F2](#f2-permanent-divergence-after-leave--rejoin-high)) |
| S5 bridge | 10 / 20 | ✅ 8/8 | Cross-LAN visibility after 17 s / 26–27 s, messages p95 10–22 ms |
| S5 chain, no TURN | 9 | ❌ 8/9 | Two-hop members never counted each other online ([F3](#f3-members-two-hops-apart-never-see-each-other-medium)) |
| S6 TURN only between LANs | 10 | ✅ 9/9 | Far LAN got data and visibility after **68 s** ([F4](#f4-slow-visibility-across-networks-medium)) |
| S7 real public relays | 10 | ✅ 9/9 | Visible after 2.4 s, messages p95 7 ms; no rate limiting; 1 relay dead ([F7](#f7-one-of-the-5-hardcoded-relays-is-dead-low)) |
| Negative control: relays stopped | 3 | ❌ as expected | The harness cannot pass vacuously |

## Findings, ranked by severity

### F1. Commit broadcast storm (critical)

**Symptom.** Sync slows down sharply as members are added, and at 20 members whole message rounds take minutes. This
is the reported "they take too long to synchronize", and it can look like a connection error. Connectivity itself
is fine: in the 20-client run all 380 connections were direct and connected, 0 failed, 0 used TURN.

The same test (one server, burst join, one message per member) at each size, all on one LAN:

| Clients | Commit messages sent | Commit traffic | Accepted as new | …of which duplicates | Server commits | Message latency p95 / max |
|---|---|---|---|---|---|---|
| 2 | 5 | 0.0 MB | 21 | 9 | 12 | 0.0 s / 0.0 s |
| 5 | 324 | 0.5 MB | 200 | 128 | 18 | 0.0 s / 0.0 s |
| 10 | 10,206 | 9 MB | 1,574 | 1,322 | 28 | 0.0 s / 0.0 s |
| 15 | 111,266 | 96 MB | 10,472 | 9,940 | 38 | 0.0 s / 0.0 s |
| 20 | **1,392,056** | **1,107 MB** | 81,780 | **80,868** | 48 | **34.4 s / 89.3 s** |

Traffic grows about ×10 for every 5 members. At 20 clients the clients used about 12 of 16 host threads on average,
and 14.7 GB of memory against about 3.6 GB idle.

**Cause.** Three pieces feed each other:

1. **Race in `Ledger.accept`** (`app/src/p2p/ledger.ts:160-172`). It first awaits `verifyCommit` for every commit
   (an ECDSA verify, duplicates included). Then it checks `this.hashes`, then awaits `store.add` (IndexedDB). Only
   then does `integrate` → `add` put the hash into `this.hashes`. A commit that arrives from two peers while the
   first copy is still being verified or stored passes the duplicate check twice and is returned as "new" twice.
   The in-memory state stays correct, because `add()` dedupes again, which is why everything still converges.
2. **Forward to every direct peer** (`app/src/p2p/sync.ts:113-118`). Every "new" commit is re-sent to all other
   direct peers. Each false "new" from step 1 therefore produces N−2 more copies, each of which is verified again.
   More load makes the race window longer, which makes more duplicates: a feedback loop.
3. **The join handshake sends the missing log twice** (`sync.ts:66-70`, `109-112`). On every new connection both
   sides send `hello(reply)`, and each answers with the missing commits plus another hello. In a 20-member burst,
   these 190 connection handshakes deliver the same commits concurrently, which seeds the storm.

**Proof.** The experiment `MWT_EXPERIMENTS=dedupe` (`harness/lib/instrument.js`) wraps `Ledger.accept` in the page.
It drops commits whose `sig` was already seen or is still being accepted, before verification. App files are not
changed. Same 20 containers, same host:

| 20 clients | S1 baseline | S1 + dedupe | S3 baseline | S3 + dedupe |
|---|---|---|---|---|
| Duplicate accepts | 80,868 | **0** | 182,589 | **0** |
| Commit traffic | 1,107 MB | **14 MB** | 2,385 MB | **122 MB** |
| Message latency p95 / max | 34.4 s / 89.3 s | **0.02 s / 0.02 s** | 210 s / 256 s (paced) | **0.017 s / 0.09 s** (paced) |
| Everything delivered | yes (within 120 s) | yes | **no**, up to 156/190 missing after 240 s | yes |
| Client CPU (mean, % of one thread) | 1213 % | 819 % | 1396 % | 874 % |

The remaining cost with the fix is the forwarding itself: 19 deliveries per new commit (N−1), so O(N²) traffic.
That's acceptable at 20 members but will limit larger servers.

**Recommended fix (not implemented):**
- In `accept`, drop already-known and in-flight commits *before* verifying. Key them by `sig` (or a cheap hash of
  the wire form), add them to an in-flight set synchronously, and remove them after `integrate`.
- Forward only commits that were really new.
- Answer `hello` only once per connection.
- Longer term, push only to peers whose last vector lacks the commit, or gossip to a few peers instead of all.

### F2. Permanent divergence after leave + rejoin (high)

**Symptom.** After a member leaves a server and joins it again, anything they post can permanently fail to reach
members who were offline at that moment. It never syncs, not even through the 60 s re-hello.

**Evidence (S4b, 10 clients).**
- c03 left and rejoined, then posted 3 messages while c04 and c05 were offline.
- The harness found **3 colliding commits**: replica `PmDG9…` at seq 0, 1 and 2, each signed twice with different
  content.
- c04 and c05 came back, saw everyone again, and **still lacked all 3 messages after 180 s**. Their commit set
  stayed at 42 while the rest had 45.
- In S4c, 60 s later, c03 posted again. The offline half (c02, c04, c06, c08, c10) each ended **3 messages short**.
  Only the per-member counts were recorded, not which messages; exactly 3 each is consistent with c03's 3 posts
  colliding again.

**Cause.**
- `leaveServer` (`app/src/p2p/servers.ts:164-169`) clears the stored commits but keeps the replica id
  (`mw.p2p.replica.<account>.<server>`, `servers.ts:70-77`).
- On rejoin, `Ledger.load` (`ledger.ts:101-106`) computes `seq` from local storage only, so it restarts at 0. It is
  never advanced by the replica's own old commits arriving from peers, so it keeps colliding until restart.
- `vector()` / `missing()` (`ledger.ts:136-152`) count by (replica, seq). Members who already hold the old seq 0..n
  report them as present, so the new commits are never offered again. Only peers online at the moment of posting
  get them.

**Recommended fix:** use a new replica id on every join (delete the key in `leaveServer`), and/or advance `seq` past
any received commit of the own replica.

### F3. Members two hops apart never see each other (medium)

**Evidence (S5 chain, 9 clients, lan-a ↔ bridge ↔ lan-b ↔ bridge ↔ lan-c, TURN off).**
- One-hop members became visible through the bridge after about 17 s.
- Members two hops apart **never** counted each other: each saw 5–6 of 8.
- Their messages did arrive, because commits flood member to member.

**Cause.** Relaying is one hop only (`app/src/p2p/mesh.ts:7`, `186-188`). Presence, voice presence and media, and
the online count all use the mesh. This matches a live test: "two members in one call
never saw each other (both saw the third)".

**Recommended:** multi-hop routing in `Mesh` (distance-vector over the existing peer lists), or request TURN for
peers that are only heard of indirectly.

### F4. Slow visibility across networks (medium)

| Path | Time until members across the networks see each other | Cause |
|---|---|---|
| Through a member on both networks (S5 bridge) | 17 s with 10 clients, 26–27 s with 20 | `relayAfterMs = 15_000` (`mesh.ts:10`); the 5 s check interval adds on top |
| Through TURN only (S6) | **68 s**, and the far side has **no server data** until then | TURN is only requested after a direct attempt failed (Trystero reports after 23–57 s, `signal-handler.mjs`), then waits for the next announcement |

S6 is the "joining hung" case. A joiner who can only reach the others through TURN sees "Joining..." for over a
minute. **Recommended:** relay as soon as a peer is heard of and not directly connected; fetch TURN credentials up
front and try TURN after the first failure.

### F5. A server joined just before a crash disappears (medium)

**Evidence.**
- S4a with 1 victim: the victim was killed (SIGKILL) 0.9 s after joining.
- After restart it was signed in but had **no servers at all**; the other members still listed it.
- A client killed minutes after joining came back with its server and reconnected within seconds.

**Cause.** The joined-server list is in localStorage (`mw.p2p.servers.<account>`, `servers.ts:53`). Chromium writes
localStorage to disk with a delay of a few seconds. Accounts are in IndexedDB and survive.

**Recommended:** keep the joined list in IndexedDB (like accounts and commits), or in the main process via IPC.

### F6. 20 simultaneous joins take about 12 s to find a first peer (low–medium)

**Evidence.** In a burst join, the app's own log line "first member found after X s" took p50 1.8 s (10 clients),
3.7 s (15) and **10.8–11.9 s (20)**. That is the same with or without the dedupe fix, so it's signaling and WebRTC
setup, not the storm. Sequential joins at 20 are fast.

The local relays reported no rejections. Part of this is likely the loaded host: about 8 of 16 threads were busy
even with dedupe. Each join creates N−1 connections and every offer, answer and ICE candidate goes out through 5
relays (8–9k events published, 18–22k received per 20-client run).

### F7. One of the 5 hardcoded relays is dead (low)

**Evidence.** In S7, with the real public relays, `wss://nostr.christiansass.de` failed for every client (0 of 25
opens). The other 4 worked, and there was no rate limiting with 10 clients from one IP. The app worked fine, but
signaling runs with 20 % less redundancy.

Trystero picks the relays from the appId, so this can't be changed per user. **Recommended:** pass an explicit
`relayConfig.urls` list in `sync.ts:41` that the project controls.

## Suspected issues not reproduced or not covered

| Suspicion (from code reading) | Result |
|---|---|
| Duplicate profile row on rejoin (`servers.ts:106-108`) | Not reproduced: `s4b.single-profile` found 1 row |
| Relay rate limits when many clients share one IP | Not seen with 10 clients (S7); 20 public clients not tried, to avoid getting the user's IP limited |
| Handler overwrite on reopening the same room (`mesh.ts:67-69`) | Not triggered: the UI can't open one server twice |
| Shared RTCPeerConnection across servers breaks when one is left | Not reproduced: in S2, leaving server B kept the pair connected in C |
| Stream cleanup when a relayed peer drops; file sync throughput (one download at a time, 30 s retry) | Not covered: no voice/media or file scenarios in this pass |
| Folder storage appending duplicate lines because of the F1 race (`storage.js:68-70`) | Not covered (IndexedDB storage was used), but it follows from F1 |

## Harness issues found and fixed

Some runs were invalid because of harness bugs. They were fixed, and the affected scenarios were rerun. Only the
reruns are counted above.

1. **Stale samples.** A tracker could pass using a sample taken before its step started: the previous round's count,
   or the state before a kill. This produced false failures in S3 burst and S2 leave, and a false pass in S4a. Fixed:
   samples record which message round they counted (`driver.mjs` `seenPrefix`), and trackers ignore samples older
   than their start (`metrics.mjs`).
2. **S4a killed clients about 3 s after they joined**, which hit F5 instead of testing recovery. It now waits
   `--settle-s` (default 15); `--settle-s 0` reproduces F5.

## Limitations

- Dev mode (Vite) rather than the packaged build. The p2p code is the same, but timing can differ slightly.
- Local networks have no NAT, packet loss or real latency. The direct connections here are a best case.
- 20 Electron instances load an 8-core host heavily, so absolute 20-client timings are pessimistic. The
  with/without-fix comparisons ran on the same hardware.
- One run per configuration. The trend (×10 per 5 members) is consistent across all runs, but single numbers vary.

## How to run it again

```sh
cd mesh-test
./up.sh 20 single                      # or split-bridge | split-chain [--no-turn] | split-turn | public
./run-scenario.sh s1 --join burst      # s0 … s7, see README.md
HARNESS_ENV="MWT_EXPERIMENTS=dedupe" ./run-scenario.sh s3   # the F1 fix experiment
./down.sh
```

Each run writes `results/<run>/summary.md` (assertions, times, visibility matrix), plus `metrics.json`,
`timeline.jsonl`, per-client console logs and `podman-stats.csv`. The mesh test is dev-only and never part of a
build.
