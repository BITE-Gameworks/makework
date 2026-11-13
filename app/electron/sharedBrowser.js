// Web pages in browser channels: a <webview> in the app's window, in its own session (cookies and logins apart
// from the app). Guests get no Node, no preload but the ad blocker's (browserPreload.cjs) and no permissions beyond
// fullscreen; new windows open in place.
// Ads and trackers are blocked like in Brave (adblock.js), so members see the same page instead of each getting their
// own ads.
import { app, ipcMain, net, protocol, session, webContents } from "electron";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { answerFrames, checkRequest, startAdblock } from "./adblock.js";
import { followPublic } from "./webLookup.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const browserPartitionPrefix = "persist:mw-browser-";
const legacyBrowserPartition = "persist:mw-browser";

const browserSessions = new Set();
let adblockFramesReady = false;
let adblockStarted = false;

function isBrowserPartition(partition) {
  return typeof partition === "string" && partition.length <= 512
    && (partition === legacyBrowserPartition || partition.startsWith(browserPartitionPrefix));
}

function isExtensionPartition(partition) {
  return typeof partition === "string" && partition.length <= 512 && partition.startsWith(browserPartitionPrefix);
}

function setUpBrowserSession(partition) {
  if (!isBrowserPartition(partition)) throw new Error("Invalid browser channel partition.");
  const ses = session.fromPartition(partition);
  if (browserSessions.has(ses)) return ses;
  browserSessions.add(ses);
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"));
  ses.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  // Sites refuse sign-in in "embedded" browsers; the app's own name and Electron's are left out of the user agent.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|makework)\/\S+/gi, ""));
  ses.registerPreloadScript({ type: "frame", filePath: path.join(here, "browserPreload.cjs") });
  ses.webRequest.onBeforeRequest(checkRequest);
  ses.webRequest.onCompleted(noteLoaded);
  if (!adblockFramesReady) {
    adblockFramesReady = true;
    answerFrames((contents) => browserSessions.has(contents.session));
  }
  if (!adblockStarted) {
    adblockStarted = true;
    void startAdblock();
  }
  return ses;
}

// Call for the app's window: only http(s) pages in the browser partition may attach, with safe settings.
export function allowSharedBrowser(contents) {
  contents.once("destroyed", () => {
    for (const [guestId, hostId] of domRecordings) if (hostId === contents.id) domRecordings.delete(guestId);
  });
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isBrowserPartition(params.partition) || (params.src && params.src !== "about:blank" && !/^https?:\/\//i.test(params.src))) {
      event.preventDefault();
      return;
    }
    setUpBrowserSession(params.partition);
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  contents.on("did-attach-webview", (_event, guest) => {
    // Keys are played inside every member's copy, and editing commands only act on a focused page: only one window
    // has the system's focus.
    const emulateFocus = () => {
      if (guest.debugger.isAttached()) void guest.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    };
    try {
      guest.debugger.attach("1.3");
      emulateFocus();
    } catch (e) {
      console.warn(`Shared browser: focus emulation unavailable: ${e.message}`);
    }
    // A page from another site runs in a new process, which starts without it.
    guest.on("did-navigate", emulateFocus);
    guest.on("did-frame-finish-load", (_event, isMainFrame) => {
      if (isMainFrame && domRecordings.get(guest.id) === contents.id) guest.send("browser:dom-start");
    });
    guest.once("destroyed", () => {
      domRecordings.delete(guest.id);
      loadedBy.delete(guest.id);
    });
    guest.on("did-navigate", () => loadedBy.delete(guest.id));
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void guest.loadURL(url);
      return { action: "deny" };
    });
    guest.on("will-navigate", (event, url) => {
      if (!/^(https?|about|data|blob):/i.test(url)) event.preventDefault();
    });
  });
}

const extensionIdPattern = /^[a-p]{32}$/;
const maxCrxBytes = 100 * 1024 * 1024;
const maxExtensionFiles = 20_000;
const maxExtensionBytes = 256 * 1024 * 1024;
const installLocks = new Map();
const applyLocks = new Map();

function validExtensionId(id) {
  return typeof id === "string" && extensionIdPattern.test(id);
}

function assertExtensionId(id) {
  if (!validExtensionId(id)) throw new Error("Invalid Chrome extension ID.");
}

function extensionRoot(id) {
  return path.join(app.getPath("userData"), "browser-extensions", id);
}

function extensionMetadata(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || typeof manifest.name !== "string" || !manifest.name.trim()
    || typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error("The extension manifest is invalid.");
  }
  return { name: manifest.name, version: manifest.version };
}

async function cachedExtension(id) {
  const directories = await readdir(extensionRoot(id), { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of directories) {
    if (!entry.isDirectory() || !/^\d+(?:\.\d+){0,3}$/.test(entry.name)) continue;
    try {
      const manifest = extensionMetadata(JSON.parse(await readFile(path.join(extensionRoot(id), entry.name, "manifest.json"), "utf8")));
      if (manifest.version === entry.name) found.push({ ...manifest, dir: path.join(extensionRoot(id), entry.name) });
    } catch {
      // A partial or manually altered cache entry is not an installed extension.
    }
  }
  found.sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
  return found.at(-1) ?? null;
}

function crxZipPayload(bytes) {
  if (bytes.length < 16 || String.fromCodePoint(...bytes.subarray(0, 4)) !== "Cr24") {
    throw new Error("Chrome Web Store returned an invalid CRX file.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  let offset;
  if (version === 2) {
    const publicKeyBytes = view.getUint32(8, true);
    const signatureBytes = view.getUint32(12, true);
    offset = 16 + publicKeyBytes + signatureBytes;
    if (!publicKeyBytes || !signatureBytes) throw new Error("The CRX header is invalid.");
  } else if (version === 3) {
    const headerBytes = view.getUint32(8, true);
    offset = 12 + headerBytes;
    if (!headerBytes) throw new Error("The CRX header is invalid.");
  } else {
    throw new Error(`Unsupported CRX version ${version}.`);
  }
  if (!Number.isSafeInteger(offset) || offset > bytes.length - 4
    || bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) {
    throw new Error("The CRX file has no valid ZIP payload.");
  }
  return bytes.subarray(offset);
}

function safeZipPath(name) {
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\") || path.isAbsolute(name)) {
    throw new Error("The extension ZIP contains an unsafe path.");
  }
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[:*?"<>|]/.test(part))) {
    throw new Error("The extension ZIP contains an unsafe path.");
  }
  return parts;
}

function unpackExtension(zip, destination) {
  let expectedBytes = 0;
  let files = 0;
  const entries = unzipSync(zip, {
    filter(file) {
      const directory = file.name.endsWith("/");
      safeZipPath(directory ? file.name.slice(0, -1) : file.name);
      if (directory) return false;
      if (++files > maxExtensionFiles || !Number.isSafeInteger(file.originalSize) || file.originalSize < 0
        || file.originalSize > maxExtensionBytes || (expectedBytes += file.originalSize) > maxExtensionBytes) {
        throw new Error("The extension ZIP is too large.");
      }
      return true;
    },
  });
  let actualBytes = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const parts = safeZipPath(name);
    if ((actualBytes += bytes.length) > maxExtensionBytes) throw new Error("The extension ZIP is too large.");
    const file = path.join(destination, ...parts);
    if (path.relative(destination, file).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(destination, file))) {
      throw new Error("The extension ZIP contains an unsafe path.");
    }
    // The ZIP has already been fully validated before anything is written.
    entries[name] = bytes;
  }
  return Promise.all(Object.entries(entries).map(async ([name, bytes]) => {
    const file = path.join(destination, ...safeZipPath(name));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }));
}

async function downloadCrx(id) {
  const url = new URL("https://clients2.google.com/service/update2/crx");
  url.searchParams.set("response", "redirect");
  url.searchParams.set("prodversion", process.versions.chrome);
  url.searchParams.set("x", `id=${id}&installsource=ondemand&uc`);
  const response = await net.fetch(url.toString());
  if (!response.ok || new URL(response.url).protocol !== "https:") throw new Error(`Chrome Web Store download failed (${response.status}).`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && (length < 0 || length > maxCrxBytes)) throw new Error("The Chrome Web Store download is too large.");
  if (!response.body) throw new Error("Chrome Web Store returned an empty download.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxCrxBytes) {
      await reader.cancel();
      throw new Error("The Chrome Web Store download is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function loadVerifiedExtension(ses, directory, id) {
  let loaded;
  try {
    loaded = await ses.extensions.loadExtension(directory);
    if (loaded.id !== id) throw new Error("The downloaded extension ID does not match the requested extension.");
    return { id: loaded.id, name: loaded.name, version: loaded.version };
  } finally {
    const loadedId = loaded?.id ?? id;
    if (ses.extensions.getExtension(loadedId)) ses.extensions.removeExtension(loadedId);
  }
}

function serialize(locks, key, work) {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  locks.set(key, next);
  return next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
}

async function installBrowserExtension(id) {
  assertExtensionId(id);
  return serialize(installLocks, id, async () => {
    const cached = await cachedExtension(id);
    if (cached) return { id, name: cached.name, version: cached.version };
    const crx = await downloadCrx(id);
    const zip = crxZipPayload(crx);
    const staging = path.join(extensionRoot(id), `.install-${process.pid}-${Date.now()}`);
    await rm(staging, { recursive: true, force: true });
    try {
      await mkdir(staging, { recursive: true });
      await unpackExtension(zip, staging);
      const manifest = extensionMetadata(JSON.parse(await readFile(path.join(staging, "manifest.json"), "utf8")));
      const verified = await loadVerifiedExtension(setUpBrowserSession(`${browserPartitionPrefix}installer`), staging, id);
      if (verified.version !== manifest.version) throw new Error("The loaded extension version does not match its manifest.");
      const destination = path.join(extensionRoot(id), manifest.version);
      await mkdir(extensionRoot(id), { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      return verified;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

async function applyBrowserExtensions(partition, ids, confirm) {
  if (!isExtensionPartition(partition)) throw new Error("Invalid browser channel partition.");
  if (!Array.isArray(ids) || ids.length > 100 || !ids.every(validExtensionId) || new Set(ids).size !== ids.length) {
    throw new Error("Invalid Chrome extension IDs.");
  }
  return serialize(applyLocks, partition, async () => {
    const installed = await Promise.all(ids.map(async (id) => {
      const cached = await cachedExtension(id);
      if (!cached) throw new Error(`Chrome extension ${id} is not installed locally. Install it first.`);
      return { id, ...cached };
    }));
    const ses = setUpBrowserSession(partition);
    for (const extension of ses.extensions.getAllExtensions()) {
      if (!ids.includes(extension.id)) ses.extensions.removeExtension(extension.id);
    }
    const applied = [];
    let refusal = null;
    for (const extension of installed) {
      const alreadyLoaded = ses.extensions.getExtension(extension.id);
      if (alreadyLoaded) {
        applied.push({ id: alreadyLoaded.id, name: alreadyLoaded.name, version: alreadyLoaded.version });
        continue;
      }
      // Refusing one neither keeps a removed extension nor stops the others.
      try {
        await confirm(partition, extension);
      } catch (e) {
        refusal ??= e;
        continue;
      }
      const loaded = await ses.extensions.loadExtension(extension.dir);
      if (loaded.id !== extension.id || loaded.version !== extension.version) {
        ses.extensions.removeExtension(loaded.id);
        throw new Error(`Cached extension ${extension.id} has unexpected metadata.`);
      }
      applied.push({ id: loaded.id, name: loaded.name, version: loaded.version });
    }
    if (refusal) throw refusal;
    return applied;
  });
}

ipcMain.handle("browser-extensions:install", (_event, id) => installBrowserExtension(id));
// Members with the right permissions choose a channel's extensions, which then see every page opened in it: each
// device's user agrees first. `confirm(event, partition, extension)` rejects otherwise.
let confirmExtension = (_event, _partition, _extension) => { throw new Error("Not set up."); };
export const setExtensionConfirm = (confirm) => { confirmExtension = confirm; };
ipcMain.handle("browser-extensions:apply", (event, partition, ids) =>
  applyBrowserExtensions(partition, ids, (place, extension) => confirmExtension(event, place, extension)));

const short = (value, max) => (typeof value === "string" && value.length <= max ? value : "");
const isolatedWorld = 1077;
const domRecordings = new Map();
const maxDomEvents = 256;
// A full snapshot of a big page (a video site) runs to a few MB and nests a level or two per element.
const maxDomBatchBytes = 8 * 1024 * 1024;
const maxDomDepth = 1024;

function ownGuest(event, guestId) {
  const guest = webContents.fromId(Number(guestId));
  return guest?.getType() === "webview" && guest.hostWebContents === event.sender ? guest : null;
}

// rrweb leaves fields undefined (rootId, isSVG on every node); they drop out when the batch is sent on as JSON.
function isDomValue(value, depth = 0) {
  if (value === undefined) return true;
  if (depth > maxDomDepth || value === null) return value === null;
  if (typeof value === "string") return value.length <= maxDomBatchBytes;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100_000 && value.every((item) => isDomValue(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= 10_000 && entries.every(([key, item]) => key.length <= 1024 && isDomValue(item, depth + 1));
}

function validDomBatch(events) {
  if (!Array.isArray(events) || !events.length || events.length > maxDomEvents) return false;
  if (!events.every((event) => event && Object.getPrototypeOf(event) === Object.prototype
    && Number.isInteger(event.type) && event.type >= 0 && event.type <= 7
    && Number.isFinite(event.timestamp) && isDomValue(event.data))) return false;
  try {
    return JSON.stringify(events).length <= maxDomBatchBytes;
  } catch {
    return false;
  }
}

function stopDomRecording(guest) {
  domRecordings.delete(guest.id);
  if (!guest.isDestroyed()) guest.send("browser:dom-stop");
}

// rrweb's build for the preload's recorder, only for a page being recorded.
let recorderSource = null;
ipcMain.handle("browser:recorder", async (event) => {
  if (event.sender.getType() !== "webview" || !domRecordings.has(event.sender.id)) return null;
  recorderSource ??= await readFile(path.join(here, "..", "node_modules", "rrweb", "dist", "rrweb.umd.min.cjs"), "utf8");
  return recorderSource;
});

// DOM snapshots originate in the isolated browser preload. The window that owns that guest alone can enable them,
// and only its renderer receives them back.
ipcMain.handle("browser:dom-start", (event, guestId) => {
  const guest = ownGuest(event, guestId);
  if (!guest || guest.isDestroyed()) return false;
  domRecordings.set(guest.id, event.sender.id);
  guest.send("browser:dom-start");
  return true;
});

ipcMain.handle("browser:dom-stop", (event, guestId) => {
  const guest = ownGuest(event, guestId);
  if (!guest || domRecordings.get(guest.id) !== event.sender.id) return false;
  stopDomRecording(guest);
  return true;
});

// Resources for the others' mirror (the resource proxy). A viewer's mirror asks for every image and stylesheet
// resource through mwbrowser://<token>/<base64url>: its own connection first, with its own cookies for the channel,
// else the host, whose copy may load what the viewer's can't (logged in, region locked). The host serves only GET
// requests its page made since it last navigated, up to maxProxyBytes each.
const maxProxyBytes = 4 * 1024 * 1024;
const maxLoaded = 5000;
const loadedBy = new Map();
const proxies = new Map();
const proxyOwners = new Set();
const proxyWaits = new Map();
let proxyRequestId = 0;

function noteLoaded(details) {
  if (details.method !== "GET" || !details.webContentsId || !/^https?:/i.test(details.url)) return;
  let loaded = loadedBy.get(details.webContentsId);
  if (!loaded) loadedBy.set(details.webContentsId, (loaded = new Set()));
  if (loaded.size < maxLoaded) loaded.add(details.url);
}

async function readCapped(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxProxyBytes) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

ipcMain.handle("browser:fetch", async (event, guestId, url) => {
  const guest = ownGuest(event, guestId);
  if (!guest || typeof url !== "string" || !loadedBy.get(guest.id)?.has(url)) return null;
  try {
    const response = await guest.session.fetch(url, { cache: "force-cache" });
    return { status: response.status, type: short(response.headers.get("content-type") ?? "", 200), body: await readCapped(response) };
  } catch {
    return null;
  }
});

ipcMain.handle("browser:proxy-register", (event, token, partition) => {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token) || !isBrowserPartition(partition)) return false;
  const owner = event.sender;
  if (!proxyOwners.has(owner.id)) {
    const ownerId = owner.id;
    proxyOwners.add(ownerId);
    owner.once("destroyed", () => {
      proxyOwners.delete(ownerId);
      for (const [key, proxy] of proxies) if (proxy.owner === ownerId) proxies.delete(key);
    });
  }
  proxies.set(token, { owner: owner.id, partition });
  return true;
});

ipcMain.handle("browser:proxy-unregister", (event, token) => {
  if (proxies.get(token)?.owner === event.sender.id) proxies.delete(token);
});

ipcMain.on("browser:proxy-answer", (event, id, answer) => {
  const wait = proxyWaits.get(id);
  if (wait?.owner !== event.sender.id) return;
  proxyWaits.delete(id);
  wait.resolve(answer);
});

function askOwner(owner, token, url) {
  const contents = webContents.fromId(owner);
  if (!contents || contents.isDestroyed()) return Promise.resolve(null);
  const id = ++proxyRequestId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proxyWaits.delete(id);
      resolve(null);
    }, 20_000);
    proxyWaits.set(id, { owner, resolve: (answer) => {
      clearTimeout(timer);
      resolve(answer);
    } });
    contents.send("browser:proxy-need", id, token, url);
  });
}

export function serveBrowserProxy() {
  protocol.handle("mwbrowser", async (request) => {
    const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "max-age=300" };
    const { hostname, pathname } = new URL(request.url);
    const proxy = proxies.get(hostname);
    let url = "";
    try {
      url = Buffer.from(pathname.slice(1), "base64url").toString("utf8");
    } catch {
      // Answered as not found below.
    }
    if (request.method !== "GET" || !proxy || !/^https?:\/\//i.test(url)) return new Response("Not found", { status: 404, headers });
    try {
      // The address comes from the host's page, so this device's own network stays out of reach: the host's copy serves those.
      const ses = setUpBrowserSession(proxy.partition);
      const own = await followPublic((address, init) => ses.fetch(address, init), url, { cache: "force-cache" });
      if (own.ok) {
        const type = own.headers.get("content-type");
        return new Response(own.body, { status: own.status, headers: type ? { ...headers, "Content-Type": type } : headers });
      }
    } catch {
      // Blocked or unreachable from here: the host may reach it.
    }
    const answer = await askOwner(proxy.owner, hostname, url);
    if (!answer || !(answer.body instanceof Uint8Array) || !Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) {
      return new Response("Not found", { status: 404, headers });
    }
    const type = short(answer.type, 200);
    return new Response(answer.body, { status: answer.status, headers: type ? { ...headers, "Content-Type": type } : headers });
  });
}

ipcMain.on("browser:dom-events", (event, events) => {
  const guest = event.sender;
  const hostId = domRecordings.get(guest.id);
  const host = hostId === undefined ? null : webContents.fromId(hostId);
  if (guest.getType() !== "webview" || !host || guest.hostWebContents !== host || !validDomBatch(events)) return;
  host.send("browser:dom-events", guest.id, events);
});

// Points to anchors (kind "at") or anchors to points ("point") on a page being recorded, asked of its preload,
// which alone knows the recorder's node ids.
const anchorWaits = new Map();
let anchorRequestId = 0;
const finite = (n) => typeof n === "number" && Number.isFinite(n);

ipcMain.handle("browser:anchors", (event, guestId, kind, items) => {
  const guest = ownGuest(event, guestId);
  if (!guest || !domRecordings.has(guest.id) || !["at", "point", "media"].includes(kind) || !Array.isArray(items)) return [];
  const clean = items.slice(0, 64).map((item) => kind === "at"
    ? { x: finite(item?.x) ? item.x : 0, y: finite(item?.y) ? item.y : 0 }
    : { id: Number.isInteger(item?.id) ? item.id : 0, fx: finite(item?.fx) ? item.fx : 0, fy: finite(item?.fy) ? item.fy : 0 });
  const id = ++anchorRequestId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      anchorWaits.delete(id);
      resolve([]);
    }, 1000);
    anchorWaits.set(id, { guest: guest.id, resolve: (answer) => {
      clearTimeout(timer);
      anchorWaits.delete(id);
      resolve(answer);
    } });
    guest.send("browser:anchors", id, kind, clean);
  });
});

ipcMain.on("browser:anchors-answer", (event, id, answer) => {
  const wait = anchorWaits.get(id);
  if (wait?.guest !== event.sender.id) return;
  const ok = (a) => a === null || (a && typeof a === "object" && Object.values(a).every(finite));
  wait.resolve(Array.isArray(answer) && answer.length <= 64 && answer.every(ok) ? answer : []);
});

// The host's own page as the next getDisplayMedia source of the window that holds it (picture and sound), for the
// video stream over the others' mirror. main.js's display media handler asks `takeBrowserCapture` first.
let pendingCapture = null;

ipcMain.handle("browser:capture", (event, guestId) => {
  const guest = ownGuest(event, guestId);
  if (!guest || guest.isDestroyed()) return false;
  pendingCapture = { owner: event.sender.id, guest: guest.id, at: Date.now() };
  return true;
});

// Element capture (browserPreload.cjs): the window that holds a recorded page asks for a video node, the page
// offers its stream, and the answer goes back. Only between a page and its own window.
ipcMain.handle("browser:element-capture", (event, guestId, nodeId) => {
  const guest = ownGuest(event, guestId);
  if (!guest || !domRecordings.has(guest.id) || !Number.isInteger(nodeId)) return false;
  guest.send("browser:element-capture", nodeId);
  return true;
});

ipcMain.handle("browser:element-answer", (event, guestId, sdp) => {
  const guest = ownGuest(event, guestId);
  if (guest && typeof sdp === "string" && sdp.length < 100_000) guest.send("browser:element-answer", sdp);
});

ipcMain.handle("browser:element-stop", (event, guestId) => {
  const guest = ownGuest(event, guestId);
  if (guest && !guest.isDestroyed()) guest.send("browser:element-stop");
});

ipcMain.on("browser:element-offer", (event, nodeId, sdp) => {
  const guest = event.sender;
  const host = webContents.fromId(domRecordings.get(guest.id) ?? -1);
  if (guest.getType() !== "webview" || !host || guest.hostWebContents !== host || !Number.isInteger(nodeId)) return;
  host.send("browser:element-offer", guest.id, nodeId, typeof sdp === "string" && sdp.length < 100_000 ? sdp : null);
});

export function takeBrowserCapture(frame) {
  const pending = pendingCapture;
  pendingCapture = null;
  if (!pending || !frame || Date.now() - pending.at > 5000 || webContents.fromFrame(frame)?.id !== pending.owner) return null;
  const guest = webContents.fromId(pending.guest);
  return guest && !guest.isDestroyed() ? guest.mainFrame : null;
}

// Keys played inside a copy of the page (every member's, the typist's too): key events for the page's own handlers,
// then what the key does. Runs in an isolated world, so the page can't change these functions.
function replay(events) {
  const focused = () => {
    let at = document.activeElement || document.body;
    while (at.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
    return at;
  };
  // Many pages still read the old keyCode/which/charCode, which constructed events leave at 0.
  const codes = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  const fire = (target, type, init, text) => {
    const event = new KeyboardEvent(type, init);
    const keyCode = type === "keypress" ? text.charCodeAt(0) : codes[init.key] ?? (init.key.length === 1 ? init.key.toUpperCase().charCodeAt(0) : 0);
    for (const name of ["keyCode", "which"]) Object.defineProperty(event, name, { get: () => keyCode });
    Object.defineProperty(event, "charCode", { get: () => (type === "keypress" ? keyCode : 0) });
    return target.dispatchEvent(event);
  };
  for (const e of events) {
    const target = focused();
    if (e.type === "copy") {
      document.execCommand("copy");
      continue;
    }
    if (e.type === "text") {
      document.execCommand("insertText", false, e.text);
      continue;
    }
    const mods = new Set(e.modifiers);
    const shortcut = mods.has("control") || mods.has("meta");
    const init = { key: e.key, code: e.code, bubbles: true, cancelable: true, composed: true,
      shiftKey: mods.has("shift"), ctrlKey: mods.has("control"), altKey: mods.has("alt"), metaKey: mods.has("meta") };
    if (e.type === "keyUp") {
      fire(target, "keyup", init);
      continue;
    }
    if (!fire(target, "keydown", init)) continue;
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
    const editable = !!field || target.isContentEditable;
    if (shortcut) {
      const key = e.key.toLowerCase();
      if (key === "a") document.execCommand("selectAll");
      else if (key === "z") document.execCommand(mods.has("shift") ? "redo" : "undo");
      else if (key === "y") document.execCommand("redo");
      continue;
    }
    if (e.text && !fire(target, "keypress", init, e.text)) continue;
    if (e.text && e.text !== "\r") {
      if (editable) document.execCommand("insertText", false, e.text);
      else if (e.text === " ") scrollBy(0, (mods.has("shift") ? -0.9 : 0.9) * innerHeight);
      continue;
    }
    const caret = (to) => field.setSelectionRange(to, to);
    const move = (direction, unit) => getSelection().modify(mods.has("shift") ? "extend" : "move", direction, unit);
    switch (e.key) {
      case "Enter":
        if (target instanceof HTMLInputElement) target.form?.requestSubmit();
        else if (editable) document.execCommand(field ? "insertLineBreak" : "insertParagraph");
        else target.click?.();
        break;
      case "Backspace": if (editable) document.execCommand("delete"); break;
      case "Delete": if (editable) document.execCommand("forwardDelete"); break;
      case "ArrowLeft": field ? caret(Math.max(0, field.selectionStart - 1)) : move("backward", "character"); break;
      case "ArrowRight": field ? caret(field.selectionEnd + 1) : move("forward", "character"); break;
      case "ArrowUp": editable ? move("backward", "line") : scrollBy(0, -40); break;
      case "ArrowDown": editable ? move("forward", "line") : scrollBy(0, 40); break;
      case "PageUp": scrollBy(0, -0.9 * innerHeight); break;
      case "PageDown": scrollBy(0, 0.9 * innerHeight); break;
      case "Home": field ? caret(0) : editable ? move("backward", "lineboundary") : scrollTo(0, 0); break;
      case "End": field ? caret(field.value.length) : editable ? move("forward", "lineboundary") : scrollTo(0, document.body.scrollHeight); break;
    }
  }
}

// Only the window that holds the page may type into it.
ipcMain.handle("browser:keys", async (event, guestId, events) => {
  const guest = ownGuest(event, guestId);
  if (!guest) return;
  const clean = (Array.isArray(events) ? events.slice(0, 32) : []).flatMap((e) => {
    if (e?.type === "copy") return [{ type: "copy" }];
    if (e?.type === "text") return short(e.text, 10000) ? [{ type: "text", text: e.text }] : [];
    if (e?.type !== "keyDown" && e?.type !== "keyUp") return [];
    const modifiers = Array.isArray(e.modifiers) ? e.modifiers.filter((m) => ["shift", "control", "alt", "meta"].includes(m)) : [];
    return [{ type: e.type, key: short(e.key, 32), code: short(e.code, 32), text: short(e.text, 2) || undefined, modifiers }];
  });
  if (!clean.length) return;
  await guest.executeJavaScriptInIsolatedWorld(isolatedWorld, [{ code: `(${replay})(${JSON.stringify(clean)})` }], true).catch(() => {});
});
