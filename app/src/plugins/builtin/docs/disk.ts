// A docs channel on disk: each page as Title.md, its sub-pages in a Title/ folder next to it, and the images
// pages show in _assets/ (links rewritten to point there). Pages edited on disk are merged into the page's live
// text like typing; new .md files become pages, moved or renamed ones move or rename their page.
import { decodeEmoji } from "../../../markdown/emoji";
import { suffixedName, withExtension } from "../../../core/fileNames";
import { parseLink } from "../../../core/links";
import { livingRows, sha256Text, treePaths } from "../../../p2p/diskView";
import type { JsonRow } from "../../../system/data";
import type { DiskContext, DiskEntry, DiskLayout } from "../../types";
import { openPageText } from "./collab";
import { addPage, movePage, removePages, updatePage } from "./data";

const assets = "_assets";
const imageRef = /(!\[([^\]]*)\]\()?mwc:([a-f0-9]{64})/g;
const key = (path: string[]) => path.join("/").toLowerCase();
const byZ = (a: JsonRow, b: JsonRow) => Number(a.z) - Number(b.z) || a.id - b.id;

// Pages, where each one's file is, and its text on disk (which also names the images).
async function layout(context: DiskContext) {
  const { rows, kept, fileExtension, name, exportFile } = context;
  const assetFolder = name([], "assets", assets);
  const pages = livingRows(rows("docs", "docs_pages")).sort(byZ);
  const paths = treePaths(pages, name, (p) => String(p.title || "Untitled"));
  const fileOf = (page: JsonRow) => {
    const path = paths.get(page.id)!;
    return [...path.slice(0, -1), `${path.at(-1)}.md`];
  };
  const assetHashes = new Map<string, string>();
  const exportRefs = new Map<string, string>();
  const keptAssets = new Map<string, string>();
  const exportAssets = new Map<string, { file: string; text: string }>();
  const texts = new Map<number, string>();
  for (const page of pages) {
    const up = "../".repeat(paths.get(page.id)!.length - 1);
    let text = decodeEmoji(String(page.body ?? "")).replace(imageRef, (_match, link: string | undefined, alt: string | undefined, hash: string) => {
      const file = name([assetFolder], `hash:${hash}`, withExtension(alt?.trim() || "image", fileExtension(hash)));
      assetHashes.set(file.toLowerCase(), hash);
      if (kept(`mwc:${hash}`)) keptAssets.set(hash, file);
      return `${link ?? ""}${`${up}${assetFolder}/${file}`.split("/").map(encodeURIComponent).join("/")}`;
    });
    const embeds = [...text.matchAll(/!\[([^\]]*)\]\((makework:\/\/[^)\s]+)\)/g)];
    for (const embed of embeds.toReversed()) {
      const [, alt, url] = embed;
      const ref = parseLink(url);
      if (ref?.target?.kind !== "export" || !exportFile) continue;
      const file = await exportFile(url, "svg");
      if (!file) continue;
      const path = name([assetFolder], `export:${url}`, withExtension(file.name, ".svg"));
      const svg = await file.blob.text();
      exportAssets.set(path.toLowerCase(), { file: path, text: svg });
      exportRefs.set(path.toLowerCase(), url);
      const link = `![${alt}](${`${up}${assetFolder}/${path}`.split("/").map(encodeURIComponent).join("/")})`;
      text = `${text.slice(0, embed.index)}${link}${text.slice(embed.index! + embed[0].length)}`;
    }
    texts.set(page.id, text);
  }
  // Links to known images or exports back to their original MakeWork references.
  const assetLink = new RegExp(String.raw`(?:\.\./)*${encodeURIComponent(assetFolder).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}/([^)\s]+)`, "g");
  const fromDisk = (text: string) => text.replaceAll("\r\n", "\n").replace(assetLink, (match, file: string) => {
    const decoded = decodeURIComponent(file).toLowerCase();
    const hash = assetHashes.get(decoded);
    return hash ? `mwc:${hash}` : exportRefs.get(decoded) ?? match;
  });
  return { assetFolder, pages, paths, fileOf, texts, keptAssets, exportAssets, fromDisk };
}

export const docsDisk: DiskLayout = {
  async entries(context) {
    const { assetFolder, pages, fileOf, texts, keptAssets, exportAssets } = await layout(context);
    const result: DiskEntry[] = pages.map((page) => ({ path: fileOf(page), text: texts.get(page.id)! }));
    for (const [hash, file] of keptAssets) result.push({ path: [assetFolder, file], hash });
    for (const { file, text } of exportAssets.values()) result.push({ path: [assetFolder, file], text });
    return result;
  },

  async apply(changes, context) {
    const api = context.api("docs");
    const channelId = context.channel.id;
    const { assetFolder, pages, paths, fileOf, texts, fromDisk } = await layout(context);
    const byFile = new Map(pages.map((p) => [key(fileOf(p)), p]));
    const byFolder = new Map(pages.map((p) => [key(paths.get(p.id)!), p]));
    const titleOf = (path: string[]) => path.at(-1)!.replace(/\.md$/i, "");

    // The page a folder stands for, made (with its parents) when there is none.
    const parentOf = async (folder: string[]): Promise<number | null> => {
      let parent: number | null = null;
      for (let i = 1; i <= folder.length; i++) {
        const found = byFolder.get(key(folder.slice(0, i)));
        if (found) parent = found.id;
        else {
          const id: number = await addPage(api, channelId, parent, folder[i - 1]);
          byFolder.set(key(folder.slice(0, i)), { id, parent_id: parent });
          parent = id;
        }
      }
      return parent;
    };
    const setText = async (page: JsonRow, next: string) => {
      const text = openPageText(api, page.id, async () => decodeEmoji(String(page.body ?? "")), {
        caretOf: () => undefined, onError: (e) => { throw e; },
      });
      await text.ready;
      text.edit(next);
      await text.close();
    };

    for (const change of changes) {
      if (change.path[0]?.toLowerCase() === assetFolder.toLowerCase() || !/\.md$/i.test(change.path.at(-1)!)) continue;
      try {
        if (change.text === undefined) throw new Error("Too big to read as a page.");
        const next = fromDisk(change.text);
        const page = byFile.get(key(change.kind === "moved" ? change.from! : change.path));
        if (!page) {
          await addPage(api, channelId, await parentOf(change.path.slice(0, -1)), titleOf(change.path), next);
        } else if (change.kind === "moved") {
          const parent = await parentOf(change.path.slice(0, -1));
          if (parent !== (page.parent_id ?? null)) {
            const z = Math.max(0, ...pages.filter((p) => (p.parent_id ?? null) === parent).map((p) => Number(p.z))) + 1;
            await movePage(api, page.id, parent, z);
          }
          if (titleOf(change.path) !== titleOf(change.from!)) await updatePage(api, page.id, { title: titleOf(change.path) });
        } else if (next !== fromDisk(texts.get(page.id)!)) {
          const unchangedInApp = !change.base || change.base === `text:${await sha256Text(texts.get(page.id)!)}`;
          if (unchangedInApp) await setText(page, next);
          else {
            // Edited in the app too since it was written here: the disk version becomes a page of its own.
            const title = suffixedName(decodeEmoji(String(page.title || "Untitled")), "conflict");
            const id = await addPage(api, channelId, page.parent_id == null ? null : Number(page.parent_id), title, next);
            const folder = change.path.slice(0, -1);
            await context.adopt(change, [...folder, `${context.name(folder, `row:${id}`, title)}.md`], true);
            continue;
          }
        }
        await context.adopt(change, undefined, true);
      } catch (e) {
        context.problem(change, (e as Error).message);
      }
    }
  },

  async removal(changes, context) {
    const { pages, fileOf } = await layout(context);
    const byFile = new Map(pages.map((p) => [key(fileOf(p)), p]));
    const gone = changes.map((c) => byFile.get(key(c.path))).filter((p): p is JsonRow => !!p);
    if (!gone.length) return null;
    return {
      what: gone.length === 1 ? `The page "${decodeEmoji(String(gone[0].title))}" was` : `${gone.length} pages were`,
      remove: async () => void (await removePages(context.api("docs"), gone.map((p) => p.id))),
    };
  },
};
