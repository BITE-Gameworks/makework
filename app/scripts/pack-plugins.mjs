// Packs every example plugin folder (repo examples/plugins/*/) into a <name>.mwp beside it, for testing the
// .mwp format and the install flow. Run from the repo root: node app/scripts/pack-plugins.mjs
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "./pack-plugin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginsRoot = join(here, "../../examples/plugins");

const folders = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && !e.name.startsWith("."))
  .map((e) => e.name);
if (folders.length === 0) {
  console.error("No plugin folders found under examples/plugins/.");
  process.exit(1);
}

for (const name of folders) {
  const { id, bytes, version, minApp } = await packPlugin(join(pluginsRoot, name), join(pluginsRoot, name));
  console.log(`Wrote ${name}.mwp (${bytes} bytes) for ${id} v${version}, minApp ${minApp}.`);
}