// Builds Brave's ad block engine (adblock-rust) from the lists Brave turns on by default, in a utility process so the
// app doesn't stall while it parses them. Sends back the serialized engine and the resources its rules use, put
// together like Brave's build does (brave-core-crx-packager, adBlockRustUtils.js): uBlock Origin's scriptlets and
// redirect resources from its latest release, then Brave's own. Brave's resources.json alone lacks uBlock's
// scriptlets, so rules like YouTube's json-prune matched but had nothing to run.
const { Engine, FilterSet, uBlockResources } = require("adblock-rs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const catalogUrl = "https://raw.githubusercontent.com/brave/adblock-resources/master/filter_lists/list_catalog.json";
const resourcesUrl = "https://raw.githubusercontent.com/brave/adblock-resources/master/dist/resources.json";
// Lists for Brave's phone apps only.
const phoneOnly = /ios-specific|android-specific/i;

async function text(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function latestUblock() {
  const response = await fetch("https://api.github.com/repos/gorhill/uBlock/releases/latest").catch(() => null);
  const tag = response?.ok ? (await response.json()).tag_name : null;
  return `https://raw.githubusercontent.com/gorhill/uBlock/${tag ?? "master"}/`;
}

// Downloads a module and every module it imports (relative paths), keeping the repository's layout under `root`.
async function fetchModules(base, file, root, seen = new Set()) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = await text(base + file);
  await fs.mkdir(path.join(root, path.dirname(file)), { recursive: true });
  await fs.writeFile(path.join(root, file), source);
  const imports = [...source.matchAll(/(?:import|export)\s[^'"]*?['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
  imports.push(...[...source.matchAll(/^import\s+['"](\.{1,2}\/[^'"]+)['"]/gm)].map((m) => m[1]));
  await Promise.all(imports.map((relative) => fetchModules(base, path.posix.join(path.posix.dirname(file), relative), root, seen)));
}

async function ublockResources(root) {
  const base = await latestUblock();
  await fetchModules(base, "src/js/resources/scriptlets.js", root);
  const { builtinScriptlets } = await import(pathToFileURL(path.join(root, "src/js/resources/scriptlets.js")).href);
  const scriptlets = builtinScriptlets.map((s) => ({
    name: s.name,
    aliases: s.aliases ?? [],
    kind: { mime: "application/javascript" },
    content: Buffer.from(s.fn.toString()).toString("base64"),
    dependencies: s.dependencies ?? [],
  }));
  // Redirect resources (a script that does nothing, a blank image...), for rules with $redirect.
  let redirects = [];
  try {
    await fetchModules(base, "src/js/redirect-resources.js", root);
    const { default: map } = await import(pathToFileURL(path.join(root, "src/js/redirect-resources.js")).href);
    const warDir = path.join(root, "src/web_accessible_resources");
    await fs.mkdir(warDir, { recursive: true });
    await Promise.all([...map.entries()].filter(([, props]) => !props.params).map(async ([name]) => {
      const response = await fetch(`${base}src/web_accessible_resources/${name}`);
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      await fs.writeFile(path.join(warDir, name), Buffer.from(await response.arrayBuffer()));
    }));
    redirects = uBlockResources(warDir, path.join(root, "src/js/redirect-resources.js")).filter((r) => r.name !== "google-ima-dai.js");
  } catch (e) {
    console.warn(`Ad block redirect resources skipped: ${e.message}`);
  }
  return { redirects, scriptlets };
}

async function build() {
  const catalog = JSON.parse(await text(catalogUrl));
  const urls = catalog.filter((list) => list.default_enabled)
    .flatMap((list) => (list.sources ?? []).map((source) => source.url))
    .filter((url) => url && !phoneOnly.test(url));
  const lists = await Promise.all(urls.map((url) => text(url).catch((e) => {
    console.warn(`Ad block list skipped: ${e.message}`);
    return "";
  })));
  if (!lists.some(Boolean)) throw new Error("no filter list could be downloaded");
  const filters = new FilterSet(false);
  for (const list of lists) if (list) filters.addFilters(list);
  const engine = new Engine(filters);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "makework-ublock-"));
  try {
    const { redirects, scriptlets } = await ublockResources(root);
    const resources = [...redirects, ...JSON.parse(await text(resourcesUrl)), ...scriptlets];
    return { engine: engine.serialize(), resources: JSON.stringify(resources), lists: lists.filter(Boolean).length };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

build().then(
  (result) => process.parentPort.postMessage({ ok: true, ...result }),
  (e) => process.parentPort.postMessage({ ok: false, error: e.message }),
);
