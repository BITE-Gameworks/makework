// Every client plugin: built in, or installed on this device from a .mwp package. Locally installed plugins are
// trusted and run in the app itself; UI that a workspace sends runs sandboxed (SandboxFrame).
// A .mwp is a zip (manifest.json, client.js, an optional icon.svg and assets/). The whole package is kept per
// plugin in IndexedDB ("plugins"); the plugin runs from client.js, with manifest.json as the source of truth for
// the fields it carries (id, name, version, description, author, minApp, data). Plugins installed before packages
// existed (plain .js text in localStorage) move into the store once, on the first load.
import { createEffect, createRoot, createSignal } from "solid-js";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { dbAll, dbDelete, dbGet, dbPut } from "../core/db";
import { readJson, removeKey, writeJson } from "../core/storage";
import { appVersion } from "../core/version";
import { registerIconSet, type IconName } from "../theme/icons";
import { setPluginThemes } from "../theme/store";
import { dataNameOf, declaredTypeOf, resolveDeclared, sameDeclaredSchema, type DeclaredManifest } from "../system/declared";
import { plugins as serverPlugins } from "../p2p/plugins";
import type { ChannelTypeInfo, ChannelView, ClientPlugin, DiskLayout, ExportProvider, FileViewer, LinkProvider, PluginManifest, ViewerInfo } from "./types";

export interface PluginRecord {
  plugin: ClientPlugin;
  origin: "built-in" | "installed";
}

// A downloaded or uploaded .mwp, in the "plugins" IndexedDB store.
interface StoredPackage {
  id: string;
  bytes: Uint8Array;
  sha256: string;
}

const installedKey = "mw.plugins.installed";
const disabledKey = "mw.plugins.disabled";
const decidedKey = "mw.plugins.defaultOffDecided";
const maxPackageBytes = 10 * 1024 * 1024;
const tableName = /^[a-z0-9_]{1,64}$/;

const [records, setRecords] = createSignal<PluginRecord[]>([]);
const [disabled, setDisabled] = createSignal<string[]>(readJson(disabledKey, []));
const [loadErrors, setLoadErrors] = createSignal<string[]>([]);
const botContributionListeners = new Set<() => void>();

export { loadErrors };

// The packages of installed plugins, by id: the zip for assets and for sharing a plugin with a workspace.
const installedPackages = new Map<string, Uint8Array>();
const filesCache = new Map<string, Record<string, Uint8Array>>();

export function plugins(): PluginRecord[] {
  return records();
}

export function isEnabled(id: string): boolean {
  return !disabled().includes(id);
}

// Later plugins win, so an installed plugin can replace a built-in channel type or view.
function enabled(): ClientPlugin[] {
  return records().map((r) => r.plugin).filter((p) => isEnabled(p.manifest.id));
}

export function allChannelTypes(): ChannelTypeInfo[] {
  const byId = new Map<string, ChannelTypeInfo>();
  for (const plugin of enabled()) for (const type of plugin.manifest.contributes?.channelTypes ?? []) byId.set(type.id, type);
  return [...byId.values()];
}

export function channelTypeInfo(id: string): ChannelTypeInfo | undefined {
  return allChannelTypes().find((t) => t.id === id);
}

export function channelViewFor(type: string): { view: ChannelView; plugin: PluginManifest } | undefined {
  const plugin = enabled().reverse().find((p) => p.channelViews?.[type]);
  return plugin && { view: plugin.channelViews![type], plugin: plugin.manifest };
}

export function linkProviderFor(type: string): LinkProvider | undefined {
  return enabled().reverse().find((p) => p.links?.[type])?.links?.[type];
}

export function exportProviderFor(type: string): ExportProvider | undefined {
  return enabled().reverse().find((p) => p.exports?.[type])?.exports?.[type];
}

export function diskLayoutFor(type: string): DiskLayout | undefined {
  return enabled().reverse().find((p) => p.disk?.[type])?.disk?.[type];
}

export interface ViewerMatch {
  info: ViewerInfo;
  viewer: FileViewer;
  plugin: PluginManifest;
}

// Viewers that can open a file, best first: later plugins first, then each plugin's own order.
export function viewersFor(name: string, mimeType: string): ViewerMatch[] {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  const matches = (info: ViewerInfo) =>
    (info.extensions ?? []).includes(extension) ||
    (info.mimeTypes ?? []).some((m) => m === mime || (m.endsWith("/*") && mime.startsWith(m.slice(0, -1))));
  return enabled().reverse().flatMap((p) =>
    (p.manifest.contributes?.viewers ?? [])
      .filter((info) => p.viewers?.[info.id] && matches(info))
      .map((info) => ({ info, viewer: p.viewers![info.id], plugin: p.manifest })));
}

// The plugin that contributes a channel type, disabled ones too: a disabled plugin's channels show a banner with
// its name, and none installed means the workspace offers its package (see ChannelHost).
export function pluginOfType(type: string): { plugin: ClientPlugin; origin: PluginRecord["origin"] } | undefined {
  const ordered = [...records()].reverse();
  return ordered.find((r) => r.plugin.channelViews?.[type])
    ?? ordered.find((r) => r.plugin.manifest.contributes?.channelTypes?.some((t) => t.id === type));
}

// The skills agents get from the plugins that own channel types, each tied to its type.
export function agentSkills(): import("./types").AgentSkill[] {
  return enabled().flatMap((p) => Object.entries(p.agentSkills ?? {}).flatMap(([type, list]) => list.map((skill) => ({ ...skill, channelType: skill.channelType ?? type }))));
}

export function agentIndexerFor(type: string): import("./types").AgentIndexer | undefined {
  return enabled().reverse().find((p) => p.agentIndex?.[type])?.agentIndex?.[type];
}

export function botTypes(): { id: string; type: import("./types").BotType; plugin: PluginManifest }[] {
  return enabled().flatMap((p) => Object.entries(p.bots ?? {}).map(([id, type]) => ({ id, type, plugin: p.manifest })));
}

export function workspaceSettingsSections(): { record: PluginRecord; render: NonNullable<ClientPlugin["workspaceSettings"]> }[] {
  return records().flatMap((record) => {
    const render = record.plugin.workspaceSettings;
    return render && isEnabled(record.plugin.manifest.id) ? [{ record, render }] : [];
  });
}

export function categoryNote(name: string): string | undefined {
  for (const plugin of enabled()) {
    const note = plugin.categoryNote?.(name);
    if (note) return note;
  }
  return undefined;
}

// Bot types renamed since workspaces stored them.
const renamedBotTypes: Record<string, string> = { modbot: "automoderator" };

export function botTypeFor(id: string): { type: import("./types").BotType; plugin: PluginManifest } | undefined {
  const found = botTypes().reverse().find((entry) => entry.id === (renamedBotTypes[id] ?? id));
  return found && { type: found.type, plugin: found.plugin };
}

export function setEnabled(id: string, on: boolean): void {
  setDisabled((list) => (on ? list.filter((x) => x !== id) : [...new Set([...list, id])]));
  writeJson(disabledKey, disabled());
  if (records().some((record) => record.plugin.manifest.id === id && Object.keys(record.plugin.bots ?? {}).length > 0))
    notifyBotContributionChange();
}

export function onBotContributionsChange(handler: () => void): () => void {
  botContributionListeners.add(handler);
  return () => botContributionListeners.delete(handler);
}

// `defaultOff` plugins start disabled on a device until the user turns them on (decided once per plugin).
export function registerBuiltIn(plugin: ClientPlugin, options: { defaultOff?: boolean } = {}): void {
  const id = plugin.manifest.id;
  const decided = readJson<string[]>(decidedKey, []);
  if (options.defaultOff && !decided.includes(id)) {
    writeJson(decidedKey, [...decided, id]);
    setEnabled(id, false);
  }
  add({ plugin: checked(plugin), origin: "built-in" });
}

// Installs or updates a plugin from a .mwp package (zip with manifest.json and client.js); the package is kept
// whole in IndexedDB, so uninstalling can remove it and assets can be read from it.
export async function installPlugin(bytes: ArrayBuffer | Uint8Array): Promise<PluginManifest> {
  const packageBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { plugin, sha256 } = await pluginFromPackage(packageBytes);
  const id = plugin.manifest.id;
  if (records().some((r) => r.origin === "built-in" && r.plugin.manifest.id === id))
    throw new Error(`'${id}' is a built-in plugin.`);
  if (records().some((r) => r.origin === "installed" && r.plugin.manifest.id === id))
    throw new Error(`'${id}' is already installed. Use Update from file to replace it.`);
  await savePluginPackage(plugin, packageBytes, sha256);
  return plugin.manifest;
}

// Replaces one installed plugin only when the package has the same identity and a newer version. `downgrade`
// accepts an older version too (to match the version a workspace uses).
export async function updatePlugin(id: string, bytes: ArrayBuffer | Uint8Array, options: { downgrade?: boolean } = {}): Promise<PluginManifest> {
  const current = records().some((r) => r.origin === "installed" && r.plugin.manifest.id === id);
  if (!current) throw new Error(`'${id}' is not an installed plugin.`);
  const packageBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { plugin, sha256 } = await pluginFromPackage(packageBytes);
  if (plugin.manifest.id !== id)
    throw new Error(`This package is for '${plugin.manifest.id}', not '${id}'.`);
  const latest = records().find((r) => r.origin === "installed" && r.plugin.manifest.id === id);
  if (!latest) throw new Error(`'${id}' is no longer installed.`);
  if (!options.downgrade && comparePluginVersions(plugin.manifest.version, latest.plugin.manifest.version) <= 0)
    throw new Error(`Version ${plugin.manifest.version} is not newer than the installed version ${latest.plugin.manifest.version}.`);
  await savePluginPackage(plugin, packageBytes, sha256);
  return plugin.manifest;
}

export async function uninstallPlugin(id: string): Promise<void> {
  const hadBots = records().some((record) => record.plugin.manifest.id === id && Object.keys(record.plugin.bots ?? {}).length > 0);
  setRecords((list) => list.filter((r) => !(r.origin === "installed" && r.plugin.manifest.id === id)));
  installedPackages.delete(id);
  filesCache.delete(id);
  await dbDelete("plugins", id);
  if (hadBots) notifyBotContributionChange();
}

export async function loadInstalledPlugins(): Promise<void> {
  await migrateInstalled();
  for (const stored of await dbAll<StoredPackage>("plugins")) {
    try {
      add({ plugin: await loadPackage(stored), origin: "installed" });
    } catch (e) {
      setLoadErrors((errors) => [...errors, `${stored.id}: ${(e as Error).message}`]);
    }
  }
}

// The stored package of an installed plugin, for sharing it with a workspace.
export async function pluginPackage(id: string): Promise<Uint8Array | null> {
  const inMemory = installedPackages.get(id);
  const stored = await dbGet<StoredPackage>("plugins", id);
  const bytes = inMemory ?? (stored ? bytesOf(stored.bytes) : null);
  if (!bytes) return null;
  installedPackages.set(id, bytes);
  return bytes;
}

export function validateWorkspacePluginUpdate(
  bytes: Uint8Array,
  expectedId: string,
  currentVersion: string,
  currentSchema: DeclaredManifest,
): { version: string; manifest: string } {
  const files = readPackage(bytes);
  const raw = manifestObject(files);
  if (raw.id !== expectedId) throw new Error(`This package is for '${String(raw.id)}', not '${expectedId}'.`);
  const clientPath = typeof raw.client === "string" ? raw.client : "client.js";
  if (!files[clientPath]) throw new Error(`The .mwp has no ${clientPath}.`);
  const manifest = checkedManifest(identityFields(raw) as PluginManifest);
  if (!manifest.data) throw new Error("The updated plugin no longer declares workspace data.");
  if (comparePluginVersions(manifest.version, currentVersion) <= 0)
    throw new Error(`Version ${manifest.version} is not newer than the workspace version ${currentVersion}.`);
  const declared = resolveDeclared({ manifest } as ClientPlugin, currentSchema.name);
  if (!sameDeclaredSchema(currentSchema, declared))
    throw new Error("Plugin updates must keep the workspace's declared data schema unchanged.");
  return { version: manifest.version, manifest: JSON.stringify(declared) };
}

// An asset of an installed plugin's package ("assets/logo.svg", "icon.svg") as a data URL.
export async function pluginAsset(id: string, path: string): Promise<string | null> {
  const files = await packageFiles(id);
  const bytes = files?.[path];
  if (!bytes) return null;
  return `data:${mimeOf(path)};base64,${toBase64(bytes)}`;
}

// Loads a stored package the same way install does, for plugins installed on a previous start.
async function loadPackage(stored: StoredPackage): Promise<ClientPlugin> {
  const bytes = bytesOf(stored.bytes);
  const { plugin, sha256 } = await pluginFromPackage(bytes);
  if (plugin.manifest.id !== stored.id) throw new Error(`The stored package id '${stored.id}' does not match '${plugin.manifest.id}'.`);
  if (stored.sha256 && stored.sha256 !== sha256) throw new Error(`The stored package '${stored.id}' failed its integrity check.`);
  return plugin;
}

// The .mwp's plugin, merged and checked: manifest.json is the source of truth (identity and data), client.js
// contributes the plugin's code, views and functions.
async function pluginFromPackage(bytes: Uint8Array): Promise<{ plugin: ClientPlugin; sha256: string }> {
  const files = readPackage(bytes);
  const manifest = manifestObject(files);
  if (typeof manifest.id !== "string" || typeof manifest.name !== "string" || typeof manifest.version !== "string")
    throw new Error("manifest.json needs id, name and version.");
  if (manifest.client !== undefined && typeof manifest.client !== "string")
    throw new Error("manifest.client must be a package path.");
  if (manifest.icon !== undefined && (typeof manifest.icon !== "string" || !manifest.icon.toLowerCase().endsWith(".svg") || !files[manifest.icon]))
    throw new Error("manifest.icon must name an SVG file in the .mwp package.");
  const clientPath = manifest.client ?? "client.js";
  const source = files[clientPath];
  if (!source) throw new Error(`The .mwp has no ${clientPath}.`);
  const plugin = checked(await evaluate(strFromU8(source)));
  if (plugin.manifest.id !== manifest.id || plugin.manifest.version !== manifest.version)
    throw new Error("The client module's plugin id and version must match manifest.json.");
  const merged = checkedManifest({ ...plugin.manifest, ...identityFields(manifest) });
  if (merged.data) {
    const type = declaredTypeOf(merged);
    if (!plugin.channelViews?.[type] && !merged.contributes?.channelTypes?.some((t) => t.id === type))
      throw new Error(`The declared data type '${type}' must be one of this plugin's channel types.`);
  }

  if (merged.minApp !== undefined && !appAtLeast(merged.minApp))
    throw new Error(`'${merged.id}' needs MakeWork ${merged.minApp} or newer; this app is ${appVersion}.`);
  return { plugin: { ...plugin, manifest: merged }, sha256: await sha256Hex(bytes) };
}

async function savePluginPackage(plugin: ClientPlugin, bytes: Uint8Array, sha256: string): Promise<void> {
  const id = plugin.manifest.id;
  await dbPut("plugins", { id, bytes, sha256 });
  installedPackages.set(id, bytes);
  filesCache.delete(id);
  add({ plugin, origin: "installed" });
}

// Plugins installed before .mwp packages (their client.js text in localStorage) become packages now, once.
async function migrateInstalled(): Promise<void> {
  const legacy = readJson<{ id: string; source: string }[]>(installedKey, []);
  if (legacy.length === 0) return;
  try {
    for (const entry of legacy) {
      if (await dbGet("plugins", entry.id)) continue;
      const plugin = checkedManifest(checked(await evaluate(entry.source)).manifest);
      if (plugin.id !== entry.id) throw new Error(`The saved plugin id '${entry.id}' does not match '${plugin.id}'.`);
      const bytes = zipSync({
        "manifest.json": strToU8(JSON.stringify(plugin, null, 2)),
        "client.js": strToU8(entry.source),
      }, { level: 6 });
      await dbPut("plugins", { id: entry.id, bytes, sha256: await sha256Hex(bytes) });
      installedPackages.set(entry.id, bytes);
    }
    // Only once every entry is in the store; a failure leaves the old key and the next start tries again.
    removeKey(installedKey);
  } catch (e) {
    console.warn("Installed plugins not moved:", e);
  }
}

// Unzips a package and checks it: the size limit and file paths without escaping the zip.
function readPackage(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.length > maxPackageBytes) throw new Error("The .mwp is larger than 10 MB.");
  let files: Record<string, Uint8Array>;
  let unpackedBytes = 0;
  let validationError: Error | undefined;
  try {
    files = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
          validationError = new Error(`The .mwp has an unsafe file path '${name}'.`);
          return false;
        }
        unpackedBytes += originalSize;
        if (originalSize > maxPackageBytes || unpackedBytes > maxPackageBytes) {
          validationError = new Error("The unpacked .mwp is larger than 10 MB.");
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new Error("That is not a valid .mwp package.");
  }
  if (validationError) throw validationError;
  for (const path of Object.keys(files)) {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").includes(".."))
      throw new Error(`The .mwp has an unsafe file path '${path}'.`);
  }
  if (!files["manifest.json"]) throw new Error("The .mwp has no manifest.json.");
  return files;
}

function manifestObject(files: Record<string, Uint8Array>): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(files["manifest.json"]));
  } catch {
    throw new Error("manifest.json is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("manifest.json must be an object.");
  return parsed as Record<string, unknown>;
}

// The manifest.json fields that win over client.js's manifest.
function identityFields(m: Record<string, unknown>): Partial<PluginManifest> {
  const fields = ["id", "name", "version", "description", "author", "minApp", "data", "icon"] as const;
  const out: Record<string, unknown> = {};
  for (const field of fields) if (m[field] !== undefined) out[field] = m[field];
  return out as Partial<PluginManifest>;
}

async function packageFiles(id: string): Promise<Record<string, Uint8Array> | null> {
  let files = filesCache.get(id);
  if (files) return files;
  const bytes = await pluginPackage(id);
  if (!bytes) return null;
  filesCache.set(id, files = readPackage(bytes));
  return files;
}

function add(record: PluginRecord) {
  const id = record.plugin.manifest.id;
  const hadBots = records().some((existing) => existing.plugin.manifest.id === id && Object.keys(existing.plugin.bots ?? {}).length > 0);
  const hasBots = Object.keys(record.plugin.bots ?? {}).length > 0;
  setRecords((list) => [
    ...list.filter((r) => r.plugin.manifest.id !== id),
    record,
  ]);
  if (hadBots || hasBots) notifyBotContributionChange();
}

function notifyBotContributionChange(): void {
  for (const listener of botContributionListeners) listener();
}

async function evaluate(source: string): Promise<ClientPlugin> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = await import(/* @vite-ignore */ url);
    return checked(module.default);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const pluginId = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const typeId = /^[a-z_][a-z0-9_]{0,62}$/;
const columnId = (name: string) => typeId.test(name) && !["__proto__", "constructor", "prototype"].includes(name);

function checked(plugin: unknown): ClientPlugin {
  const p = plugin as ClientPlugin;
  const m = p?.manifest;
  const fail = (problem: string) => {
    throw new Error(`Invalid plugin${m?.id ? ` '${m.id}'` : ""}: ${problem}`);
  };
  if (typeof p !== "object" || p === null) fail("the module must export a plugin object as default");
  if (typeof m !== "object" || m === null) fail("missing manifest");
  if (typeof m.id !== "string" || !pluginId.test(m.id)) fail("manifest.id must be a-z, 0-9, '.', '-'");
  if (typeof m.name !== "string" || !m.name) fail("manifest.name is required");
  if (typeof m.version !== "string" || !m.version) fail("manifest.version is required");
  for (const type of m.contributes?.channelTypes ?? [])
    if (!typeId.test(type?.id) || typeof type.label !== "string") fail(`channel type '${type?.id}' needs a plugin-style id and a label`);
  for (const [type, view] of Object.entries(p.channelViews ?? {}))
    if (typeof view !== "function") fail(`channelViews.${type} must be a function`);
  for (const [id, viewer] of Object.entries(p.viewers ?? {}))
    if (typeof viewer !== "function") fail(`viewers.${id} must be a function`);
  for (const info of m.contributes?.viewers ?? [])
    if (typeof info?.id !== "string" || typeof info.label !== "string") fail("each viewer needs an id and a label");
  return p;
}

// A manifest after manifest.json's fields were merged in: the identity fields, and the declared data tables.
function checkedManifest(manifest: PluginManifest): PluginManifest {
  const fail = (problem: string) => {
    throw new Error(`Invalid plugin '${manifest.id}': ${problem}`);
  };
  if (!pluginId.test(manifest.id)) fail("manifest.id must be a-z, 0-9, '.', '-'");
  if (typeof manifest.name !== "string" || !manifest.name) fail("manifest.name is required");
  if (typeof manifest.version !== "string" || !manifest.version) fail("manifest.version is required");
  if (manifest.minApp !== undefined && typeof manifest.minApp !== "string") fail("manifest.minApp must be a version.");
  const dataName = dataNameOf(manifest);
  if (serverPlugins.some((p) => p.manifest.name === dataName))
    fail(`data name '${dataName}' is a built-in system plugin`);
  if (manifest.data !== undefined) {
    if (typeof manifest.data !== "object" || manifest.data === null || Array.isArray(manifest.data))
      fail("manifest.data must be an object.");
    if (manifest.data.type !== undefined && (typeof manifest.data.type !== "string" || !typeId.test(manifest.data.type)))
      fail("manifest.data.type must be a channel type id.");
    if (typeof manifest.data.tables !== "object" || manifest.data.tables === null || Array.isArray(manifest.data.tables))
      fail("manifest.data.tables must be an object.");
    if (Object.keys(manifest.data.tables).length === 0) fail("manifest.data.tables must declare at least one table.");
  }
  const tablePrefix = `${dataName}_`;
  for (const [table, info] of Object.entries(manifest.data?.tables ?? {})) {
    if (!tableName.test(table) || !table.startsWith(tablePrefix))
      fail(`data table '${table}' must start with the plugin's data name '${tablePrefix}'`);
    if (typeof info !== "object" || info === null) fail(`data table '${table}' needs a description`);
    if (typeof info.columns !== "object" || info.columns === null || Array.isArray(info.columns))
      fail(`data table '${table}' needs a columns object`);
    if (info.channel !== undefined && typeof info.channel !== "boolean") fail(`data table '${table}' channel must be true or false`);
    if (info.owned !== undefined && typeof info.owned !== "boolean") fail(`data table '${table}' owned must be true or false`);
    for (const [column, type] of Object.entries(info.columns ?? {}))
      if (!columnId(column) || !["text", "integer", "real", "bool", "json", "user"].includes(type))
        fail(`data table '${table}' column '${column}' has an unknown type`);
    if (info.authored !== undefined && (typeof info.authored !== "string" || !Object.hasOwn(info.columns, info.authored)))
      fail(`data table '${table}' authored must name one of its columns`);
    if (typeof info.authored === "string" && info.columns[info.authored] !== "user" && info.columns[info.authored] !== "integer")
      fail(`data table '${table}' authored must be a user id column`);
    if (info.channel && Object.hasOwn(info.columns, "channel_id") && info.columns.channel_id !== "integer" && info.columns.channel_id !== "user")
      fail(`data table '${table}' channel_id must be an integer or user column`);
  }
  return manifest;
}

// Whether the app's version is at least the plugin's minApp; only major.minor.patch is compared.
function appAtLeast(minApp: string): boolean {
  const want = versionParts(minApp);
  const have = versionParts(appVersion);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  }
  return true;
}

function versionParts(version: string): number[] {
  return version.trim().split(".").map((part) => Number(/^\d*/.exec(part)?.[0]) || 0);
}

export function comparePluginVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (!match) throw new Error(`Cannot compare plugin version '${version}'. Use numeric version parts, such as 1.2.3.`);
    return { parts: match[1].split(".").map(Number), prerelease: match[2]?.split(".") ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNumber = /^\d+$/.test(l);
    const rNumber = /^\d+$/.test(r);
    if (lNumber && rNumber) return Math.sign(Number(l) - Number(r));
    if (lNumber !== rNumber) return lNumber ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A copy, so digest gets a view of a plain ArrayBuffer (typed arrays of the call may be shared otherwise).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const bytesOf = (bytes: Uint8Array | ArrayBuffer): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

const assetMime: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  json: "application/json", js: "text/javascript", mjs: "text/javascript", css: "text/css", html: "text/html", txt: "text/plain",
};

function mimeOf(path: string): string {
  return assetMime[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

createRoot(() => {
  createEffect(() => {
    const list = enabled();
    setPluginThemes(list.flatMap((p) => p.manifest.contributes?.themes ?? []));
    for (const p of list)
      for (const [id, icons] of Object.entries(p.manifest.contributes?.iconSets ?? {}))
        registerIconSet(id, Object.fromEntries(Object.entries(icons).filter(([, url]) => isSvgDataUrl(url))) as Record<IconName, string>);
  });
});

export function isSvgDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/svg+xml") && !/["\\\n\r]/.test(value);
}