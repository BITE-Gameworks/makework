// S7 the real public Nostr relays (topology "public"): the S1 burst join plus light messaging, with every
// relay's NOTICE / CLOSED / OK-false frames kept. Many clients behind one IP may hit per-IP rate limits;
// Trystero then backs off a relay for 60 s doubling to 15 min, which would look like members not finding each
// other. TURN still points at the local stub (never production).
import { intArg } from "../lib/util.mjs";
import { aggregate, collect, convergence, meshSnapshot, messageRound, prepare, setupServer, short } from "./common.mjs";
import { appLogTimes, hold } from "./s1.mjs";

export default async function s7(ctx) {
  const { run, args } = ctx;
  const perClient = intArg(args, "messages", 3);
  await prepare(ctx);
  const [owner, ...joiners] = ctx.clients;
  const n = ctx.clients.length;
  const setup = await setupServer(ctx, owner, joiners, { mode: "burst", label: "s7", dataTimeoutMs: 300_000, visibleTimeoutMs: 420_000 });
  if (!setup) return {};
  const { serverId } = setup;
  run.assert("s7.data", "every joiner gets the server data over the public relays (300 s)", setup.data.missing.length === 0, { missing: setup.data.missing, stats: setup.data.stats });
  run.assert("s7.visible", `every client sees the other ${n - 1} online (420 s)`, setup.visible.missing.length === 0, { missing: setup.visible.missing, stats: setup.visible.stats });
  const drops = await hold(ctx, serverId, n - 1, 30_000);
  run.assert("s7.stable", "online counts hold for 30 s", Object.keys(drops).length === 0, { drops });
  const mesh = await meshSnapshot(ctx, serverId, ctx.clients);
  run.section("Visibility matrix (D direct, R relayed, F failed, . not seen)", mesh.matrix.markdown);

  const round = await messageRound(ctx, serverId, ctx.clients, ctx.clients, { perClient, gapMs: 1000, label: "s7-msg", timeoutMs: 180_000, staggerMs: 100 });
  run.assert("s7.messages", "messages reach every other client (180 s)", round.undelivered.length === 0 && round.failedPosts.length === 0, { undelivered: round.undelivered, latency: round.latency });
  const conv = await convergence(ctx, serverId, ctx.clients);
  run.assert("s7.converged", "every client has the same commits", conv.sameCommits, { commitGroups: conv.commitGroups });

  const dumps = await collect(ctx, [serverId]);
  const relays = {};
  for (const [name, dump] of Object.entries(dumps)) {
    for (const [url, r] of Object.entries(dump?.ws ?? {})) {
      if (!url.startsWith("wss://")) continue;
      const e = (relays[url] ??= { clients: 0, opens: 0, errors: 0, closes: 0, eventsOut: 0, eventsIn: 0, okFalse: 0, rateLimited: 0, notices: [] });
      e.clients++;
      e.opens += r.opens;
      e.errors += r.errors;
      e.closes += r.closes;
      e.eventsOut += r.eventsOut;
      e.eventsIn += r.eventsIn;
      e.okFalse += r.okFalse;
      e.rateLimited += r.rateLimited;
      for (const notice of dump.wsNotices?.[url] ?? []) if (e.notices.length < 10) e.notices.push({ client: short(name), ...notice });
    }
  }
  const limited = Object.entries(relays).filter(([, r]) => r.rateLimited > 0).map(([url, r]) => ({ url, rateLimited: r.rateLimited }));
  run.assert("s7.no-rate-limits", "no relay answered with a rate-limit notice", limited.length === 0, { limited });
  run.number("relays", relays);
  run.number("join", { dataMs: setup.data.stats, visibleMs: setup.visible.stats, appLog: appLogTimes(ctx, serverId), perClientVisible: setup.visible.perClient });
  run.number("messages", { latency: round.latency, allArrivedMs: round.allArrivedMs });
  run.number("traffic", aggregate(dumps, serverId));
  return { serverId, clients: dumps };
}
