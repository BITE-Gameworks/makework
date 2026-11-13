#!/usr/bin/env node
// Builds the "Explore MakeWork" preset's channel archives.
//
// Every file in src/presets/explore/channels/ is one channel in the format core/channelArchive.ts reads: a .zip
// holding channel.json ({ format, version, channel, tables, profiles }) and content/<sha256> for each file the rows
// point at (mwc:<sha256>). tables holds the rows the channel's plugin would keep, with an `id`, a placeholder
// `channel_id: 1` and placeholder references between rows; importing (core/explorePreset.ts) gives the channel and
// its rows fresh ids. Row ids are unique within an archive. profiles names the people the rows point at.
//
// Links between channels are written as makework://explore/<channel>[/<kind>/<row id>]; the import turns them into
// real links. Calendar items are placed in `calendarMonth` and moved to the current month on import.
//
// Run from app/ after changing the content below:
//   node scripts/make-explore-preset.mjs
// Then `npm test` checks the archives against the plugin manifests, or start the app and create the preset.

/* global Buffer, console, process */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "presets", "explore", "channels");
const examples = join(here, "..", "..", "examples", "plugins");

// The guide who left the notes: one fake member, user id 1. The bots' ids match preset.json.
const GUIDE = 1;
const REPLY_BOT = 2;
const ANNOUNCER_BOT = 3;
const guide = {
  user_id: GUIDE, username: "makework", display_name: "MakeWork Guide", color: "#3e63dd", avatar: "gen:makework",
  nickname: "", bio: "I set up this workspace to show you around. Everything here is yours to change.",
};
const botProfile = (user_id, type, nickname) => ({
  user_id, username: `${type}bot`, display_name: nickname, color: "", avatar: "", nickname, bio: "",
  bot: true, bot_type: type, bot_number: 1,
});
const replyProfile = botProfile(REPLY_BOT, "reply", "Echo");
const announcerProfile = botProfile(ANNOUNCER_BOT, "announcer", "Town Crier");

const link = (channel, target = "") => `makework://explore/${channel}${target}`;
const calendarMonth = "2026-10";

// Timestamps count up from a fixed minute so messages, pages and cards keep their order.
let minute = 0;
const at = () => new Date(Date.UTC(2026, 9, 1, 9, minute++)).toISOString().replace(/\.\d{3}Z$/, "Z");

const lines = (...text) => text.join("\n");
const archive = (name, type, tables, files = {}, profiles = [guide]) => ({
  json: { format: "makework-channel", version: 1, exportedAt: new Date().toISOString(), channel: { name, type }, tables, profiles },
  files,
});

// ---------- Pictures ----------
// Small PNGs drawn here so the preset needs no image files: a canvas of RGBA pixels and a minimal encoder.

function canvas(w, h) {
  const px = new Uint8Array(w * h * 4);
  const set = (x, y, [r, g, b], a = 1) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    px[i] = px[i] * (1 - a) + r * a;
    px[i + 1] = px[i + 1] * (1 - a) + g * a;
    px[i + 2] = px[i + 2] * (1 - a) + b * a;
    px[i + 3] = 255;
  };
  const fill = (test, color) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = test(x / w, y / h);
      if (a) set(x, y, typeof color === "function" ? color(x / w, y / h) : color, a === true ? 1 : a);
    }
  };
  return { w, h, px, fill };
}

const hex = (s) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
// Soft edge for a distance in pixels-ish units: 1 inside, fading out over `edge`.
const soft = (d, edge = 0.004) => (d < 0 ? 1 : d < edge ? 1 - d / edge : 0);

function png({ w, h, px }) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}

const brand = { navy: "#1d2b4f", amber: "#f2a541", foam: "#e8f1f2", coral: "#e4572e", teal: "#2a9d8f" };

const pictures = {
  "sea-at-dusk.png": [640, 400, (c) => {
    c.fill(() => true, (_, y) => mix(hex("#f6bd60"), hex("#7b5ea7"), 1 - y / 0.62));
    c.fill((x, y) => soft(Math.hypot((x - 0.68) * 1.6, y - 0.55) - 0.13), hex("#fff1c1"));
    c.fill((_, y) => y > 0.62, (x, y) => mix(hex("#2a6f97"), hex(brand.navy), (y - 0.62) / 0.38 + 0.05 * Math.sin(x * 60 + y * 90)));
    c.fill((x, y) => y > 0.62 && Math.abs(x - 0.68) < 0.12 * (1 - (y - 0.62) * 2) && Math.sin(y * 300) > 0.4, hex("#fff1c1"));
  }],
  "lighthouse.png": [400, 560, (c) => {
    c.fill(() => true, (_, y) => mix(hex("#a8dadc"), hex(brand.foam), y));
    c.fill((x, y) => soft(Math.abs(y - 0.24 - (x - 0.5) * 0.25) - 0.03 * (1 - Math.abs(x - 0.5) * 2)) && x > 0.5, hex("#fff6d5"));
    c.fill((x, y) => y > 0.82 + 0.03 * Math.sin(x * 12), hex("#457b9d"));
    c.fill((x, y) => y > 0.75 && y < 0.86 && Math.abs(x - 0.5) < 0.3 - (0.86 - y), hex("#6c757d"));
    c.fill((x, y) => y > 0.3 && y < 0.78 && Math.abs(x - 0.5) < 0.06 + (y - 0.3) * 0.12,
      (_, y) => (Math.floor((y - 0.3) / 0.08) % 2 === 0 ? hex(brand.coral) : hex("#ffffff")));
    c.fill((x, y) => y > 0.22 && y < 0.3 && Math.abs(x - 0.5) < 0.07, hex(brand.amber));
    c.fill((x, y) => y > 0.17 && y < 0.22 && Math.abs(x - 0.5) < 0.1 - (0.22 - y) * 1.6, hex(brand.navy));
  }],
  "palette.png": [600, 200, (c) => {
    const colors = Object.values(brand).map(hex);
    c.fill(() => true, (x) => colors[Math.min(colors.length - 1, Math.floor(x * colors.length))]);
  }],
  "waves.png": [480, 320, (c) => {
    c.fill(() => true, hex(brand.foam));
    for (let band = 0; band < 6; band++) {
      const color = mix(hex(brand.teal), hex(brand.navy), band / 5);
      c.fill((x, y) => y > 0.2 + band * 0.13 + 0.04 * Math.sin(x * 9 + band), color);
    }
  }],
  "logo.png": [256, 256, (c) => {
    c.fill((x, y) => soft(Math.hypot(x - 0.5, y - 0.5) - 0.46), hex(brand.navy));
    c.fill((x, y) => x > 0.5 && soft(Math.abs(y - 0.42 - (x - 0.5) * 0.35) - 0.05 * (x - 0.5) * 2 - 0.01) && Math.hypot(x - 0.5, y - 0.5) < 0.44, hex("#fff1c1"));
    c.fill((x, y) => y > 0.38 && y < 0.8 && Math.abs(x - 0.5) < 0.05 + (y - 0.38) * 0.15,
      (_, y) => (Math.floor((y - 0.38) / 0.07) % 2 === 0 ? hex(brand.coral) : hex("#ffffff")));
    c.fill((x, y) => y > 0.32 && y < 0.38 && Math.abs(x - 0.5) < 0.06, hex(brand.amber));
  }],
};

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const drawn = new Map();
function picture(name, size) {
  const key = `${name}@${size ?? "full"}`;
  if (!drawn.has(key)) {
    const [w, h, draw] = pictures[name];
    const scale = size ? Math.min(1, size / Math.max(w, h)) : 1;
    const c = canvas(Math.round(w * scale), Math.round(h * scale));
    draw(c);
    drawn.set(key, { bytes: png(c), width: w, height: h });
  }
  return drawn.get(key);
}

// What a row needs to point at a file: its ref, size and, for pictures, the size and a small preview.
function stored(files, bytes) {
  const hash = sha(bytes);
  files[`content/${hash}`] = bytes;
  return { url: `mwc:${hash}`, size: bytes.length };
}
function storedPicture(files, name) {
  const { bytes, width, height } = picture(name);
  const thumb = `data:image/png;base64,${Buffer.from(picture(name, 240).bytes).toString("base64")}`;
  return { ...stored(files, bytes), mime: "image/png", thumb, width, height };
}

// ---------- Row helpers ----------

const message = (id, body, extra = {}) => ({
  id, channel_id: 1, author_id: GUIDE, thread_id: null, kind: "message", body, created_at: at(), edited_at: null, deleted: false, ...extra,
});
const reaction = (id, messageId, code, user = GUIDE) => ({ id, message_id: messageId, user_id: user, code });
const pin = (id, messageId) => ({ id, message_id: messageId, channel_id: 1, pinned_by: GUIDE, created_at: at() });

const page = (id, title, body, extra = {}) => ({
  id, channel_id: 1, parent_id: null, title, body, z: id, author_id: GUIDE, created_at: at(),
  updated_by: GUIDE, updated_at: at(), deleted: false, ...extra,
});

// ---------- Start here ----------

const welcome = () => archive("welcome", "chat", {
  chat_messages: [
    message(1, lines(
      "# Welcome to MakeWork :wave:",
      "",
      "This workspace is a guided tour. Every channel on the left shows one thing MakeWork can do, with a few examples already in it.",
      "",
      "Nothing here is precious: send messages, drag cards, edit pages, delete things. If you want a clean copy later, choose **Add workspace > Explore MakeWork** again.",
      "",
      "MakeWork is an early version and may have some bugs. Found one, or have an idea? Choose **Settings > About > Send feedback**, or email [hello@makework.dev](mailto:hello@makework.dev).",
    )),
    message(2, lines(
      `Not sure where to start? Read the [guide](${link("guide")}) for a two minute overview, or just open the channels from top to bottom:`,
      "",
      "- **Talk**: messages, calls and bots",
      "- **Plan**: a task board, spreadsheets and diagrams",
      "- **Make**: docs, designs, a mood board and shared files",
      "- **Code and web**: a Git repository and a shared browser",
      "- **Workspace**: how roles, invites, plugins and nodes work",
    )),
    message(3, "This is also the workspace's **welcome channel**: when someone joins, MakeWork says so here. Say hello below to try the message box. :point_down:"),
  ],
  chat_pins: [pin(10, 1)],
  chat_reactions: [reaction(20, 1, "wave"), reaction(21, 2, "sparkles")],
});

const guideDocs = () => archive("guide", "docs", {
  docs_pages: [
    page(1, "Welcome to MakeWork", lines(
      "# Welcome to MakeWork",
      "",
      "MakeWork is one place for a team to **talk**, **plan** and **make** things together. A workspace holds channels, and each channel is a tool: a chat, a call, a task board, a spreadsheet, a diagram, a document, a design and more.",
      "",
      "You can use it alone, as a private planner that never leaves your computer, or with the people you invite.",
      "",
      "## Where to go next",
      "",
      "- **A quick tour** lists every example channel in this workspace.",
      "- **How workspaces work** explains where your data lives.",
      "- **Accounts and offline use** covers working with or without an account.",
      "",
      `Pages like this one live in a **docs** channel. Pages nest, and everyone can edit the same page at the same time. The [handbook](${link("handbook")}) shows what a page can hold.`,
    )),
    page(2, "A quick tour", lines(
      "# A quick tour",
      "",
      "Each example channel shows off one built-in plugin. Open any of them; the first message, card or page explains what to try.",
      "",
      "## Talk",
      "",
      `- [general](${link("general")}): formatting, threads, a poll, pins and reactions.`,
      `- [lounge](${link("lounge")}): a voice channel. Click it to join a call with voice, camera and screen sharing.`,
      `- [bot-playground](${link("bot-playground")}): bots that answer in chat.`,
      "",
      "## Plan",
      "",
      `- [roadmap](${link("roadmap")}): a task board with columns, tags, assignees and comments.`,
      `- [budget](${link("budget")}): spreadsheets with formulas, a checklist and a calendar.`,
      `- [flows](${link("flows")}): diagrams with shapes and connectors.`,
      "",
      "## Make",
      "",
      `- [handbook](${link("handbook")}): docs, with live embeds of other channels.`,
      `- [website](${link("website")}): a design canvas with frames, text and colors.`,
      `- [mood-board](${link("mood-board")}): a design canvas used as a mood board, to collect and arrange pictures.`,
      `- [shared-files](${link("shared-files")}): folders and files everyone can open.`,
      "",
      "## Code and web",
      "",
      `- [hello-world](${link("hello-world")}): a Git repository's branches and history.`,
      `- [research](${link("research")}): a browser the whole channel shares (desktop app).`,
      "",
      "## Workspace",
      "",
      `- [workspace-handbook](${link("workspace-handbook")}): roles, invites, plugins, bots and nodes.`,
      "",
      "The examples follow a pretend team launching **Lighthouse**, a small app. None of it is real.",
    ), { parent_id: 1, z: 1 }),
    page(3, "How workspaces work", lines(
      "# How workspaces work",
      "",
      "There is no MakeWork server holding your workspace. **Every member keeps their own copy**, and changes travel directly between members who are online.",
      "",
      "- Each change is **signed** by the person who made it, so nobody can pretend to be someone else.",
      "- Every member checks each change against the workspace's **roles and permissions** before applying it. A change that breaks the rules is refused everywhere.",
      "- When you come back online, you catch up on what you missed from whoever is around.",
      "",
      `The [flows](${link("flows")}) channel has a diagram of this.`,
      "",
      "## When nobody else is online",
      "",
      "A workspace with one member works with no connection at all. For a team that is rarely online at the same time, add a **node**: a computer that stays on, keeps a copy and passes it on. See **Nodes** in the workspace handbook.",
    ), { parent_id: 1, z: 2 }),
    page(4, "Accounts and offline use", lines(
      "# Accounts and offline use",
      "",
      "MakeWork works without an account. Choose **Skip, use MakeWork offline** when signing in, and everything stays on this computer.",
      "",
      "Create an account when you want to work with others. Your workspaces and their history come with you, and then you can:",
      "",
      "- invite people to your workspaces and join theirs,",
      "- send private messages and add friends,",
      "- sign in on another computer.",
      "",
      "You can create one at any time in **Settings > Account**.",
    ), { parent_id: 1, z: 3 }),
  ],
});

// ---------- Talk ----------

const general = () => archive("general", "chat", {
  chat_messages: [
    message(1, "This is a **chat channel**. Here is what a message can do. Hover one for reactions, replies and more, and right-click it for everything else."),
    message(2, lines(
      "Messages use Markdown: **bold**, *italic*, `code`, ~~struck~~ and [links](https://makework.dev).",
      "",
      "- lists",
      "- with items",
      "",
      "> and quotes, for the good bits.",
    )),
    message(3, lines(
      "Code keeps its spacing and gets colors:",
      "",
      "```js",
      "const launch = (date) => `Lighthouse ships on ${date}`;",
      "console.log(launch(\"Friday\"));",
      "```",
    )),
    message(4, "**Threads** keep side conversations out of the way. This message has one: click *2 replies* below to open it."),
    message(5, "Like this. The channel stays tidy while we talk here.", { thread_id: 4 }),
    message(6, "Reply here too, or start a thread on any message.", { thread_id: 4 }),
    message(7, "**Polls** settle things quickly. Which part of MakeWork will you try first?", { kind: "poll" }),
    message(8, `Link to anything in the workspace: the [roadmap](${link("roadmap")}), a [card on it](${link("roadmap", "/task/34")}), or a [diagram](${link("flows")}). Type \`#\` in the message box to search for one.`),
    message(9, "**Pinned** messages are kept in the channel's pin list, so they're easy to find again. This one is pinned."),
    message(10, "Drop files on the message box to share them, and use `:` to find an emoji :tada:"),
  ],
  chat_polls: [{ id: 20, message_id: 7, multiple: false }],
  chat_poll_options: [
    { id: 21, message_id: 7, label: "Task boards", position: 0 },
    { id: 22, message_id: 7, label: "Spreadsheets", position: 1 },
    { id: 23, message_id: 7, label: "Diagrams and designs", position: 2 },
    { id: 24, message_id: 7, label: "Docs", position: 3 },
  ],
  chat_poll_votes: [{ id: 25, option_id: 21, user_id: GUIDE }],
  chat_pins: [pin(30, 9)],
  chat_reactions: [reaction(40, 1, "wave"), reaction(41, 2, "thumbsup"), reaction(42, 3, "fire"), reaction(43, 4, "eyes"), reaction(44, 10, "tada")],
});

// A voice channel keeps no rows: calls are live only.
const lounge = () => archive("lounge", "voice", {});

const botPlayground = () => archive("bot-playground", "chat", {
  chat_messages: [
    message(1, lines(
      "**Bots** are members that a program runs. They post, reply and react like anyone else, and are marked with a bot badge.",
      "",
      "This workspace has two example bots, set up in **Workspace settings > Bots**:",
      "",
      `- <@${REPLY_BOT}> (Reply) answers when you mention it, with your words backwards.`,
      `- <@${ANNOUNCER_BOT}> (Announcer) posts a reminder on a timer. It is turned off; turn it on in Bots.`,
    )),
    message(2, lines(
      "Bot types come from plugins. These two are in the **Bot examples** plugin:",
      "",
      `1. Download \`bots.mwp\` from the [Plugins folder in shared-files](${link("shared-files", "/file/30")}).`,
      "2. Install it in **Settings > Plugins** (Install from file, or drop it there).",
      `3. Come back and mention <@${REPLY_BOT}> with some text.`,
      "",
      "A bot runs on one member's computer at a time; whoever has the app open takes over when that one leaves.",
    )),
    message(3, `<@${REPLY_BOT}> hello there`),
    message(4, "ereht olleh", { author_id: REPLY_BOT }),
    message(5, "Stand-up starts in 10 minutes in the lounge. :coffee:", { author_id: ANNOUNCER_BOT }),
  ],
  chat_reactions: [reaction(10, 4, "joy")],
}, {}, [guide, replyProfile, announcerProfile]);

// ---------- Plan ----------

const task = (id, columnId, title, extra = {}) => {
  const { done, ...rest } = extra;
  return {
    id, channel_id: 1, column_id: columnId, title, notes: "", position: 0, assignee_id: null,
    author_id: GUIDE, created_at: at(), done_at: done ? at() : null, deleted: false, ...rest,
  };
};

const roadmap = () => archive("roadmap", "tasks", {
  tasks_columns: [
    { id: 1, channel_id: 1, name: "Ideas", position: 0, is_done: false, deleted: false },
    { id: 2, channel_id: 1, name: "To do", position: 1, is_done: false, deleted: false },
    { id: 3, channel_id: 1, name: "Doing", position: 2, is_done: false, deleted: false },
    { id: 4, channel_id: 1, name: "Done", position: 3, is_done: true, deleted: false },
  ],
  tasks_tags: [
    { id: 11, channel_id: 1, name: "design", color: "#8e4ec6", deleted: false },
    { id: 12, channel_id: 1, name: "website", color: "#3e63dd", deleted: false },
    { id: 13, channel_id: 1, name: "launch", color: "#e5484d", deleted: false },
    { id: 14, channel_id: 1, name: "tour", color: "#46a758", deleted: false },
  ],
  tasks_tasks: [
    task(31, 1, "Dark mode for the landing page", { notes: "Someone asked for it twice. Worth a look after launch.", position: 0 }),
    task(32, 2, "Try this board", {
      notes: lines(
        "A few things to try:",
        "",
        "- Drag this card to **Doing**, then to **Done**.",
        "- Click a card to open it: notes, tags, people and comments.",
        "- Right-click a card to move it, tag it or assign it.",
        "- Add a card with the **+** at the bottom of a column.",
      ),
      position: 0,
    }),
    task(33, 2, "Write the launch announcement", {
      notes: `Draft it in the [handbook](${link("handbook")}), then post it in [general](${link("general")}).`,
      position: 1,
    }),
    task(34, 3, "Finish the landing page", {
      notes: `The mockups are in [website](${link("website")}) and the pictures in [mood-board](${link("mood-board")}).`,
      position: 0, assignee_id: GUIDE,
    }),
    task(35, 3, "Keep the budget under 5,000", { notes: `See [budget](${link("budget")}).`, position: 1 }),
    task(36, 4, "Pick a name", { notes: "Lighthouse it is.", position: 0, done: true }),
    task(37, 4, "Set up the workspace", { notes: "Done cards remember when they were finished.", position: 1, done: true }),
  ],
  tasks_task_tags: [
    { id: 41, task_id: 31, tag_id: 11 }, { id: 42, task_id: 32, tag_id: 14 }, { id: 43, task_id: 33, tag_id: 13 },
    { id: 44, task_id: 34, tag_id: 12 }, { id: 45, task_id: 34, tag_id: 11 }, { id: 46, task_id: 35, tag_id: 13 },
    { id: 47, task_id: 37, tag_id: 14 },
  ],
  tasks_assignees: [{ id: 51, task_id: 34, user_id: GUIDE }],
  tasks_comments: [
    { id: 61, task_id: 32, author_id: GUIDE, body: "Comments go here. Mention someone with `@` to let them know.", created_at: at(), edited_at: null, deleted: false },
    { id: 62, task_id: 34, author_id: GUIDE, body: "Header and hero are done; the phone layout is next.", created_at: at(), edited_at: null, deleted: false },
  ],
  tasks_reactions: [{ id: 71, task_id: 36, user_id: GUIDE, code: "tada" }, { id: 72, task_id: 32, user_id: GUIDE, code: "thumbsup" }],
});

// Cells by row from A1: strings starting with = are formulas.
function cells(sheetId, firstId, grid, styles = {}) {
  const out = [];
  let id = firstId;
  grid.forEach((cols, row) => cols.forEach((value, col) => {
    if (value === null || value === undefined || value === "") return;
    const style = styles[`${row},${col}`] ?? (row === 0 ? styles.header : styles[`*,${col}`]);
    out.push({ id: id++, sheet_id: sheetId, row, col, value: String(value), style: style ? JSON.stringify(style) : null, author_id: GUIDE, updated_at: at() });
  }));
  return out;
}

const sheet = (id, name, z, extra = {}) => ({
  id, channel_id: 1, name, color: "", z, rows: null, cols: null, mode: "grid", calendar: "{}", locked: false,
  frozen_rows: 0, frozen_cols: 0, col_widths: "{}", row_heights: "{}", ...extra,
});

// Calendar items: [day of calendarMonth, text]; the view keeps itemsPerDay slots per day in column A.
function calendarCells(sheetId, firstId, perDay, items) {
  const [year, month] = calendarMonth.split("-").map(Number);
  const used = new Map();
  return items.map(([dayOfMonth, value], i) => {
    const epochDay = Date.UTC(year, month - 1, dayOfMonth) / 86_400_000;
    const slot = used.get(epochDay) ?? 0;
    used.set(epochDay, slot + 1);
    return { id: firstId + i, sheet_id: sheetId, row: epochDay * perDay + slot, col: 0, value, style: null, author_id: GUIDE, updated_at: at() };
  });
}

const budget = () => {
  const money = { format: "currency", currency: "USD" };
  const header = { bold: true, background: "#e8f1f2" };
  const total = { bold: true, ...money };
  return archive("budget", "sheets", {
    sheets_sheets: [
      sheet(1, "Budget", 1, { frozen_rows: 1, col_widths: JSON.stringify({ 0: 200, 4: 220 }) }),
      sheet(2, "Checklist", 2, { frozen_rows: 1, col_widths: JSON.stringify({ 1: 240 }) }),
      sheet(3, "Launch calendar", 3, { mode: "calendar", calendar: JSON.stringify({ month: calendarMonth, itemsPerDay: 3, firstWeekday: 1 }) }),
    ],
    sheets_cells: [
      ...cells(1, 100, [
        ["Item", "Planned", "Spent", "Left", "Note"],
        ["Domain and hosting", 300, 240, "=B2-C2", "Paid for a year"],
        ["Design", 1500, 1650, "=B3-C3", "Over: red means below zero"],
        ["Photos", 400, 120, "=B4-C4", ""],
        ["Launch party", 800, 0, "=B5-C5", "Snacks matter"],
        ["Ads", 1200, 300, "=B6-C6", ""],
        ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)", "=IF(C7>B7, \"Over budget\", \"On budget\")"],
        ["Share spent", "", "=C7/B7", "", "Click a cell to see its formula"],
      ], {
        header, "*,1": money, "*,2": money, "*,3": money,
        "6,0": { bold: true }, "6,1": total, "6,2": total, "6,3": total, "6,4": { bold: true },
        "7,2": { format: "percent" },
      }),
      ...cells(2, 200, [
        ["Done", "Step", "Owner", "Status"],
        ["TRUE", "Pick a name", "Guide", "Done"],
        ["TRUE", "Set up the workspace", "Guide", "Done"],
        ["FALSE", "Finish the landing page", "Guide", "In progress"],
        ["FALSE", "Write the announcement", "", "Not started"],
        ["FALSE", "Launch", "", "Not started"],
        ["", "Progress", "", "=COUNTIF(D2:D6, \"Done\") & \" of 5 done\""],
      ], { header, "6,1": { bold: true } }),
      ...calendarCells(3, 300, 3, [
        [8, "Kickoff call"], [9, "Logo first drafts"], [12, "Pick photos"], [14, "Landing page review"],
        [14, "Budget check"], [16, "Announcement draft"], [19, "Test on phones"], [21, "Launch day"],
        [21, "Party at 6"], [23, "Look back"],
      ]),
    ],
    sheets_rules: [
      { id: 400, sheet_id: 1, range: "D2:D7", kind: "conditional", config: JSON.stringify({ condition: "<0", style: { color: "#e5484d", bold: true } }) },
      { id: 401, sheet_id: 2, range: "A2:A6", kind: "checkbox", config: "{}" },
      { id: 402, sheet_id: 2, range: "D2:D6", kind: "dropdown", config: JSON.stringify({ options: ["Not started", "In progress", "Done"] }) },
    ],
  });
};

const shape = (id, pageId, kind, x, y, w, h, text, style = {}, extra = {}) => ({
  id, page_id: pageId, parent_id: null, kind, x, y, w, h, rotation: 0, z: id, text, style: JSON.stringify(style), deleted: false, ...extra,
});
const edge = (id, pageId, from, fromPort, to, toPort, label = "", extra = {}) => ({
  id, page_id: pageId, from_id: from, from_port: fromPort, to_id: to, to_port: toPort, points: "[]", kind: "orthogonal",
  start_arrow: "", end_arrow: "arrow", label, style: "{}", deleted: false, ...extra,
});

const flows = () => {
  const good = { fill: "var(--mw-success)", textColor: "var(--mw-dark)" };
  const bad = { fill: "var(--mw-warning)", textColor: "var(--mw-dark)" };
  const accent = { fill: "var(--mw-accent)", textColor: "var(--mw-accent-text)" };
  return archive("flows", "diagram", {
    diagram_pages: [
      { id: 1, channel_id: 1, name: "How a change travels", z: 1, background: "", grid: true },
      { id: 2, channel_id: 1, name: "Launch flow", z: 2, background: "", grid: true },
    ],
    diagram_shapes: [
      shape(10, 1, "actor", 40, 110, 60, 100, "You"),
      shape(11, 1, "rounded", 160, 130, 160, 60, "Edit something"),
      shape(12, 1, "document", 380, 125, 160, 70, "Signed change"),
      shape(13, 1, "cloud", 600, 110, 190, 100, "Members online"),
      shape(14, 1, "diamond", 615, 280, 160, 120, "Allowed by the workspace's rules?"),
      shape(15, 1, "rounded", 860, 310, 160, 60, "Everyone applies it", good),
      shape(16, 1, "rounded", 370, 310, 170, 60, "Refused everywhere", bad),
      shape(17, 1, "cylinder", 860, 450, 160, 90, "Each member's copy"),
      shape(18, 1, "note", 40, 290, 260, 110, "No central server: every member keeps the whole history and checks every change."),
      shape(20, 2, "ellipse", 40, 140, 120, 60, "Idea", accent),
      shape(21, 2, "rounded", 220, 140, 140, 60, "Design"),
      shape(22, 2, "rounded", 420, 140, 140, 60, "Build"),
      shape(23, 2, "diamond", 620, 120, 140, 100, "Tested?"),
      shape(24, 2, "ellipse", 830, 140, 120, 60, "Ship it", good),
      shape(25, 2, "text", 220, 240, 340, 40, "Double-click a shape to change its text", { fontSize: 13, textColor: "var(--mw-text-muted)" }),
    ],
    diagram_edges: [
      edge(30, 1, 10, "e", 11, "w"),
      edge(31, 1, 11, "e", 12, "w"),
      edge(32, 1, 12, "e", 13, "w", "sent"),
      edge(33, 1, 13, "s", 14, "n", "each one checks"),
      edge(34, 1, 14, "e", 15, "w", "yes"),
      edge(35, 1, 14, "w", 16, "e", "no", { style: JSON.stringify({ dash: true }) }),
      edge(36, 1, 15, "s", 17, "n"),
      edge(40, 2, 20, "e", 21, "w"),
      edge(41, 2, 21, "e", 22, "w"),
      edge(42, 2, 22, "e", 23, "w"),
      edge(43, 2, 23, "e", 24, "w", "yes"),
      edge(44, 2, 23, "s", 22, "s", "not yet", { kind: "curved", style: JSON.stringify({ dash: true }) }),
    ],
  });
};

// ---------- Make ----------

const handbook = () => archive("handbook", "docs", {
  docs_pages: [
    page(1, "Writing docs", lines(
      "# Writing docs",
      "",
      "A docs channel is a tree of pages. Everyone can edit a page at the same time and sees the others' cursors.",
      "",
      "Write Markdown, or use the toolbar:",
      "",
      "| You type | You get |",
      "| --- | --- |",
      "| `**bold**` | **bold** |",
      "| `*italic*` | *italic* |",
      "| `` `code` `` | `code` |",
      "| `> quote` | a quote |",
      "| `- [ ] task` | a checkbox |",
      "",
      "Start a line with `#` for a heading, `-` for a list or `1.` for steps. Paste or drop pictures straight in.",
      "",
      "```js",
      "export const greet = (name) => `Hello, ${name}!`;",
      "```",
      "",
      `Type \`#\` to link to a channel or anything inside one, like the [roadmap](${link("roadmap")}).`,
    )),
    page(2, "Live embeds", lines(
      "# Live embeds",
      "",
      "Sheets and diagrams can be **embedded** in a page. An embed isn't a copy: change the source and the page follows.",
      "",
      `The budget table from [budget](${link("budget")}):`,
      "",
      `![Budget](${link("budget", "/export/table:1")})`,
      "",
      `And a diagram page from [flows](${link("flows")}):`,
      "",
      `![How a change travels](${link("flows", "/export/1")})`,
      "",
      "To embed one yourself, type `#`, search for a sheet or diagram page and pick the result marked *export*.",
    ), { z: 2 }),
    page(3, "Launch announcement (draft)", lines(
      "# Lighthouse is here",
      "",
      "*A draft for the launch post. Edit away.*",
      "",
      "Lighthouse helps small teams find their way through busy weeks. Today it is open to everyone.",
      "",
      "## What's inside",
      "",
      "- A calm home screen",
      "- Reminders that don't nag",
      "- Works on phones and computers",
      "",
      "## Before we post",
      "",
      "- [x] Pick a name",
      "- [ ] Final screenshots",
      "- [ ] Check the links",
    ), { z: 3 }),
    page(4, "Sub-pages", lines(
      "# Sub-pages",
      "",
      "This page lives under **Launch announcement (draft)**. Drag pages in the tree to nest or reorder them.",
      "",
      "A whole tree can be exported as `.md` files, with sub-pages in folders.",
    ), { parent_id: 3, z: 1 }),
  ],
});

// Design layers: x and y are relative to the parent frame.
const node = (id, parentId, kind, name, x, y, width, height, props = {}, extra = {}) => ({
  id, channel_id: 1, parent_id: parentId, kind, name, z: id, x, y, width, height, rotation: 0,
  props: JSON.stringify(props), url: null, thumb: null, author_id: GUIDE, created_at: at(), deleted: false, ...extra,
});
const solid = (color) => ({ color, opacity: 1, visible: true });
const text = (value, size, color, extra = {}) => ({
  fills: [solid(color)], text: value, sizing: "height", textStyle: { family: "Inter", size, weight: 400, ...extra },
});

const website = () => {
  const files = {};
  const hero = storedPicture(files, "sea-at-dusk.png");
  const logo = storedPicture(files, "logo.png");
  const image = (id, parentId, name, x, y, w, h, pic) =>
    node(id, parentId, "image", name, x, y, w, h, { radius: 12 }, { url: pic.url, thumb: pic.thumb });
  return archive("website", "design", {
    design_pages: [{ id: 1, channel_id: 1, name: "Page 1", background: "", z: 1, palette_id: 61 }],
    design_nodes: [
      node(10, null, "frame", "Home, desktop", 0, 0, 1200, 760, { fills: [solid(brand.foam)], clip: true }),
      node(11, 10, "rect", "Header", 0, 0, 1200, 72, { fills: [solid(brand.navy)] }),
      image(12, 10, "Logo", 32, 12, 48, 48, logo),
      node(13, 10, "text", "Brand", 92, 22, 200, 28, text("Lighthouse", 22, "#ffffff", { weight: 700 })),
      node(14, 10, "text", "Nav", 820, 26, 340, 24, text("Features     Pricing     About", 16, "#ffffff", { align: "right" })),
      node(15, 10, "text", "Headline", 80, 170, 480, 140, text("Find your way through busy weeks", 44, brand.navy, { weight: 700, lineHeight: 1.15 })),
      node(16, 10, "text", "Subhead", 80, 330, 440, 80, text("Lighthouse keeps your team's plans, notes and reminders in one calm place.", 18, "#4a5568", { lineHeight: 1.5 })),
      node(17, 10, "rect", "Button", 80, 440, 200, 52, { fills: [solid(brand.coral)], radius: 26 }),
      node(18, 10, "text", "Button label", 80, 455, 200, 24, text("Get started", 17, "#ffffff", { weight: 600, align: "center" }), { z: 18.5 }),
      image(19, 10, "Hero picture", 620, 140, 500, 312, hero),
      node(20, 10, "ellipse", "Accent dot", 1080, 470, 60, 60, { fills: [solid(brand.amber)] }),
      node(30, null, "frame", "Home, phone", 1300, 0, 390, 760, { fills: [solid(brand.foam)], clip: true }),
      node(31, 30, "rect", "Header", 0, 0, 390, 64, { fills: [solid(brand.navy)] }),
      image(32, 30, "Logo", 16, 12, 40, 40, logo),
      node(33, 30, "text", "Brand", 66, 20, 200, 26, text("Lighthouse", 20, "#ffffff", { weight: 700 })),
      image(34, 30, "Hero picture", 16, 88, 358, 224, hero),
      node(35, 30, "text", "Headline", 16, 336, 358, 110, text("Find your way through busy weeks", 32, brand.navy, { weight: 700, lineHeight: 1.15 })),
      node(36, 30, "rect", "Button", 16, 480, 358, 52, { fills: [solid(brand.coral)], radius: 26 }),
      node(37, 30, "text", "Button label", 16, 495, 358, 24, text("Get started", 17, "#ffffff", { weight: 600, align: "center" }), { z: 37.5 }),
      node(40, null, "text", "Note", 0, 800, 900, 60, text(
        "Select a layer to change it in the panel on the right. Drag to move it and use the corners to resize it.",
        16, "#6b7280", { lineHeight: 1.5 })),
    ],
    design_colors: [
      { id: 51, channel_id: 1, name: "Ink", z: 1, deleted: false },
      { id: 52, channel_id: 1, name: "Paper", z: 2, deleted: false },
      { id: 53, channel_id: 1, name: "Accent", z: 3, deleted: false },
    ],
    design_palettes: [
      { id: 61, channel_id: 1, name: "Day", z: 1, deleted: false },
      { id: 62, channel_id: 1, name: "Night", z: 2, deleted: false },
    ],
    design_color_values: [
      { id: 71, channel_id: 1, palette_id: 61, color_id: 51, value: brand.navy },
      { id: 72, channel_id: 1, palette_id: 61, color_id: 52, value: brand.foam },
      { id: 73, channel_id: 1, palette_id: 61, color_id: 53, value: brand.coral },
      { id: 74, channel_id: 1, palette_id: 62, color_id: 51, value: brand.foam },
      { id: 75, channel_id: 1, palette_id: 62, color_id: 52, value: brand.navy },
      { id: 76, channel_id: 1, palette_id: 62, color_id: 53, value: brand.amber },
    ],
  }, files);
};

// A reference board in a design channel: pictures turned a little, and a sticky note (a group of paper and text).
const moodBoard = () => {
  const files = {};
  // Placed by its middle, like pinning a picture up.
  const pinned = (id, name, cx, cy, scale, rotation = 0) => {
    const pic = storedPicture(files, name);
    const w = Math.round(pic.width * scale);
    const h = Math.round(pic.height * scale);
    return node(id, null, "image", name.replace(/\.png$/, ""), cx - w / 2, cy - h / 2, w, h, {}, { url: pic.url, thumb: pic.thumb, rotation });
  };
  return archive("mood-board", "design", {
    design_pages: [{ id: 1, channel_id: 1, name: "Page 1", background: "", z: 1, palette_id: null }],
    design_nodes: [
      pinned(11, "sea-at-dusk.png", 0, 0, 1),
      pinned(12, "lighthouse.png", 520, 40, 0.8, 4),
      pinned(13, "waves.png", -420, 260, 0.9, -3),
      pinned(14, "palette.png", 60, 360, 0.9),
      pinned(15, "logo.png", -380, -160, 0.8),
      node(16, null, "group", "Note 1", 380, 300, 200, 160),
      node(17, 16, "rect", "Paper", 0, 0, 200, 160, { fills: [solid("#ffe58f")], radius: 2 }),
      node(18, 16, "text", "Text", 12, 12, 176, 100, text(
        "Drop pictures here, then select a few and right-click > Arrange. N adds a note like this one.", 15, "#262626", { lineHeight: 1.4 })),
    ],
  }, files);
};

const sharedFiles = () => {
  const files = {};
  const entry = (id, parentId, kind, name, extra = {}) => ({
    id, channel_id: 1, parent_id: parentId, kind, name, mime: "", size: 0, url: null, thumb: null, width: null, height: null,
    author_id: GUIDE, created_at: at(), deleted: false, ...extra,
  });
  const file = (id, parentId, name, mime, bytes) => entry(id, parentId, "file", name, { mime, ...stored(files, bytes) });
  const pic = (id, parentId, name) => entry(id, parentId, "file", name, storedPicture(files, name));
  return {
    files,
    async build() {
      const bots = new Uint8Array(await readFile(join(examples, "bots.mwp")));
      const pingpong = new Uint8Array(await readFile(join(examples, "pingpong.mwp")));
      return archive("shared-files", "files", {
        files_entries: [
          entry(1, null, "folder", "Brand kit"),
          entry(2, null, "folder", "Plugins"),
          file(3, null, "README.md", "text/markdown", strToU8(lines(
            "# Shared files",
            "",
            "Files here are shared with everyone in the workspace. Drop files or whole folders onto this channel to add them.",
            "",
            "- Click a file to preview it, right-click it to download, rename or move it.",
            "- Pictures, video, audio, PDFs, text and code open right here.",
            "- In the desktop app, right-click the channel and choose Sync channel to keep it as a normal folder on your computer.",
            "",
            "Brand kit holds the pictures used in the website and mood-board channels.",
            "Plugins holds two example plugins to install in Settings > Plugins.",
            "",
          ))),
          file(4, null, "contacts.csv", "text/csv", strToU8(lines(
            "name,role,email",
            "Ada,Design,ada@example.com",
            "Grace,Engineering,grace@example.com",
            "Linus,Marketing,linus@example.com",
            "",
          ))),
          pic(10, 1, "logo.png"),
          pic(11, 1, "palette.png"),
          pic(12, 1, "sea-at-dusk.png"),
          pic(13, 1, "lighthouse.png"),
          file(30, 2, "bots.mwp", "application/zip", bots),
          file(31, 2, "pingpong.mwp", "application/zip", pingpong),
          file(32, 2, "About these plugins.md", "text/markdown", strToU8(lines(
            "# Example plugins",
            "",
            "Download a .mwp file and install it in Settings > Plugins.",
            "",
            "- bots.mwp: the Reply, Announcer and Tester bot types used in #bot-playground.",
            "- pingpong.mwp: a two-player Ping-pong channel. After installing it, add a channel of type Ping-pong.",
            "",
            "Plugins run inside MakeWork and can add channel types, bots, viewers and more.",
            "",
          ))),
        ],
      }, files);
    },
  };
};

// ---------- Code and web ----------

// The repository's history is read from GitHub when someone presses Update in the channel.
const helloWorld = () => archive("hello-world", "git", {
  git_repos: [{
    id: 1, channel_id: 1, provider: "github", host: "github.com", path: "octocat/Hello-World",
    url: "https://github.com/octocat/Hello-World", default_branch: "master", imported_by: GUIDE, imported_at: null,
  }],
});

const research = () => archive("research", "browser", {
  browser_pages: [{ id: 1, channel_id: 1, url: "https://en.wikipedia.org/wiki/Lighthouse", title: "Lighthouse - Wikipedia", changed_by: GUIDE, changed_at: at() }],
  browser_bookmarks: [
    { id: 11, channel_id: 1, url: "https://en.wikipedia.org/wiki/Lighthouse", title: "Lighthouses", z: 1, author_id: GUIDE, created_at: at(), deleted: false },
    { id: 12, channel_id: 1, url: "https://www.openstreetmap.org", title: "OpenStreetMap", z: 2, author_id: GUIDE, created_at: at(), deleted: false },
    { id: 13, channel_id: 1, url: "https://developer.mozilla.org", title: "MDN Web Docs", z: 3, author_id: GUIDE, created_at: at(), deleted: false },
  ],
});

// ---------- Workspace ----------

const workspaceHandbook = () => archive("workspace-handbook", "docs", {
  docs_pages: [
    page(1, "Your workspace", lines(
      "# Your workspace",
      "",
      "A workspace holds **categories**, and categories hold **channels**. Each channel's type decides what it is: chat, voice, tasks, sheets, diagram, docs, design, files, Git or browser. Plugins can add more.",
      "",
      "- **Add a channel**: right-click a category and choose Add channel.",
      "- **Rearrange**: drag channels and categories in the list.",
      "- **Settings**: click the workspace name at the top of the channel list for Workspace settings.",
      "- **Export**: right-click a channel and choose Export as .zip to save it, or to import it into another workspace.",
    )),
    page(2, "Roles and permissions", lines(
      "# Roles and permissions",
      "",
      "The owner can do anything. Everyone else has **@everyone**, plus any roles you give them in **Workspace settings > Roles**.",
      "",
      "A role grants permissions such as:",
      "",
      "- **Send messages**: write in chat, react, vote and comment.",
      "- **Edit content**: change tasks, sheets, files, designs and diagrams.",
      "- **Manage channels**: add, rename and remove channels.",
      "- **Manage bots** and **Manage plugins**.",
      "- **Kick**, **Ban** and **Mute members**.",
      "",
      "Right-click a channel or category and choose **Permissions** to hide it from a role or a person, or to make it read-only for them.",
    ), { z: 2 }),
    page(3, "Inviting people", lines(
      "# Inviting people",
      "",
      "Open **Workspace settings > Invite** and send the code to the person you want. They paste it in **Add workspace > Join a workspace**.",
      "",
      "Inviting and joining need an account, so others can find you. Working offline? Create one in Settings > Account and your workspaces come along.",
      "",
      "Kicked members can join again with a new invite; banned members can't.",
    ), { z: 3 }),
    page(4, "Plugins and bots", lines(
      "# Plugins and bots",
      "",
      "Every channel type here is a **plugin**. More can be installed from `.mwp` files in **Settings > Plugins**; they can add channel types, bots, file viewers and more.",
      "",
      "A plugin with its own data can also be added to a workspace in **Workspace settings > Plugins**, so every member gets it.",
      "",
      `**Bots** are created in **Workspace settings > Bots** from the bot types that installed plugins provide. Try them in [bot-playground](${link("bot-playground")}); the example plugins are in [shared-files](${link("shared-files")}).`,
    ), { z: 4 }),
    page(5, "Nodes", lines(
      "# Nodes",
      "",
      "A **node** is a computer that stays on and keeps a copy of the workspace and its files. Members can then catch up and download files even when the person who added them is offline.",
      "",
      "Nodes wait to be approved in **Workspace settings > Nodes**. A node can read everything in the workspace, so only add one you trust.",
      "",
      "Big files can be split across several nodes, so no single node holds the whole file.",
    ), { z: 5 }),
    page(6, "Your data on disk", lines(
      "# Your data on disk",
      "",
      "In the desktop app a workspace can live in a folder you choose. That makes it easy to back up or move to another computer, and to open again with **Add workspace > Open a saved workspace**.",
      "",
      "Channels can also be kept as ordinary files: right-click a channel and choose **Sync channel**. Docs become Markdown, sheets and diagrams get their exports, and shared files keep their real bytes.",
      "",
      "**Workspace settings > History** shows every change and who made it.",
    ), { z: 6 }),
  ],
});

async function main() {
  const files = sharedFiles();
  const channels = [
    welcome(), guideDocs(), general(), lounge(), botPlayground(), roadmap(), budget(), flows(),
    handbook(), website(), moodBoard(), await files.build(), helloWorld(), research(), workspaceHandbook(),
  ];
  await mkdir(outDir, { recursive: true });
  for (const old of await readdir(outDir)) if (old.endsWith(".zip")) await rm(join(outDir, old));
  for (const { json, files: content } of channels) {
    const zip = zipSync({ "channel.json": strToU8(JSON.stringify(json, null, 1)), ...content }, { level: 6 });
    await writeFile(join(outDir, `${json.channel.name}.zip`), zip);
    console.log(`${json.channel.name}.zip (${zip.length} bytes)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
