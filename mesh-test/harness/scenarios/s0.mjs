// S0 smoke, driven through the UI where it can be: register (Auth), create (AddServer), the invite menu (right
// click), join with the code, the "(n online)" tooltip, and messages typed in #general seen by the other side.
// Then the same over the API path, so both ways of driving the app are known to work before the scale runs.
import * as d from "../lib/driver.mjs";
import { attempt, intArg, sleep } from "../lib/util.mjs";
import { collect, convergence, messageRound, prepare, short, usernameOf } from "./common.mjs";

export default async function s0(ctx) {
  const { run, args } = ctx;
  const k = Math.min(intArg(args, "clients-used", 3), ctx.clients.length);
  const used = ctx.clients.slice(0, k);
  if (used.length < 2) {
    run.assert("s0.clients", "at least 2 clients", false, { have: used.length });
    return {};
  }
  ctx.clients = used;
  run.clients = used;
  const [a, b, c] = used;
  const serverName = `smoke-${run.runId.slice(-6)}`;

  // Register through the form where the client has no account yet.
  for (const client of used) {
    const fresh = await client.page.getByRole("heading", { name: "Create an account" }).isVisible({ timeout: 15_000 }).catch(() => false);
    const r = fresh ? await attempt(() => d.uiRegister(client, usernameOf(client))) : { ok: true, value: "existing" };
    run.assert(`s0.ui.register.${short(client.name)}`, `${short(client.name)} registers through the form`, r.ok, { fresh, error: r.error });
  }
  await prepare(ctx);

  const created = await attempt(() => d.uiCreateServer(a, serverName));
  run.assert("s0.ui.create", "server created from the + popover", created.ok, { error: created.error });
  const ids = await d.openServers(a);
  const serverId = ids[ids.length - 1];
  run.watch(serverId);
  const code = serverId ? await d.invite(a, serverId) : null;
  const menu = await attempt(() => d.uiInviteMenu(a, serverName));
  run.assert("s0.ui.invite-menu", "right-click shows 'Copy invite code' and it can be clicked", menu.ok, { error: menu.error });
  run.assert("s0.invite", "invite code available (mw2.<id>.<secret>)", Boolean(code?.startsWith("mw2.")), { code: code ? `${code.slice(0, 12)}…` : null });
  if (!code) return {};

  const joiners = used.slice(1);
  const joinedAt = Date.now();
  for (const j of joiners) {
    const r = await attempt(() => d.uiJoin(j, code));
    run.assert(`s0.ui.join.${short(j.name)}`, `${short(j.name)} joins with the code in the popover`, r.ok, { error: r.error });
  }
  const data = await run.waitTracker(run.track("smoke: joiners have server data", joiners.map((j) => j.name), (s) => s.servers[serverId]?.hasData, { startedAt: joinedAt }), 120_000);
  run.assert("s0.join.data", "joiners receive the server data within 120 s", data.missing.length === 0, { perClient: data.perClient });
  if (data.missing.length === joiners.length) {
    // Nobody got anything: the members never connected. The remaining steps can only time out.
    run.assert("s0.connected", "joiners connected to the server's members (later steps skipped)", false, { missing: data.missing });
    return { clients: await collect(ctx, [serverId]) };
  }

  // What the user sees: the server button's tooltip "<name> (n online)".
  const want = used.length - 1;
  const titles = {};
  const deadline = Date.now() + 120_000;
  const isOnline = (t) => Boolean(t?.includes(`(${want} online)`));
  while (Date.now() < deadline) {
    for (const client of used) if (!isOnline(titles[client.name])) titles[client.name] = await d.uiServerTitle(client, serverName).catch(() => null);
    if (used.every((client) => isOnline(titles[client.name]))) break;
    await sleep(1000);
  }
  const allOnline = used.every((client) => isOnline(titles[client.name]));
  run.assert("s0.ui.online", `every server button says '(${want} online)' within 120 s`, allOnline, { titles });

  // Typed messages, both ways.
  const fromB = `hello from ${short(b.name)} ${run.runId.slice(-6)}`;
  const fromA = `reply from ${short(a.name)} ${run.runId.slice(-6)}`;
  const steps = [
    ["s0.ui.open-a", () => d.uiOpenChannel(a, serverName, "general")],
    ["s0.ui.open-b", () => d.uiOpenChannel(b, serverName, "general")],
    ["s0.ui.post-b", () => d.uiPost(b, fromB)],
  ];
  for (const [id, fn] of steps) {
    const r = await attempt(fn);
    run.assert(id, id.replace("s0.ui.", "UI step: "), r.ok, { error: r.error });
  }
  const seenA = await attempt(() => d.uiSees(a, fromB, 60_000));
  run.assert("s0.ui.message-b-to-a", `${short(a.name)} sees the message typed on ${short(b.name)} within 60 s`, seenA.ok, { ms: seenA.value, error: seenA.error });
  const postA = await attempt(() => d.uiPost(a, fromA));
  const seenB = postA.ok ? await attempt(() => d.uiSees(b, fromA, 60_000)) : postA;
  run.assert("s0.ui.message-a-to-b", `${short(b.name)} sees the reply typed on ${short(a.name)} within 60 s`, seenB.ok, { ms: seenB.value, error: seenB.error });

  // API path on the same server.
  const round = await messageRound(ctx, serverId, used, used, { perClient: 2, label: "smoke-api", timeoutMs: 60_000 });
  run.assert("s0.api.messages", "API-posted messages reach every other client within 60 s", round.undelivered.length === 0 && round.failedPosts.length === 0, {
    undelivered: round.undelivered, failedPosts: round.failedPosts, latency: round.latency,
  });
  const conv = await convergence(ctx, serverId, used);
  run.assert("s0.converged", "all clients end with the same commits and messages", conv.sameCommits && conv.sameMessages, {
    commitCounts: conv.commitCounts, commitGroups: conv.commitGroups, messageGroups: conv.messageGroups,
  });
  run.number("smoke", { serverId, joinData: data.perClient, titles, round: { latency: round.latency, allArrivedMs: round.allArrivedMs }, uiMessageMs: { bToA: seenA.value ?? null, aToB: seenB.value ?? null } });
  void c;
  return { clients: await collect(ctx, [serverId]) };
}
