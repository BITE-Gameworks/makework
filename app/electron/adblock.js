// Brave's ad blocking for browser channels: adblock-rust with Brave's default lists. Network requests are checked
// before they leave; each frame's preload (browserPreload.cjs) gets its cosmetic filters and scriptlets at once, before
// the page's own scripts run (YouTube's ads are removed by scriptlets, which are useless once the player started).
import { app, ipcMain, utilityProcess } from "electron";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
// Brave updates its lists many times a day; YouTube changes often.
const maxAgeMs = 24 * 60 * 60 * 1000;

let engine = null;
let building = false;
// Why there is no engine: null while it may still come, else a reason shown in the browser view.
let unavailable = null;
let markReady;
const ready = new Promise((resolve) => (markReady = resolve));
// Pages wait this long for the engine: a page that starts without its scriptlets keeps its ads (YouTube never
// reloads while you browse it). Never when it can't come: every page and request would be 5 s late.
const waitMs = 5000;
const engineReady = () =>
  engine || unavailable ? Promise.resolve() : Promise.race([ready, new Promise((r) => setTimeout(r, waitMs))]);

function giveUp(reason) {
  if (engine) return;
  unavailable = reason;
  console.warn(`Ad blocking unavailable: ${reason}`);
  markReady();
}

// adblock-rs is built with Rust when it is installed; an optional dependency, so it is missing where that failed.
function blockerModule() {
  try {
    return require("adblock-rs");
  } catch {
    giveUp("adblock-rs isn't built here, it needs Rust (see README.md)");
    return null;
  }
}

// Bumped when what the cache holds changes, so engines built the old way are built again (2: uBlock's scriptlets).
const cacheVersion = 2;
const cacheDir = () => path.join(app.getPath("userData"), `adblock-v${cacheVersion}`);

function load(serialized, resources) {
  const module = blockerModule();
  if (!module) return;
  const { Engine, FilterSet } = module;
  const next = new Engine(new FilterSet(false));
  next.deserialize(serialized);
  next.useResources(JSON.parse(resources));
  engine = next;
  unavailable = null;
  markReady();
}

function rebuild() {
  if (building || !blockerModule()) return;
  building = true;
  const child = utilityProcess.fork(path.join(here, "adblockBuild.cjs"), [], { serviceName: "MakeWork ad block lists", stdio: "pipe" });
  child.stdout?.on("data", (data) => console.log(`Ad block builder: ${data.toString()}`));
  child.stderr?.on("data", (data) => console.error(`Ad block builder error: ${data.toString()}`));
  child.on("error", (error) => console.error("Ad block utility process error:", error));
  child.on("message", async (result) => {
    building = false;
    child.kill();
    if (!result.ok) {
      giveUp(`the filter lists couldn't be downloaded (${result.error})`);
      return;
    }
    try {
      load(result.engine, result.resources);
      await fs.mkdir(cacheDir(), { recursive: true });
      await fs.writeFile(path.join(cacheDir(), "engine.dat"), Buffer.from(result.engine));
      await fs.writeFile(path.join(cacheDir(), "resources.json"), result.resources);
      console.info(`Ad blocking: ${result.lists} lists loaded`);
    } catch (e) {
      console.warn(`Ad blocking: ${e.message}`);
    }
  });
  child.on("exit", (code) => {
    if (building && code) giveUp(`building the filters failed (exit code ${code})`);
    building = false;
  });
}

let loading = null;

// The kept engine, loaded at app start so browser channels opened right away (kept views) are covered.
export function loadKeptEngine() {
  loading ??= loadKept();
  return loading;
}

async function loadKept() {
  // Left by older builds (the first engine, Ghostery's).
  await fs.rm(path.join(app.getPath("userData"), "adblock"), { recursive: true, force: true });
  await fs.rm(path.join(app.getPath("userData"), "adblock-engine.bin"), { force: true });
  const file = path.join(cacheDir(), "engine.dat");
  const stat = await fs.stat(file).catch(() => null);
  if (stat) {
    try {
      const data = await fs.readFile(file);
      load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), await fs.readFile(path.join(cacheDir(), "resources.json"), "utf8"));
    } catch (e) {
      console.warn(`Ad blocking: kept engine unreadable: ${e.message}`);
    }
  }
  return stat;
}

// Builds a new engine in the background when there is none or it is a day old.
export async function startAdblock() {
  const stat = await loadKeptEngine();
  if (!engine || !stat || Date.now() - stat.mtimeMs > maxAgeMs) rebuild();
}

const requestTypes = {
  subFrame: "sub_frame", stylesheet: "stylesheet", script: "script", image: "image", font: "font", object: "object",
  xhr: "xmlhttprequest", ping: "ping", cspReport: "csp_report", media: "media", webSocket: "websocket", other: "other",
};

// For session.webRequest.onBeforeRequest. Pages themselves are never blocked.
export function checkRequest(details, callback) {
  if (!engine && requestTypes[details.resourceType]) return void engineReady().then(() => decide(details, callback));
  decide(details, callback);
}

function decide(details, callback) {
  const type = requestTypes[details.resourceType];
  if (!engine || !type) return callback({});
  let source = details.referrer;
  try {
    source = details.frame?.top?.url || details.frame?.url || source;
  } catch {
    // The frame is gone.
  }
  try {
    const result = engine.check(details.url, source || details.url, type, details.method || "", true);
    if (result.redirect) return callback({ redirectURL: result.redirect });
    if (result.rewritten_url) return callback({ redirectURL: result.rewritten_url });
    return callback(result.should_block ? { cancel: true } : {});
  } catch {
    return callback({});
  }
}

// Answers the browser preload, only for frames of the browser session.
export function answerFrames(isBrowserFrame) {
  ipcMain.handle("browser:adblock", () => (engine ? "on" : unavailable ? `off: ${unavailable}` : "starting"));
  // The frame waits for the answer (a sync message), which may come once the engine is loaded.
  ipcMain.on("browser:cosmetics", async (event, url) => {
    if (isBrowserFrame(event.sender)) await engineReady();
    if (!engine || !isBrowserFrame(event.sender) || typeof url !== "string" || !/^https?:/i.test(url)) {
      event.returnValue = null;
      return;
    }
    try {
      const found = engine.urlCosmeticResources(url);
      event.returnValue = {
        hide: found.hide_selectors ?? [],
        exceptions: found.exceptions ?? [],
        script: found.injected_script ?? "",
        generic: !found.generichide,
      };
    } catch {
      event.returnValue = null;
    }
  });
  ipcMain.handle("browser:hidden-selectors", (event, classes, ids, exceptions) => {
    if (!engine || !isBrowserFrame(event.sender)) return [];
    const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === "string").slice(0, 2000) : []);
    try {
      return engine.hiddenClassIdSelectors(strings(classes), strings(ids), strings(exceptions));
    } catch {
      return [];
    }
  });
}
