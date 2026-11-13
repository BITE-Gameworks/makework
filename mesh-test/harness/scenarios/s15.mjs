// S15 channel switch (up.sh 1 single): how smooth opening a channel is when it holds a lot of data. Opening a channel
// slides the old view out and the new one in (shell/MainView.tsx, ui/transitions.ts); the user saw the slide stutter
// and the frame rate drop in big channels of every type, and when switching workspaces. One client seeds a workspace
// with big channels (chat with --chat messages each, a files folder of --files entries, a board of --tasks tasks, a
// doc of --doc-lines lines, a sheet of --cells cells) and a small second workspace, then opens each from a small chat
// --repeat times, with a Chrome trace of every switch:
//   slide    from the click until the new view's slide-in ended: frames the page wanted, dropped, presented without
//            the page's update (partial), the longest gap between presented frames, whether a compositor animation
//            ran, and when the slide-in started
//   content  until the channel shows its content (no skeleton left) and it was drawn: the time, the main thread's
//            tasks over 50 ms and the longest, and what they spent their time on
// Then history: the biggest chat scrolled up to its first message, near the top each time, so older messages are
// added above what the reader sees: it must stay where it is (scroll anchoring), however many get added.
// Then return: leaving a chat that is still filling (kept views keep it mounted, hidden, shell/MainView.tsx) and
// coming back must keep the reader's place (messaging/scrollPlace.ts holds it while hidden).
// Options: --repeat 3  --chat 100,1000,3000  --files 2000  --tasks 500  --cells 6000  --doc-lines 2000
import * as d from "../lib/driver.mjs";
import { attempt, intArg, log, sleep, stats } from "../lib/util.mjs";
import { mdTable, prepare } from "./common.mjs";

const categories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.animations", "toplevel"];
// Main-thread work inside long tasks, by kind.
const workKinds = { script: ["FunctionCall", "EvaluateScript", "TimerFire", "FireAnimationFrame", "RunMicrotasks"], style: ["UpdateLayoutTree"], layout: ["Layout"], paint: ["PrePaint", "Paint", "Layerize"] };

export default async function s15(ctx) {
  const { run, args } = ctx;
  const out = { switches: {} };
  const [client] = ctx.clients;
  if (!client) {
    run.assert("s15.setup", "one Electron client (up.sh 1 single)", false, {});
    return out;
  }
  const repeat = intArg(args, "repeat", 3);
  const sizes = {
    chat: String(typeof args.chat === "string" ? args.chat : "100,1000,3000").split(",").map(Number),
    files: intArg(args, "files", 2000), tasks: intArg(args, "tasks", 500), cells: intArg(args, "cells", 6000), docLines: intArg(args, "doc-lines", 2000),
  };
  try {
    await prepare(ctx);
    const big = await d.createServer(client, "s15 big");
    const small = await d.createServer(client, "s15 small");
    run.assert("s15.workspaces", "the big and the small workspace are made", !!big.id && !!small.id, { big: big.id, small: small.id });
    if (!big.id || !small.id) return out;
    const seeded = await attempt(() => seed(client, big.id, sizes));
    run.assert("s15.seeded", "the big channels are seeded", seeded.ok, { error: seeded.error });
    if (!seeded.ok) return out;
    const ch = seeded.value;
    out.seeded = ch;
    log(`s15: seeded in ${Math.round(ch.ms / 1000)} s (${ch.commits} commits)`);
    const general = await channelNamed(client, big.id, "general");
    const welcome = await channelNamed(client, big.id, "welcome");
    const smallGeneral = await channelNamed(client, small.id, "general");
    const session = await client.page.context().newCDPSession(client.page);
    // Opened once, so switching to the small workspace lands on its chat (a workspace opens at its last channel).
    await attempt(() => openAndWait(client, small.id, smallGeneral, false));

    // [label, from (workspace, channel), to (workspace, channel or null for "the workspace")]
    const plan = [
      ["small chat → small chat", [big.id, general], [big.id, welcome]],
      ...sizes.chat.map((n) => [`→ chat, ${n} messages`, [big.id, general], [big.id, ch.chat[n]]]),
      [`chat ${sizes.chat.at(-1)} → chat ${sizes.chat.at(-2) ?? sizes.chat.at(-1)}`, [big.id, ch.chat[sizes.chat.at(-1)]], [big.id, ch.chat[sizes.chat.at(-2) ?? sizes.chat.at(-1)]]],
      [`→ files, ${sizes.files} in a folder`, [big.id, general], [big.id, ch.files]],
      [`→ tasks, ${sizes.tasks} on the board`, [big.id, general], [big.id, ch.tasks]],
      [`→ doc, ${sizes.docLines} lines`, [big.id, general], [big.id, ch.doc]],
      [`→ sheet, ${sizes.cells} cells`, [big.id, general], [big.id, ch.sheet]],
      [`workspace: big (chat ${sizes.chat.at(-1)}) → small`, [big.id, ch.chat[sizes.chat.at(-1)]], [small.id, null]],
      [`workspace: small → big (chat ${sizes.chat.at(-1)})`, [small.id, smallGeneral], [big.id, null]],
    ];
    for (const [label, from, to] of plan) {
      const rows = [];
      for (let i = 0; i < repeat; i++) {
        const before = await attempt(() => openAndWait(client, from[0], from[1], false));
        if (!before.ok) log(`s15 ${label}: the starting channel didn't open: ${before.error}`);
        await sleep(1500);
        const r = await attempt(() => measureSwitch(ctx, client, session, to));
        if (r.ok) rows.push(r.value);
        else log(`s15 ${label}: ${r.error}`);
      }
      out.switches[label] = rows;
      log(`s15 ${label}: ${summaryLine(rows)}`);
    }
    const history = await attempt(() => readHistory(client, big.id, ch.chat[sizes.chat.at(-1)], sizes.chat.at(-1)));
    out.history = history.ok ? history.value : { error: history.error };
    log(`s15 history: ${JSON.stringify(out.history)}`);
    run.assert("s15.history", "scrolling up a long chat reaches its first message and never moves what the reader sees",
      history.ok && history.value.reachedStart && history.value.worstShiftPx <= 2, out.history);
    // A chat with more than one windowful (messageWindow.ts shows ~120 at once), visited but never scrolled up in
    // the switches above, so returning to it still has older messages to load.
    const returned = await attempt(() => returnKeepsPlace(client, big.id, ch.chat[sizes.chat.at(-2) ?? sizes.chat[0]], general));
    out.returned = returned.ok ? returned.value : { error: returned.error };
    log(`s15 return: ${JSON.stringify(out.returned)}`);
    run.assert("s15.return", "leaving a chat that kept filling in the background and coming back keeps the reader's place",
      returned.ok && returned.value.shiftPx !== null && Math.abs(returned.value.shiftPx) <= 2, out.returned);
    run.assert("s15.measured", "every switch was measured", Object.values(out.switches).every((rows) => rows.length === repeat), {
      short: Object.entries(out.switches).filter(([, rows]) => rows.length < repeat).map(([label]) => label),
    });
  } finally {
    run.number("s15", out);
    run.section("Channel switches (median / worst over the repeats)", switchTable(out.switches));
  }
  return out;
}

async function channelNamed(client, serverId, name) {
  return client.eval(async ({ serverId, name }) => {
    const { workspaceApi } = await import("/src/core/workspaces.ts");
    const rows = await workspaceApi(serverId).plugin("channels").read("channels_channels");
    return rows.find((r) => r.name === name)?.id ?? null;
  }, { serverId, name }, 15_000, "channelNamed");
}

// Seeds the big channels through the plugins' own functions, like members adding things. Returns their ids.
async function seed(client, serverId, sizes) {
  return client.eval(async ({ serverId, sizes }) => {
    const { workspaceApi } = await import("/src/core/workspaces.ts");
    const s = await import("/src/core/serverless.ts");
    const api = workspaceApi(serverId);
    const channels = api.plugin("channels");
    const t0 = Date.now();
    const { id: category } = await channels.call("add-category", { name: "big" });
    const add = async (name, type) => (await channels.call("add-channel", { category_id: category, name, type })).id;
    const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore".split(" ");
    const sentence = (i, n) => Array.from({ length: n }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ");
    // Mixed like a real conversation: plain lines, emphasis, links, lists, code.
    const body = (i) => [
      () => sentence(i, 8 + (i % 20)),
      () => `**${sentence(i, 2)}** ${sentence(i + 1, 12)} _${sentence(i + 2, 3)}_`,
      () => `${sentence(i, 6)} https://example.com/${i} ${sentence(i + 3, 5)}`,
      () => `- ${sentence(i, 4)}\n- ${sentence(i + 1, 5)}\n- ${sentence(i + 2, 3)}`,
      () => `\`\`\`js\nconst x${i} = ${i};\nconsole.log(x${i} * 2);\n\`\`\``,
    ][i % 5]();
    const out = { chat: {} };
    const chat = api.plugin("chat");
    for (const n of sizes.chat) {
      const id = await add(`chat-${n}`, "chat");
      for (let i = 0; i < n; i++) {
        const { id: message } = await chat.call("post-message", { channel_id: id, body: body(i) });
        if (i % 10 === 0) await chat.call("react", { message_id: message, code: "smile" });
        if (i % 50 === 0) await chat.call("post-message", { channel_id: id, body: sentence(i, 6), thread_id: message });
      }
      out.chat[n] = id;
    }
    out.files = await add(`files-${sizes.files}`, "files");
    const files = api.plugin("files");
    const kinds = [["txt", "text/plain"], ["pdf", "application/pdf"], ["png", "image/png"], ["zip", "application/zip"], ["md", "text/markdown"]];
    for (let i = 0; i < sizes.files; i++) {
      const [ext, mime] = kinds[i % kinds.length];
      await files.call("add-file", { channel_id: out.files, name: `file-${String(i).padStart(5, "0")}.${ext}`, mime, size: 1000 + i * 37 });
    }
    out.tasks = await add(`tasks-${sizes.tasks}`, "tasks");
    const tasks = api.plugin("tasks");
    const { columns } = await tasks.call("list-board", { channel_id: out.tasks });
    for (let i = 0; i < sizes.tasks; i++)
      await tasks.call("add-task", { channel_id: out.tasks, title: sentence(i, 3 + (i % 6)), column_id: columns.length ? columns[i % columns.length].id : null });
    out.doc = await add(`doc-${sizes.docLines}`, "docs");
    const lines = Array.from({ length: sizes.docLines }, (_, i) => (i % 40 === 0 ? `## ${sentence(i, 4)}` : i % 7 === 0 ? `- ${sentence(i, 9)}` : sentence(i, 14)));
    await api.plugin("docs").call("add-page", { channel_id: out.doc, title: "Long page", body: lines.join("\n\n") });
    out.sheet = await add(`sheet-${sizes.cells}`, "sheets");
    const sheets = api.plugin("sheets");
    let [sheet] = (await sheets.call("list-sheets", { channel_id: out.sheet })).rows;
    if (!sheet) sheet = { id: (await sheets.call("add-sheet", { channel_id: out.sheet, name: "Sheet 1" })).id };
    const cells = Array.from({ length: sizes.cells }, (_, i) => {
      const row = Math.floor(i / 10);
      const col = i % 10;
      return { row, col, value: col === 9 ? `=SUM(A${row + 1}:I${row + 1})` : String((row * 13 + col * 7) % 1000) };
    });
    for (let i = 0; i < cells.length; i += 500)
      await sheets.call("set-cells", { sheet_id: sheet.id, cells: JSON.stringify(cells.slice(i, i + 500)) });
    await s.workspaceLedger(serverId)?.flush();
    return { ...out, ms: Date.now() - t0, commits: s.workspaceLedger(serverId)?.log().length ?? null };
  }, { serverId, sizes }, 1_800_000, "seed");
}

// Opens a channel (or, with channelId null, the workspace at its last channel, as the workspace bar does) and waits
// until it shows its content: the view shown is the one asked for, its host mounted, no skeleton left. Then waits
// two frames so it was drawn. `mark`: console.timeStamp marks for the trace.
function openAndWait(client, workspaceId, channelId, mark) {
  return client.eval(async ({ workspaceId, channelId, mark }) => {
    const nav = await import("/src/core/navigation.ts");
    // Kept views stay in the page, hidden (shell/MainView.tsx): the shown one is the non-hidden kept wrapper; an
    // in-flow view (messages, the empty state) is a direct child of the main view instead.
    const shownView = () =>
      document.querySelector(".main-view > .kept-view:not(.hidden)") ?? document.querySelector(".main-view > *:not(.kept-view)");
    const hostIn = (view) => (view?.matches(".channel-host") ? view : view?.querySelector(".channel-host")) ?? null;
    const before = shownView();
    // Ready: a view other than the one that was up before the click (the old one stays while it slides out) whose
    // host has left the skeleton and shows content.
    const ready = () => {
      const view = shownView();
      if (!view || view === before) return false;
      const host = hostIn(view);
      return !!host && !host.querySelector(".skeleton-view") && !!host.querySelector(".plugin-mount > *");
    };
    if (mark) console.timeStamp("mwt-click");
    const t0 = performance.now();
    if (channelId === null) nav.openWorkspace(workspaceId);
    else nav.openChannel(workspaceId, channelId);
    // A frame first: the old view is still there until the switch starts.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((resolve) => {
      const tick = () => (ready() || performance.now() - t0 > 20_000 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const contentMs = Math.round(performance.now() - t0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (mark) console.timeStamp("mwt-content");
    const host = hostIn(shownView());
    return { contentMs, timedOut: !ready(), nodes: host ? host.querySelectorAll("*").length : 0 };
  }, { workspaceId, channelId, mark }, 30_000, "openAndWait");
}

// Opens the chat, then until its first message shows: scrolls near the top, notes the message at the view's top and
// where it is, waits for older messages to be added, and measures how far that message moved.
async function readHistory(client, workspaceId, channelId, messages) {
  await openAndWait(client, workspaceId, channelId, false);
  return client.eval(async (messages) => {
    const scroller = document.querySelector(".main-view .kept-view:not(.hidden) .chat-scroll");
    const cards = () => scroller.querySelectorAll("[data-message-id]");
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const t0 = performance.now();
    let worst = 0;
    let rounds = 0;
    const firstId = () => cards()[0]?.dataset.messageId;
    for (; rounds < 400; rounds++) {
      scroller.scrollTop = 100;
      await frame();
      const box = scroller.getBoundingClientRect();
      const seen = document.elementFromPoint(box.left + box.width / 2, box.top + 20)?.closest("[data-message-id]");
      const before = seen?.getBoundingClientRect().top;
      const count = cards().length;
      const oldest = firstId();
      for (let i = 0; i < 30 && cards().length === count; i++) await frame();
      if (cards().length === count) break;
      if (seen && before !== undefined) worst = Math.max(worst, Math.abs(seen.getBoundingClientRect().top - before));
      if (firstId() === oldest) break;
    }
    const shown = cards().length;
    scroller.scrollTop = 0;
    await frame();
    return {
      rounds, shown, worstShiftPx: Math.round(worst), ms: Math.round(performance.now() - t0),
      reachedStart: shown >= messages,
    };
  }, messages, 180_000, "readHistory");
}

// Leaves a chat that is still filling (the kept view keeps loading older messages, hidden) and comes back: the
// reader must find the message they were looking at where they left it.
async function returnKeepsPlace(client, workspaceId, channelId, awayChannelId) {
  await openAndWait(client, workspaceId, channelId, false);
  const before = await client.eval(async () => {
    const scroller = document.querySelector(".main-view .kept-view:not(.hidden) .chat-scroll");
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    scroller.scrollTop = 100; // up into history: the window starts loading older messages
    await frame();
    const box = scroller.getBoundingClientRect();
    const card = document.elementFromPoint(box.left + box.width / 2, box.top + 20)?.closest("[data-message-id]");
    return {
      id: card?.dataset.messageId ?? null,
      top: card ? card.getBoundingClientRect().top - box.top : null,
      cards: scroller.querySelectorAll("[data-message-id]").length,
    };
  }, undefined, 30_000, "returnPlaceBefore");
  await openAndWait(client, workspaceId, awayChannelId, false);
  await sleep(1500); // the hidden view keeps filling meanwhile
  await openAndWait(client, workspaceId, channelId, false);
  const after = await client.eval((id) => {
    const scroller = document.querySelector(".main-view .kept-view:not(.hidden) .chat-scroll");
    const card = id === null ? null : scroller.querySelector(`[data-message-id="${id}"]`);
    const box = scroller.getBoundingClientRect();
    return {
      top: card ? card.getBoundingClientRect().top - box.top : null,
      cards: scroller.querySelectorAll("[data-message-id]").length,
      atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80,
    };
  }, before.id, 30_000, "returnPlaceAfter");
  return {
    id: before.id, beforePx: before.top, afterPx: after.top,
    shiftPx: before.top === null || after.top === null ? null : Math.round(after.top - before.top),
    cardsBefore: before.cards, cardsAfter: after.cards, atBottom: after.atBottom,
  };
}

async function measureSwitch(ctx, client, session, [workspaceId, channelId]) {
  const events = [];
  const collect = (e) => events.push(...e.value);
  session.on("Tracing.dataCollected", collect);
  const done = new Promise((r) => session.once("Tracing.tracingComplete", r));
  await session.send("Tracing.start", { traceConfig: { includedCategories: categories }, transferMode: "ReportEvents" });
  let page;
  try {
    page = await openAndWait(client, workspaceId, channelId, true);
    await sleep(500);
  } finally {
    await session.send("Tracing.end");
    await done;
    session.off("Tracing.dataCollected", collect);
  }
  return { ...page, ...analyze(events) };
}

// One switch's trace: the renderer's main thread is where the marks are.
function analyze(events) {
  const click = events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === "mwt-click");
  const content = events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === "mwt-content");
  if (!click || !content) throw new Error("the trace has no marks");
  const { pid, tid } = click;
  const t0 = click.ts;
  // The slide-in: the new channel host's enter animation (solid-transition-group marks it s-enter), until its end.
  const slideIn = events.find((e) => e.name === "Animation" && e.ph === "b" && e.pid === pid && e.ts >= t0 && /channel-host.*s-enter/.test(e.args?.data?.nodeName ?? ""));
  const slideEnd = slideIn ? events.find((e) => e.name === "Animation" && e.ph === "e" && e.id === slideIn.id && e.pid === pid)?.ts ?? null : null;
  const end = slideEnd ?? content.ts;
  const frames = events.filter((e) => e.name === "PipelineReporter" && e.ph === "b" && e.pid === pid && e.ts >= t0 && e.ts <= end)
    .map((e) => ({ ts: e.ts, state: e.args?.frame_reporter?.state, compositor: !!e.args?.frame_reporter?.has_compositor_animation }));
  const wanted = frames.filter((f) => f.state !== "STATE_NO_UPDATE_DESIRED");
  const presented = frames.filter((f) => f.state === "STATE_PRESENTED_ALL" || f.state === "STATE_PRESENTED_PARTIAL").map((f) => f.ts);
  let gap = 0;
  for (let i = 1, prev = t0; i <= presented.length; i++) {
    const at = i < presented.length ? presented[i] : end;
    gap = Math.max(gap, at - prev);
    prev = at;
  }
  if (presented.length) gap = Math.max(gap, presented[0] - t0);
  const tasks = events.filter((e) => e.name === "RunTask" && e.ph === "X" && e.pid === pid && e.tid === tid && e.ts >= t0 && e.ts <= content.ts + 500_000);
  const long = tasks.filter((e) => e.dur > 50_000);
  // Each long task's time by the outermost kind of work (a layout a script forced counts as script).
  const work = Object.fromEntries(Object.keys(workKinds).map((k) => [k, 0]));
  const kindOf = (name) => Object.entries(workKinds).find(([, names]) => names.includes(name))?.[0];
  const counted = events.filter((e) => e.ph === "X" && e.pid === pid && e.tid === tid && kindOf(e.name)).sort((a, b) => a.ts - b.ts);
  for (const task of long) {
    let until = 0;
    for (const e of counted) {
      if (e.ts < task.ts || e.ts >= task.ts + task.dur || e.ts < until) continue;
      work[kindOf(e.name)] += e.dur / 1000;
      until = e.ts + e.dur;
    }
  }
  return {
    slideStartMs: slideIn ? Math.round((slideIn.ts - t0) / 1000) : null,
    slideMs: slideIn && slideEnd ? Math.round((slideEnd - slideIn.ts) / 1000) : null,
    framesWanted: wanted.length,
    framesDropped: wanted.filter((f) => f.state === "STATE_DROPPED").length,
    framesPartial: wanted.filter((f) => f.state === "STATE_PRESENTED_PARTIAL").length,
    longestGapMs: Math.round(gap / 1000),
    compositorAnimation: frames.some((f) => f.compositor),
    longTasks: long.length,
    longestTaskMs: Math.round(Math.max(0, ...tasks.map((e) => e.dur)) / 1000),
    longTaskWorkMs: Object.fromEntries(Object.entries(work).map(([k, v]) => [k, Math.round(v)])),
  };
}

const medWorst = (rows, key, worst = Math.max) => {
  const values = rows.map((r) => r[key]).filter((v) => typeof v === "number");
  if (!values.length) return "–";
  return `${Math.round(stats(values).p50)} / ${worst(...values)}`;
};

function summaryLine(rows) {
  return ["framesDropped", "longestGapMs", "contentMs", "longestTaskMs"].map((k) => `${k} ${medWorst(rows, k)}`).join(", ");
}

function switchTable(switches) {
  const rows = Object.entries(switches).map(([label, list]) => {
    const work = (kind) => medWorst(list.map((r) => ({ v: r.longTaskWorkMs?.[kind] })), "v");
    return [
      label, medWorst(list, "slideStartMs"), medWorst(list, "framesWanted"), medWorst(list, "framesDropped"), medWorst(list, "framesPartial"),
      medWorst(list, "longestGapMs"), list.some((r) => r.compositorAnimation) ? "yes" : "no", medWorst(list, "contentMs"),
      medWorst(list, "longTasks"), medWorst(list, "longestTaskMs"), work("script"), work("style"), work("layout"), work("paint"), medWorst(list, "nodes"),
    ];
  });
  return mdTable(["switch", "slide starts ms", "frames wanted", "dropped", "partial", "longest gap ms", "compositor animation", "content ms",
    "tasks > 50 ms", "longest task ms", "script ms", "style ms", "layout ms", "paint ms", "DOM nodes"], rows);
}
