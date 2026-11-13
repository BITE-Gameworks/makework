// S4 churn on one server with every client:
//  (a) kill + restart: some containers are killed, the others post while they are gone, they start again
//      (same profile, session restored). Recovery: back online, seeing everyone, caught up.
//  (b) leave + rejoin: X posts, two members go offline, X leaves and joins again with the same code (same
//      account and replica id), posts again; the two come back. Do they ever get X's new messages? Suspected
//      not: the replica's seq restarts at 0 after a rejoin (ledger.ts load), so the new commits reuse seqs
//      the offline members already have and the version vector never asks for them.
//  (c) half offline: every second client is cut off for a while and posts while offline (scheduled in the
//      page), the online half posts too; then everyone comes back. Time to see each other and to converge.
import * as d from "../lib/driver.mjs";
import { attempt, intArg, sleep } from "../lib/util.mjs";
import {
  channelOf, collect, containerOf, convergence, cut, healAll, kill, meshSnapshot, messageRound, prepare, reattach, setupServer, short, waitTags,
} from "./common.mjs";

export default async function s4(ctx) {
  const { run, args, podman } = ctx;
  const parts = new Set(String(args.parts ?? "a,b,c").split(",").map((s) => s.trim()).filter(Boolean));
  if (!podman.available) {
    run.assert("s4.podman", "podman API socket available for kill/start/network control", false, { socket: podman.socketPath });
    return {};
  }
  await prepare(ctx);
  const [owner, ...joiners] = ctx.clients;
  const n = ctx.clients.length;
  const setup = await setupServer(ctx, owner, joiners, { mode: "burst", label: "s4" });
  if (!setup) return {};
  const { serverId, invite } = setup;
  run.assert("s4.setup", `all ${n} clients have the data and see each other`, setup.data.missing.length === 0 && setup.visible.missing.length === 0, {
    dataMissing: setup.data.missing, visibleMissing: setup.visible.missing,
  });
  // Every client needs the channel id while it can still be reached.
  await Promise.all(ctx.clients.map((c) => channelOf(c, serverId)));

  const numbers = {};
  if (parts.has("a")) numbers.restart = await partA(ctx, serverId, intArg(args, "victims", 3));
  if (parts.has("b")) numbers.rejoin = await partB(ctx, serverId, invite);
  if (parts.has("c")) numbers.partition = await partC(ctx, serverId, intArg(args, "partition-s", 60) * 1000);
  run.number("s4", numbers);
  const conv = await convergence(ctx, serverId, ctx.clients.filter((c) => !c.down), "s4-final");
  run.assert("s4.final.converged", "after all churn every client has the same commits and messages", conv.sameCommits && conv.sameMessages, {
    commitGroups: conv.commitGroups, messageGroups: conv.messageGroups, counts: conv.commitCounts, collisions: conv.collisions,
  });
  const mesh = await meshSnapshot(ctx, serverId, ctx.clients.filter((c) => !c.down));
  run.section("Visibility after churn", mesh.matrix.markdown);
  return { serverId, clients: await collect(ctx, [serverId]) };
}

async function partA(ctx, serverId, victimCount) {
  const { run } = ctx;
  const n = ctx.clients.length;
  const victims = ctx.clients.slice(-Math.min(victimCount, n - 2));
  const others = ctx.clients.filter((c) => !victims.includes(c));
  // Chromium writes localStorage (the joined-server list) to disk a few seconds late: a kill right after joining
  // loses the server (finding of its own, see REPORT.md). --settle-s 0 reproduces that; the default tests recovery.
  await sleep(intArg(ctx.args, "settle-s", 15) * 1000);
  for (const v of victims) await kill(ctx, v);
  // Members notice the loss (data channel closes / pings stop).
  const lossTracker = run.track("s4a: others notice the killed members", others.map((c) => c.name), (s) => (s.servers[serverId]?.online ?? 99) <= others.length - 1);
  const loss = await run.waitTracker(lossTracker, 90_000);
  const round = await messageRound(ctx, serverId, others, others, { perClient: 3, label: "s4a-while-down", timeoutMs: 60_000 });
  const wanted = round.posted ? await tagsOf(others[0], serverId, "|s4a-while-down|") : [];
  await sleep(5000);

  // All containers start together; CDP is reattached to each while they boot.
  const startedAt = Date.now();
  for (const v of victims) await ctx.podman.start(containerOf(v));
  run.event("started", { clients: victims.map((v) => v.name) });
  await Promise.all(victims.map((v) => reattach(ctx, v)));
  const back = run.track("s4a: restarted clients see everyone", victims.map((c) => c.name), (s) => (s.servers[serverId]?.online ?? 0) >= n - 1, { startedAt });
  const seenBack = run.track("s4a: others see the restarted clients again", others.map((c) => c.name), (s) => (s.servers[serverId]?.online ?? 0) >= n - 1, { startedAt });
  const caught = await waitTags(ctx, serverId, victims, () => wanted, { timeoutMs: 180_000, since: startedAt, label: "s4a catch-up" });
  const backRes = await run.waitTracker(back, 180_000);
  const seenBackRes = await run.waitTracker(seenBack, 60_000);
  run.assert("s4a.loss-noticed", `the others count the ${victims.length} killed members as gone within 90 s`, loss.missing.length === 0, { perClient: loss.perClient });
  run.assert("s4a.restart-online", "restarted clients see all members again within 180 s of starting", backRes.missing.length === 0, { perClient: backRes.perClient });
  run.assert("s4a.others-see-them", "the others see the restarted clients again", seenBackRes.missing.length === 0, { perClient: seenBackRes.perClient });
  run.assert("s4a.catch-up", "restarted clients get every message posted while they were down (180 s)", caught.allMs !== null && wanted.length > 0, {
    wanted: wanted.length, perClient: caught.perClient, missing: caught.missing,
  });
  return { victims: victims.map((c) => short(c.name)), lossMs: loss.perClient, backMs: backRes.perClient, catchUpMs: caught.perClient, wanted: wanted.length };
}

async function partB(ctx, serverId, invite) {
  const { run } = ctx;
  const usable = ctx.clients.filter((c) => !c.down);
  if (usable.length < 5) {
    run.assert("s4b.clients", "at least 5 reachable clients", false, { have: usable.length });
    return {};
  }
  const [, , x, y1, y2, ...rest] = usable;
  const online = usable.filter((c) => c !== y1 && c !== y2 && c !== x);
  const pre = await messageRound(ctx, serverId, [x], usable, { perClient: 3, label: "s4b-pre", timeoutMs: 60_000 });
  run.assert("s4b.pre", `${short(x.name)}'s messages reach everyone before the rejoin`, pre.undelivered.length === 0, { undelivered: pre.undelivered });
  const xUser = (await attempt(() => d.ledgerInfo(x, serverId))).value?.me ?? null;

  await cut(ctx, y1);
  await cut(ctx, y2);
  const left = await attempt(() => d.leaveServer(x, serverId));
  await sleep(3000);
  const joinedAt = Date.now();
  const rejoin = await attempt(() => d.joinServer(x, invite));
  const dataT = run.track("s4b: rejoined client has the data", [x.name], (s) => s.servers[serverId]?.hasData && (s.servers[serverId]?.online ?? 0) >= 1, { startedAt: joinedAt });
  const data = await run.waitTracker(dataT, 120_000);
  run.assert("s4b.rejoin", `${short(x.name)} leaves and joins again with the same invite, and gets the data back (120 s)`, left.ok && rejoin.ok && data.missing.length === 0, {
    leaveError: left.error, joinError: rejoin.error, dataMs: data.perClient[x.name],
  });
  // Its old commits come back from the members; let them arrive before it writes.
  await sleep(10_000);
  const xBefore = await attempt(() => d.ledgerInfo(x, serverId));

  const post = await messageRound(ctx, serverId, [x], online, { perClient: 3, label: "s4b-post", timeoutMs: 60_000 });
  run.assert("s4b.post-live", `members online during the rejoin get ${short(x.name)}'s new messages`, post.undelivered.length === 0 && post.posted > 0, {
    undelivered: post.undelivered, failedPosts: post.failedPosts,
  });
  const postTags = Object.values(post.perReceiver).length ? await tagsOf(x, serverId, "|s4b-post|") : [];

  const healedAt = Date.now();
  await healAll(ctx, [y1, y2]);
  const caught = await waitTags(ctx, serverId, [y1, y2], () => postTags, { timeoutMs: 180_000, since: healedAt, label: "s4b catch-up" });
  run.assert("s4b.post-catchup", `members that were offline get ${short(x.name)}'s post-rejoin messages within 180 s of coming back`, caught.allMs !== null && postTags.length > 0, {
    wanted: postTags.length, perClient: caught.perClient, missing: caught.missing,
  });

  // Evidence: (replica, seq) pairs signed twice with different content, the vectors, duplicate profile rows.
  const xInfo = await attempt(() => d.ledgerInfo(x, serverId));
  const yInfo = await attempt(() => d.ledgerInfo(y1, serverId));
  const collisions = xInfo.value?.collisions ?? [];
  run.assert("s4b.no-seq-reuse", `${short(x.name)} never signs two different commits with the same replica and seq`, collisions.length === 0, {
    collisions: collisions.slice(0, 5), xVector: xInfo.value?.vector, y1Vector: yInfo.value?.vector,
  });
  const profiles = await attempt(() => d.members(online[0] ?? y1, serverId));
  const rows = profiles.ok ? profiles.value.rows.filter((r) => Number(r.user_id) === Number(xUser)) : [];
  run.assert("s4b.single-profile", `${short(x.name)} has one members_profiles row after the rejoin`, rows.length === 1, { rows: rows.length });
  const conv = await convergence(ctx, serverId, usable, "s4b");
  run.assert("s4b.converged", "after the rejoin every client has the same commits", conv.sameCommits, { commitGroups: conv.commitGroups, counts: conv.commitCounts });
  return {
    x: short(x.name), offline: [short(y1.name), short(y2.name)], rejoinDataMs: data.perClient[x.name], postLatency: post.latency,
    catchUpMs: caught.perClient, missing: caught.missing, collisions: collisions.length, xVectorBeforePost: xBefore.value?.vector, xVector: xInfo.value?.vector, yVector: yInfo.value?.vector, profileRows: rows.length,
    others: rest.length,
  };
}

async function partC(ctx, serverId, partitionMs) {
  const { run } = ctx;
  const usable = ctx.clients.filter((c) => !c.down);
  const n = usable.length;
  const offline = usable.filter((_, i) => i % 2 === 1);
  const online = usable.filter((_, i) => i % 2 === 0);
  const prefix = `mwt|${run.runId.slice(-6)}|s4c-offline|`;
  // Offline posts are scheduled in the page before the cut (first one 20 s later, after every cut is done), so
  // they happen while the client is unreachable.
  const offlineTags = [];
  for (const c of offline) {
    const channelId = await channelOf(c, serverId);
    const tags = [0, 1, 2].map((k) => `${prefix}${short(c.name)}|${k}`);
    offlineTags.push(...tags);
    await attempt(() => d.schedulePosts(c, serverId, channelId, tags, [20_000, 30_000, 40_000]));
  }
  for (const c of offline) await cut(ctx, c);
  const cutDoneAt = Date.now();
  const onlineRound = await messageRound(ctx, serverId, online, online, { perClient: 3, label: "s4c-online", timeoutMs: 60_000 });
  await sleep(Math.max(0, cutDoneAt + Math.max(partitionMs, 45_000) - Date.now()));

  const healedAt = Date.now();
  await healAll(ctx, offline);
  const visible = run.track("s4c: everyone sees everyone after the heal", usable.map((c) => c.name), (s) => (s.servers[serverId]?.online ?? 0) >= n - 1, { startedAt: healedAt });
  const onlineTags = await tagsOf(online[0], serverId, "|s4c-online|");
  const scheduled = (await Promise.all(offline.map((c) => attempt(() => d.scheduledPosts(c))))).flatMap((r) => (r.ok ? r.value : []));
  const writtenOffline = scheduled.filter((p) => p.ok).map((p) => p.tag);
  const merged = await waitTags(ctx, serverId, usable, () => [...onlineTags, ...writtenOffline], { timeoutMs: 240_000, since: healedAt, label: "s4c merge" });
  const vis = await run.waitTracker(visible, 60_000);
  run.assert("s4c.offline-writes", "offline clients could write while cut off", writtenOffline.length === offlineTags.length, { written: writtenOffline.length, scheduled: offlineTags.length, errors: scheduled.filter((p) => !p.ok).slice(0, 3) });
  run.assert("s4c.visible", "after the heal everyone sees everyone again", vis.missing.length === 0, { perClient: vis.perClient });
  run.assert("s4c.merged", "after the heal every client has both halves' messages within 240 s", merged.allMs !== null, { perClient: merged.perClient, missing: merged.missing });
  return {
    offline: offline.map((c) => short(c.name)), partitionMs, onlineLatency: onlineRound.latency, visibleMs: vis.perClient, mergeMs: merged.perClient,
    mergeStats: merged.stats, missing: merged.missing,
  };
}

async function tagsOf(client, serverId, marker) {
  const channelId = await channelOf(client, serverId);
  const r = await attempt(() => d.messageTags(client, serverId, channelId));
  return r.ok ? r.value.tags.filter((t) => t.includes(marker)) : [];
}
