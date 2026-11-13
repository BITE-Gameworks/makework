// Packs one plugin folder into a .mwp: a zip of manifest.json, the client script, an optional icon.svg and
// assets/. The app reads this package as-is, so the manifest is written on top of the folder's manifest.json
// with only minApp added when it is missing (from the app package version). Usage:
//   node scripts/pack-plugin.mjs <folder> <out.mwp>
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const appVersion = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
).version;

// Packs the plugin in `folder` to `out` (a .mwp path; ".mwp" is appended when missing). The zip keeps the
// folder's manifest.json with minApp added unless present, client.js, icon.svg and assets/.
export async function packPlugin(folderArg, outArg) {
  let folder = folderArg;
  while (folder.endsWith("/")) folder = folder.slice(0, -1);
  const out = outArg.endsWith(".mwp") ? outArg : `${outArg}.mwp`;

  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  if (manifest.minApp === undefined) manifest.minApp = appVersion;
  const clientPath = String(manifest.client ?? "client.js");

  const files = { "manifest.json": strToU8(JSON.stringify(manifest, null, 2)) };
  async function add(path, optional = false) {
    try {
      files[path] = new Uint8Array(await readFile(join(folder, ...path.split("/"))));
    } catch (error) {
      if (optional && error.code === "ENOENT") return;
      if (path === clientPath && error.code === "ENOENT") throw new Error(`'${folder}' has no ${clientPath}.`);
      throw error;
    }
  }
  await add(clientPath);
  await add("icon.svg", true);

  // assets/ and everything under it, kept at the same relative paths in the zip.
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && dir === join(folder, "assets")) return;
      throw error;
    }
    for (const entry of entries) {
      const path = relative(folder, join(dir, entry.name)).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (entry.isFile()) files[path] = new Uint8Array(await readFile(join(dir, entry.name)));
    }
  };
  await walk(join(folder, "assets"));

  const bytes = zipSync(files, { level: 6 });
  await writeFile(out, bytes);
  return { id: manifest.id, version: manifest.version, minApp: manifest.minApp, bytes: bytes.length };
}

// Standalone: node scripts/pack-plugin.mjs <folder> <out.mwp>
if (process.argv[1]?.endsWith("pack-plugin.mjs")) {
  const [, , folder, out] = process.argv;
  if (!folder || !out) {
    console.error("Usage: node scripts/pack-plugin.mjs <folder> <out.mwp>");
    process.exit(1);
  }
  const packed = await packPlugin(folder, out);
  console.log(`Wrote ${out} (${packed.bytes} bytes) for ${packed.id} v${packed.version}, minApp ${packed.minApp}.`);
}