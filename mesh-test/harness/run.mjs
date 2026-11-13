#!/usr/bin/env node
// Mesh integration test runner: node run.mjs <scenario> [options]
//
//   Scenarios: s0 (smoke, UI-driven), s1 (scale/visibility), s2 (invite chain + multiple servers), s3 (messaging
//   convergence), s4 (churn: restart, leave+rejoin, partition), s5 (mesh relay fallback), s6 (TURN fallback),
//   s7 (public relays), s8 (nodes under a swarm), s9 (larger networks), s10 (calls), s11 (calls at scale),
//   s12 (joining a big workspace), s13 (call presence), s14 (call load), s15 (channel switch), s16 (call hold),
//   s17 (online drift),
//   nodetest (the real nodes on the LAN, node-test.sh).
//   `node run.mjs list` prints each one's options.
//
//   Common options:
//     --topology <file>     topology.json (default /run-info/topology.json, or $MWT_TOPOLOGY)
//     --clients <urls>      instead of a topology: comma-separated CDP URLs (host testing)
//     --out <dir>           results root (default /results, or $MWT_RESULTS)
//     --timeout-min <n>     global timeout for the scenario (default 30)
//     --keep-servers        don't leave servers from earlier runs first
//     --no-reload           don't reload the client pages first (keeps earlier instrumentation counters)
//     --poll-ms <n>         poller interval (default 500)
//
// Writes <out>/<RUN_ID>/{metrics.json, summary.md, timeline.jsonl, harness.log, console/*.log, podman-stats.csv}.
// Exit code: 0 all assertions passed, 1 some failed, 2 the harness itself failed.
import fs from "node:fs";
import path from "node:path";
import { Client, connectAll } from "./lib/cdp.mjs";
import { Run } from "./lib/metrics.mjs";
import { Podman } from "./lib/podman.mjs";
import { intArg, log, pad2, parseArgs, withTimeout } from "./lib/util.mjs";

const scenarios = {
  s0: { file: "s0.mjs", about: "Smoke, UI-driven (2-3 clients): register, create, invite menu, join, online indicator, messages both ways", options: "--clients-used <2|3>" },
  s1: { file: "s1.mjs", about: "Scale/visibility on one LAN with all N clients", options: "--join burst|sequential  --messages <per client, 1>  --hold-s <stability window, 30>" },
  s2: { file: "s2.mjs", about: "Invite chain (codes from non-owners) + 4 overlapping servers + leave one of two shared servers", options: "--messages <per client per server, 2>" },
  s3: { file: "s3.mjs", about: "Messaging convergence: paced then burst, latency, amplification, duplicate accepts, replays", options: "--messages <per client per phase, 10>  --gap-ms <paced gap, 2000>" },
  s4: { file: "s4.mjs", about: "Churn: (a) kill+restart, (b) leave+rejoin with peers offline, (c) half offline then heal", options: "--parts a,b,c  --victims <a: how many, 3>  --partition-s <c: seconds, 60>" },
  s5: { file: "s5.mjs", about: "Mesh relay fallback across LANs (split-bridge / split-chain topologies)", options: "--messages <per client, 1>" },
  s6: { file: "s6.mjs", about: "TURN fallback between LANs with no bridge (split-turn topology)", options: "--messages <per client, 1>" },
  s7: { file: "s7.mjs", about: "Public Nostr relays: S1-burst + light messaging, relay NOTICE/rate-limit frames", options: "--messages <per client, 3>" },
  s8: {
    file: "s8.mjs", about: "Nodes under a swarm (up.sh --nodes 2 --bots B): burst join with the owner online, then offline, then a node restart",
    options: "--history <messages, 3000>  --files <6>  --file-mb <4>  --messages <per member, 3>  --no-restart",
  },
  s9: {
    file: "s9.mjs", about: "Larger networks (up.sh --nodes 3 --bots B --heal-after 1): hub connections, nodes splitting files, healing, fallback, call",
    options: "--history <1000>  --files <8>  --file-mb <2>  --copies <2>  --messages <2>  --fallback-max <40>",
  },
  s10: {
    file: "s10.mjs", about: "Calls (up.sh 6 single --nodes 2): mesh, screen share and its viewer cap, a call through a node, losing it, below the threshold, capacity, rejoin",
    options: "--join-s <seconds to switch to the node, 60>  --join-gap-ms <join the call one by one, this far apart; 0 = all at once>",
  },
  s11: {
    file: "s11.mjs", about: "Calls at scale (up.sh 12 single --nodes 4 [--bots 30]): one call spread over every node and bridged, cameras and a share across them, churn with bots chatting, the busiest node killed and back",
    options: "--members <call members, all clients>  --capacity <per node, members/nodes>  --rounds <churn rounds, 3>  --hear-s <wait for everyone to hear everyone, 120>",
  },
  s12: {
    file: "s12.mjs", about: "Joining a big workspace (BASE_FOLDER=<workspace folder> run-scenario.sh s12): a replica of a real workspace's history in the owner's app, every other app (and bot) joins at once; name and channels on screen within --within-s",
    options: "--history snapshot|full (snapshot)  --within-s <bare minimum on screen, 5>  --complete-s <everything, 300>",
  },
  s13: {
    file: "s13.mjs", about: "Call presence (up.sh 8 single --nodes 2): every call member lists every other, through bursts, staggered joins, churn, a reload, a room secret rotation, a newcomer and a double join",
    options: "--phases burst,stagger,churn,rotate,newcomer,double  --watch-s <90>  --gap-s <3>  --rounds <3>  --within-s <5>  --sfu-calls on|off",
  },
  s14: {
    file: "s14.mjs", about: "Call load (up.sh 8 single --nodes 2): what a voice call costs each member by size and path (idle, mesh 3/5/8, silent, through a node): network, streams, main thread, frames, DOM changes, CPU",
    options: "--measure-s <20>  --settle-s <15>  --mic speech|beep  --phases idle,mesh3,mesh5,mesh8,silent8,node8 (add ui: the indicators styled otherwise)",
  },
  s15: {
    file: "s15.mjs", about: "Channel switch (up.sh 1 single): opening big channels of every type and switching workspaces, with a Chrome trace of each: frames during the slide, time to content, long tasks",
    options: "--repeat <3>  --chat <100,1000,3000>  --files <2000>  --tasks <500>  --cells <6000>  --doc-lines <2000>",
  },
  s16: {
    file: "s16.mjs", about: "Call hold (up.sh 3 single [--nodes 1]): a call of 2 and of 3 held for minutes; every second who hears whom, and what came before each drop (sync hellos, rooms, route lists, connections); --phases cut: a member's networks cut mid-call and back",
    options: "--phases pair,trio,cut  --hold-s <120>  --silence-s <4>  --heard-db <-60>  --mic speech|beep  --sfu-calls on|off  --cut-at-s <30>  --cut-s <10>  --recover-s <30>  --slow-proof-ms <1500>  (HARNESS_ENV=\"MWT_EXPERIMENTS=norecheck|noroutes\")",
  },
  s17: {
    file: "s17.mjs", about: "Online drift (up.sh 2 single, or two dev apps with --clients): does the first app get busier the longer the second stays online? Alone, online for minutes (--call: in a call), alone again; main thread, frames and a census of everything that can pile up per window, CPU profiles of the first and last online window",
    options: "--window-s <30>  --alone-s <120>  --online-min <15>  --left-s <120>  --call  --no-profile  (use --poll-ms 5000)",
  },
  nodetest: {
    file: "nodetest.mjs", about: "Node test (node-test.sh; up.sh 8 lan --bots 20): the real nodes on the LAN in a real workspace under joins, messages and calls, the local node stopped and started again",
    options: "env MWT_INVITE, MWT_AGENT_URL, MWT_AGENT_TOKEN, MWT_REMOTE_IP  --per-client <3>  --down-min <3>  --join-timeout-s <240>",
  },
};

async function main() {
  let argv = process.argv.slice(2);
  // `podman run mwt-harness node /harness/run.mjs s1` with this file as ENTRYPOINT passes the command again.
  if (argv[0] === "node") argv = argv.slice(1);
  if (argv[0]?.endsWith("run.mjs")) argv = argv.slice(1);
  const args = parseArgs(argv);
  const name = args._[0];
  if (!name || name === "list" || name === "help" || args.help) {
    console.log("Usage: node run.mjs <scenario> [options]\n");
    for (const [id, s] of Object.entries(scenarios)) console.log(`  ${id}  ${s.about}\n      ${s.options}`);
    return 0;
  }
  const scenario = scenarios[name];
  if (!scenario) {
    console.error(`Unknown scenario '${name}'. Try: node run.mjs list`);
    return 2;
  }

  const topology = loadTopology(args);
  const clients = topology.clients.map((c) => new Client(c));
  const podman = new Podman(args.podman ?? process.env.PODMAN_SOCK);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const runId = process.env.RUN_ID || `${name}-${topology.topology}-n${clients.length}-${stamp}`;
  const outDir = args.out ?? process.env.MWT_RESULTS ?? "/results";
  const run = new Run({ runId, outDir, scenario: name, args, topology, clients, podman });
  log(`run ${runId}: scenario ${name}, topology ${topology.topology}, ${clients.length} clients, podman socket ${podman.available ? "available" : "missing"}`);
  fs.writeFileSync(path.join(run.dir, "topology.json"), JSON.stringify(topology, null, 2));

  const ctx = { run, clients, topology, podman, args, byName: Object.fromEntries(clients.map((c) => [c.name, c])) };
  const timeoutMs = intArg(args, "timeout-min", 30) * 60_000;
  run.pollMs = intArg(args, "poll-ms", 500);
  let extra = {};
  try {
    const connected = await connectAll(clients, { timeoutMs: 180_000, reload: args["no-reload"] ? true : "always" });
    const failed = connected.filter((c) => !c.ok);
    run.assert("setup.cdp", "every client answers over CDP with the app loaded", failed.length === 0, { failed });
    ctx.clients = clients.filter((c) => c.connected);
    run.clients = ctx.clients;
    if (ctx.clients.length === 0) throw new Error("no client connected");
    const notPatched = [];
    for (const c of ctx.clients) {
      const p = await c.eval(() => ({ early: window.__mwt?.early, patched: window.__mwt?.patched, info: window.__mwt?.patchInfo }), undefined, 10_000).catch((e) => ({ error: e.message }));
      if (!p.patched || !p.early) notPatched.push({ name: c.name, ...p });
    }
    run.assert("setup.instrumentation", "instrumentation installed before the app loaded and app modules patched on every client", notPatched.length === 0, { notPatched });
    run.startPoller();
    const mod = await import(`./scenarios/${scenario.file}`);
    extra = (await withTimeout(mod.default(ctx), timeoutMs, `scenario ${name}`)) ?? {};
  } catch (e) {
    log(`scenario error: ${e.stack ?? e}`);
    run.assert("harness", "scenario ran to the end without a harness error or timeout", false, { error: String(e.message ?? e) });
  }
  const metrics = await run.finish(extra);
  await Promise.all(clients.map((c) => withTimeout(c.close(), 10_000, "close").catch(() => {})));
  return metrics.verdict === "PASS" ? 0 : 1;
}

function loadTopology(args) {
  if (args.clients) {
    const urls = String(args.clients).split(",").filter(Boolean);
    return {
      topology: "local", n: urls.length, lans: ["host"], createdAt: null,
      clients: urls.map((u, i) => ({ name: `local${pad2(i + 1)}`, cdp: u, lans: ["host"], ips: { host: new URL(u).hostname } })),
    };
  }
  const file = args.topology ?? process.env.MWT_TOPOLOGY ?? "/run-info/topology.json";
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const c of t.clients) {
    if (!c.cdp) {
      const ip = c.ips?.[c.lans?.[0]] ?? Object.values(c.ips ?? {})[0];
      c.cdp = `http://${ip}:9223`;
    }
  }
  return t;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e?.stack ?? e);
    process.exit(2);
  },
);
