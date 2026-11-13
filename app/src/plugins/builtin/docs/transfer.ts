// Importing .md files into a docs channel and exporting its pages, with the images they show.
// Import: every .md file found (in picked files, folders or .zip files) becomes a page; folders become pages holding
// their pages, and Title.md next to a Title/ folder are one page, like the ~/MakeWork mirror (disk.ts). Images a
// page links to by relative path are uploaded when they were imported too.
// Export: the chosen pages as Title.md files, sub-pages in Title/ folders, images in _assets/ with links rewritten.
import { strToU8, unzipSync, zipSync } from "fflate";
import type { PluginClient } from "../../../api/client";
import { storedBlob } from "../../../core/content";
import { prepareUpload } from "../../../core/files";
import { sniffExtension } from "../../../core/fileNames";
import { saveBlob } from "../../../ui/download";
import type { UploadTree } from "../files/folders";
import { addPage, type DocPage } from "./data";

export interface ImportEntry {
  path: string[];
  file: File;
}

export interface ImportPage {
  title: string;
  // The .md file and where it was; none for a folder without its own Title.md.
  file?: File;
  path?: string[];
  children: ImportPage[];
}

const assets = "_assets";
const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);
const byName = (a: ImportPage, b: ImportPage) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });

// Picked or dropped files (folders in the tree) as a flat list of paths.
export function entriesOf(tree: UploadTree, path: string[] = []): ImportEntry[] {
  return [
    ...tree.files.map((file) => ({ path: [...path, file.name], file })),
    ...tree.folders.flatMap((folder) => entriesOf(folder, [...path, folder.name])),
  ];
}

// .zip files replaced by what is in them, at the zip's place.
export async function expandZips(entries: ImportEntry[]): Promise<ImportEntry[]> {
  const out: ImportEntry[] = [];
  for (const entry of entries) {
    if (!/\.zip$/i.test(entry.file.name)) {
      out.push(entry);
      continue;
    }
    const files = unzipSync(new Uint8Array(await entry.file.arrayBuffer()));
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
      const parts = name.split("/").filter(Boolean);
      out.push({ path: [...entry.path.slice(0, -1), ...parts], file: new File([bytes as BlobPart], parts.at(-1)!) });
    }
  }
  return out;
}

interface Folder {
  name: string;
  files: ImportEntry[];
  folders: Map<string, Folder>;
}

// The pages to make from the imported files.
export function importTree(entries: ImportEntry[]): ImportPage[] {
  // Everything in one top-level folder (a picked folder): its contents are the top level.
  let strip = 0;
  while (entries.length && entries.every((e) => e.path.length > strip + 1 && e.path[strip] === entries[0].path[strip])) strip++;
  const root: Folder = { name: "", files: [], folders: new Map() };
  for (const entry of entries) {
    const path = entry.path.slice(strip);
    let at = root;
    for (const name of path.slice(0, -1)) {
      const key = name.toLowerCase();
      if (!at.folders.has(key)) at.folders.set(key, { name, files: [], folders: new Map() });
      at = at.folders.get(key)!;
    }
    at.files.push(entry);
  }
  const hasPages = (f: Folder): boolean => f.files.some((e) => isMarkdown(e.file.name)) || [...f.folders.values()].some(hasPages);
  const pagesIn = (f: Folder): ImportPage[] => {
    const pages: ImportPage[] = [];
    const used = new Set<string>();
    for (const entry of f.files.filter((e) => isMarkdown(e.file.name))) {
      const title = entry.file.name.replace(/\.(md|markdown)$/i, "");
      const folder = f.folders.get(title.toLowerCase());
      if (folder) used.add(title.toLowerCase());
      pages.push({ title, file: entry.file, path: entry.path, children: folder ? pagesIn(folder) : [] });
    }
    for (const [key, folder] of f.folders)
      if (!used.has(key) && key !== assets && hasPages(folder)) pages.push({ title: folder.name, children: pagesIn(folder) });
    return pages.sort(byName);
  };
  return pagesIn(root);
}

export const pageCount = (pages: ImportPage[]): number => pages.reduce((n, p) => n + 1 + pageCount(p.children), 0);

// ![alt](path "title"), the path also as <path with spaces> (then group 2, else group 3).
const imageLink = /(!\[[^\]]*\]\(\s*)(?:<([^>\n]+)>|([^)\s<>]+))((?:\s+"[^"]*")?\s*\))/g;

// The imported file a link in a page at mdPath points to, by relative path; null for web links and missing files.
export function linkedFile(link: string, mdPath: string[], byPath: Map<string, File>): File | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/") || link.startsWith("#")) return null;
  let parts: string[];
  try {
    parts = decodeURIComponent(link.split(/[?#]/)[0]).split("/");
  } catch {
    return null;
  }
  const path = mdPath.slice(0, -1);
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!path.length) return null;
      path.pop();
    } else path.push(part);
  }
  return byPath.get(path.join("/").toLowerCase()) ?? null;
}

// A page's text with its linked images replaced by refs (`upload` gives one for each file).
export async function withImages(text: string, mdPath: string[], byPath: Map<string, File>, upload: (file: File) => Promise<string>): Promise<string> {
  const refs = new Map<string, string>();
  for (const [, , angled, bare] of text.matchAll(imageLink)) {
    const link = angled ?? bare;
    const file = linkedFile(link, mdPath, byPath);
    if (file && !refs.has(link)) refs.set(link, await upload(file));
  }
  return text.replace(imageLink, (match, start: string, angled: string | undefined, bare: string | undefined, end: string) => {
    const ref = refs.get(angled ?? bare ?? "");
    if (ref === undefined) return match;
    return angled === undefined ? `${start}${ref}${end}` : `${start}<${ref}>${end}`;
  });
}

// Makes the pages under parentId, parents first, and returns their ids in that order.
export async function importPages(api: PluginClient, channelId: number, parentId: number | null, entries: ImportEntry[],
  pages: ImportPage[], onProgress?: (done: number) => void): Promise<number[]> {
  const byPath = new Map(entries.map((e) => [e.path.join("/").toLowerCase(), e.file]));
  const uploads = new Map<File, Promise<string>>();
  const upload = (file: File) => {
    if (!uploads.has(file)) uploads.set(file, prepareUpload(file).then((u) => u.url));
    return uploads.get(file)!;
  };
  const ids: number[] = [];
  const add = async (list: ImportPage[], parent: number | null) => {
    for (const page of list) {
      const raw = page.file ? (await page.file.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n") : "";
      const body = page.file ? await withImages(raw, page.path!, byPath, upload) : "";
      const id = await addPage(api, channelId, parent, page.title.slice(0, 200).trim() || "Untitled", body);
      ids.push(id);
      onProgress?.(ids.length);
      await add(page.children, id);
    }
  };
  await add(pages, parentId);
  return ids;
}

const fileName = (title: string) => title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").trim() || "Untitled";
const mwcRef = /mwc:([a-f0-9]{64})/g;

// The files for the chosen pages: path -> text. Pages that aren't chosen but hold chosen ones give only their
// folder. Images whose hash is in assetNames get `_assets/<name>` links.
export function exportFiles(pages: DocPage[], bodies: Map<number, string>, selected: Set<number>, assetNames = new Map<string, string>()): Record<string, string> {
  const ids = new Set(pages.map((p) => p.id));
  const kids = new Map<number | null, DocPage[]>();
  for (const p of pages) {
    const parent = p.parentId !== null && ids.has(p.parentId) ? p.parentId : p.parentId === null ? null : undefined;
    if (parent !== undefined) kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.z - b.z || a.id - b.id);
  const holds = (id: number): boolean => (kids.get(id) ?? []).some((c) => selected.has(c.id) || holds(c.id));
  const files: Record<string, string> = {};
  const walk = (parent: number | null, folder: string[]) => {
    const used = new Set<string>();
    for (const p of kids.get(parent) ?? []) {
      if (!selected.has(p.id) && !holds(p.id)) continue;
      let name = fileName(p.title);
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${fileName(p.title)} (${n})`;
      used.add(name.toLowerCase());
      if (selected.has(p.id)) {
        const up = "../".repeat(folder.length);
        files[[...folder, `${name}.md`].join("/")] = (bodies.get(p.id) ?? "").replace(mwcRef, (match, hash: string) =>
          assetNames.has(hash) ? `${up}${assets}/${encodeURIComponent(assetNames.get(hash)!)}` : match);
      }
      if (holds(p.id)) walk(p.id, [...folder, name]);
    }
  };
  walk(null, []);
  return files;
}

// Saves the chosen pages: one page without images as Title.md, else a .zip with _assets/. Returns how many images
// weren't on this device (their links stay mwc: refs).
export async function saveExport(pages: DocPage[], bodies: Map<number, string>, selected: Set<number>, zipName: string): Promise<number> {
  const hashes = new Set<string>();
  for (const id of selected) for (const [, hash] of (bodies.get(id) ?? "").matchAll(mwcRef)) hashes.add(hash);
  const blobs = new Map<string, Blob>();
  const assetNames = new Map<string, string>();
  let missing = 0;
  for (const hash of hashes) {
    const blob = await storedBlob(hash).catch(() => null);
    if (!blob) {
      missing++;
      continue;
    }
    blobs.set(hash, blob);
    assetNames.set(hash, `${hash.slice(0, 12)}${sniffExtension(new Uint8Array(await blob.slice(0, 64).arrayBuffer()))}`);
  }
  const files = exportFiles(pages, bodies, selected, assetNames);
  const paths = Object.keys(files);
  if (paths.length === 1 && !paths[0].includes("/") && blobs.size === 0) {
    saveBlob(new Blob([files[paths[0]]], { type: "text/markdown" }), paths[0]);
    return missing;
  }
  const zip: Record<string, Uint8Array> = Object.fromEntries(paths.map((p) => [p, strToU8(files[p])]));
  for (const [hash, blob] of blobs) zip[`${assets}/${assetNames.get(hash)}`] = new Uint8Array(await blob.arrayBuffer());
  saveBlob(new Blob([zipSync(zip) as BlobPart], { type: "application/zip" }), `${fileName(zipName)}.zip`);
  return missing;
}
