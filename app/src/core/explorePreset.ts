// Creates the "Explore MakeWork" preset workspace by importing bundled channel archives.
//
// Archives can't know the ids the workspace will give their channels, so their text links to each other as
// makework://explore/<channel>[/<kind>/<row id>] (row ids as in the archive). Every channel's and row's new id is
// picked before importing, and those links are written out as real ones first. Calendar sheets are moved by
// whole weeks to the current month, so their items show up when the preset is opened.
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { importChannel } from "./channelArchive";
import { createWorkspace } from "../p2p/workspaces";
import { newRowId } from "../p2p/ledger";
import { attach } from "./serverless";
import { account } from "./account";
import { linkUrl } from "./links";
import { openChannel, openWorkspace as showWorkspace } from "./navigation";
import preset from "../presets/explore/preset.json";
import type { ApiClient } from "../api/client";
import type { Folder } from "../p2p/workspaces";
import { logoCanvas, logoSvg } from "./appIcon";
import { avatarFromFile } from "../ui/avatarImage";

// The channel archives are bundled as assets, so their URLs resolve in dev and in a packaged build.
const bundled = import.meta.glob<string>("../presets/explore/channels/*.zip", { eager: true, query: "?url", import: "default" });
const channelUrl = (file: string) => bundled[`../presets/explore/${file}`];

interface Planned {
  name: string;
  file: string;
  entries: Record<string, Uint8Array>;
  ids: { channel: number; rows: Map<number, number> };
}

interface Archive {
  tables: Record<string, Record<string, unknown>[]>;
}

const placeholder = /makework:\/\/explore\/([a-z0-9-]+)(?:\/([a-z][a-z0-9-]*)\/([a-z]+:)?(\d+))?/g;
const day = 86_400_000;

export async function importExplorePreset(folder?: Folder): Promise<void> {
  const me = account();
  if (!me) throw new Error("Not signed in.");
  const workspace = await createWorkspace(me, preset.name ?? "Explore MakeWork", folder);
  attach(workspace);
  const workspaceId = workspace.entry.id;

  const planned = new Map<string, Planned>();
  for (const ch of preset.categories.flatMap((cat) => cat.channels)) {
    const url = channelUrl(ch.file);
    const bytes = url ? await fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null) : null;
    if (!bytes) {
      console.warn("Preset channel has no archive", ch.name);
      continue;
    }
    const entries = unzipSync(new Uint8Array(bytes));
    const archive = JSON.parse(strFromU8(entries["channel.json"])) as Archive;
    const rows = new Map<number, number>();
    for (const list of Object.values(archive.tables)) for (const row of list) rows.set(Number(row.id), newRowId());
    planned.set(ch.name, { name: ch.name, file: ch.file, entries, ids: { channel: newRowId(), rows } });
  }

  const link = (_: string, name: string, kind?: string, prefix?: string, id?: string) => {
    const target = planned.get(name);
    if (!target) return `#${name}`;
    const row = kind && id ? target.ids.rows.get(Number(id)) ?? Number(id) : null;
    return linkUrl({ workspaceId, channelId: target.ids.channel, ...(kind && row !== null && { target: { kind, id: `${prefix ?? ""}${row}` } }) });
  };

  await addBots(workspace.api, (name) => planned.get(name)?.ids.channel ?? null);

  for (const cat of preset.categories) {
    const { id: categoryId } = await workspace.api.plugin("channels").call<{ id: number }>("add-category", { name: cat.name });
    for (const ch of cat.channels) {
      const plan = planned.get(ch.name);
      if (!plan) continue;
      try {
        const archive = JSON.parse(strFromU8(plan.entries["channel.json"]).replace(placeholder, link)) as Archive;
        moveCalendars(archive);
        const file = new Blob([zipSync({ ...plan.entries, "channel.json": strToU8(JSON.stringify(archive)) })]);
        await importChannel(workspaceId, categoryId, file, plan.ids);
      } catch (e) {
        console.warn("Skipping preset channel", ch.name, e);
      }
    }
  }

  const welcome = planned.get(preset.welcome)?.ids.channel ?? null;
  if (welcome !== null) {
    const channels = workspace.api.plugin("channels");
    const [row] = await channels.read("channels_workspace");
    if (row) await channels.update("channels_workspace", { welcome_channel_id: welcome }, { id: row.id });
  }
  await setLogoIcon(workspace.api).catch((e) => console.warn("The preset's icon wasn't set", e));
  showWorkspace(workspaceId);
  if (welcome !== null) openChannel(workspaceId, welcome);
}

// The workspace's picture is the MakeWork crow in its own colors.
async function setLogoIcon(api: ApiClient) {
  const canvas = await logoCanvas(logoSvg(null), 256);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const icon = await avatarFromFile(new File([blob], "makework.png", { type: "image/png" }));
  const channels = api.plugin("channels");
  const [row] = await channels.read("channels_workspace");
  if (row) await channels.update("channels_workspace", { icon }, { id: row.id });
}

// The example bots: registered like Workspace settings > Bots does, then pointed at their channel.
async function addBots(api: ApiClient, channelId: (name: string) => number | null) {
  for (const bot of preset.bots) {
    try {
      const config = { ...bot.config, ...(bot.channel && { channel: channelId(bot.channel) ?? 0 }) };
      const created = await api.plugin("bots").call<{ id: number; nickname: string; bot_number: number }>("create", {
        user_id: bot.user_id, type: bot.type, nickname: bot.nickname, config: JSON.stringify(config),
      });
      await api.plugin("members").call("set-bot-profile", {
        user_id: bot.user_id, bot_type: bot.type, nickname: created.nickname, bot_number: created.bot_number,
      });
      if (!bot.enabled) await api.plugin("bots").call("set-status", { id: created.id, status: "disabled" });
    } catch (e) {
      console.warn("Preset bot not added", bot.nickname, e);
    }
  }
}

// A calendar sheet keeps an item of day d in slot s at row d * itemsPerDay + s (days since 1970).
function moveCalendars(archive: Archive) {
  const sheets = archive.tables.sheets_sheets ?? [];
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  for (const sheet of sheets.filter((s) => s.mode === "calendar")) {
    const calendar = JSON.parse(String(sheet.calendar || "{}")) as { month?: string; itemsPerDay?: number };
    if (!calendar.month) continue;
    const from = Date.UTC(Number(calendar.month.slice(0, 4)), Number(calendar.month.slice(5)) - 1, 1);
    const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const shift = Math.round((to - from) / day / 7) * 7;
    const perDay = calendar.itemsPerDay ?? 4;
    for (const cell of archive.tables.sheets_cells ?? []) {
      if (cell.sheet_id !== sheet.id || cell.col !== 0) continue;
      const row = Number(cell.row);
      cell.row = (Math.floor(row / perDay) + shift) * perDay + (row % perDay);
    }
    sheet.calendar = JSON.stringify({ ...calendar, month });
  }
}
