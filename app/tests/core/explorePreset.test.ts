// The "Explore MakeWork" preset ships one channel archive per channel in preset.json. Every archive is checked
// against the plugin that backs its channel, the same column and value rules applied on import
// (core/channelArchive.ts writes through p2p/ledger.ts, which converts each value the way system/data.ts does),
// so a wrong column name or value type would otherwise only show up when a user creates the preset.
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { chat } from "../../src/system/chat";
import { docs } from "../../src/system/docs";
import { members } from "../../src/system/members";
import { tasks } from "../../src/system/tasks";
import { voice } from "../../src/system/voice";
import { browser } from "../../src/system/browser";
import { design } from "../../src/system/design";
import { diagram } from "../../src/system/diagram";
import { files } from "../../src/system/files";
import { git } from "../../src/system/git";
import { sheets } from "../../src/system/sheets";
import { convertValues, type MockManifest } from "../../src/system/data";
import { personColumns } from "../../src/p2p/people";
import preset from "../../src/presets/explore/preset.json";

const manifests: Record<string, MockManifest> = {
  chat: chat.manifest, docs: docs.manifest, tasks: tasks.manifest, voice: voice.manifest,
  browser: browser.manifest, design: design.manifest, diagram: diagram.manifest, files: files.manifest, git: git.manifest,
  sheets: sheets.manifest,
};
const dir = new URL("../../src/presets/explore/", import.meta.url);

interface Archive {
  format: string;
  version: number;
  channel: { name: string; type: string };
  tables: Record<string, Record<string, unknown>[]>;
  profiles: Record<string, unknown>[];
}

async function entries(file: string): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await readFile(new URL(file, dir))));
}

async function read(file: string): Promise<Archive> {
  const json = (await entries(file))["channel.json"];
  if (!json) throw new Error(`${file} has no channel.json`);
  return JSON.parse(strFromU8(json)) as Archive;
}

const channels = preset.categories.flatMap((c) => c.channels);

describe("Explore MakeWork preset", () => {
  it("lists the archives that ship with it", async () => {
    const files = (await readdir(new URL("channels/", dir))).filter((f) => f.endsWith(".zip")).sort();
    expect(files).toEqual(channels.map((c) => c.file.replace(/^channels\//, "")).sort());
  });

  it.each(channels)("$name is an archive its plugin can hold", async (channel) => {
    const archive = await read(channel.file);
    expect(archive.format).toBe("makework-channel");
    expect(archive.version).toBe(1);
    expect(archive.channel).toEqual({ name: channel.name, type: channel.type });
    const manifest = manifests[channel.type];
    expect(manifest).toBeDefined();

    for (const [table, rows] of Object.entries(archive.tables)) {
      const declared = manifest.tables.find((t) => t.name === table);
      expect(declared, `${channel.name} has an unknown ${table} table`).toBeDefined();
      for (const row of rows) {
        const { id, ...values } = row as { id: number } & Record<string, unknown>;
        expect(Number.isInteger(id), `${table} row needs an id`).toBe(true);
        for (const column of Object.keys(values)) {
          expect(declared!.columns[column], `${table}.${column} is not a column`).toBeDefined();
        }
        // Throws on a wrong type or an emoji in text, like an import would.
        expect(() => convertValues(table, declared!.columns, values)).not.toThrow();
      }
    }

    for (const profile of archive.profiles) {
      const columns = members.manifest.tables.find((t) => t.name === "members_profiles")!.columns;
      expect(Object.keys(profile).every((c) => c in columns), `${channel.name} profile has an unknown column`).toBe(true);
    }
  });

  it("has a channel for every built-in plugin", () => {
    expect(new Set(channels.map((c) => c.type))).toEqual(new Set(Object.keys(manifests)));
  });

  it.each(channels)("$name has unique row ids, references inside it and the content it points at", async (channel) => {
    const zip = await entries(channel.file);
    const archive = await read(channel.file);
    const rows = Object.values(archive.tables).flat();
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size, "row ids repeat").toBe(ids.length);
    const known = new Set(ids);
    const people = new Set(archive.profiles.map((p) => p.user_id));
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (value === null || column === "id" || column === "channel_id" || !column.endsWith("_id")) continue;
        if (personColumns.has(column)) expect(people.has(value), `${column} ${value} has no profile`).toBe(true);
        else expect(known.has(value), `${column} ${value} dangles`).toBe(true);
      }
      for (const value of Object.values(row)) {
        const hash = typeof value === "string" ? /^mwc:([0-9a-f]{64})$/.exec(value)?.[1] : null;
        if (hash) expect(zip[`content/${hash}`], `content ${hash} is missing`).toBeDefined();
      }
    }
  });

  it("links only to channels and rows the preset has", async () => {
    for (const channel of channels) {
      const text = strFromU8((await entries(channel.file))["channel.json"]);
      for (const [, name, , id] of text.matchAll(/makework:\/\/explore\/([a-z0-9-]+)(?:\/[a-z][a-z0-9-]*\/([a-z]+:)?(\d+))?/g)) {
        const target = channels.find((c) => c.name === name);
        expect(target, `${channel.name} links to a missing ${name}`).toBeDefined();
        if (id) {
          const rows = Object.values((await read(target!.file)).tables).flat();
          expect(rows.some((row) => row.id === Number(id)), `${channel.name} links to a missing row ${id} in ${name}`).toBe(true);
        }
      }
    }
  });

  it("points its bots at chat channels it has", () => {
    for (const bot of preset.bots) {
      expect(channels.find((c) => c.name === bot.channel)?.type).toBe("chat");
    }
    expect(channels.find((c) => c.name === preset.welcome)?.type).toBe("chat");
  });

  it("gives every docs channel pages that fit together", async () => {
    for (const channel of channels.filter((c) => c.type === "docs")) {
      const pages = (await read(channel.file)).tables.docs_pages;
      expect(pages.length, `${channel.name} needs pages`).toBeGreaterThan(0);
      for (const page of pages) {
        expect(String(page.title).length, `${channel.name} page needs a title`).toBeGreaterThan(0);
        expect(String(page.body).includes("#"), `${channel.name} page needs real markdown`).toBe(true);
      }
    }
  });
});
