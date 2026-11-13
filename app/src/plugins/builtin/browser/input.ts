// What a member does on the shared page, for every member's copy of it, their own included: mouse events for
// webContents.sendInputEvent (in the page's own CSS px), and keys, which the input layer over the page takes and the
// main process plays inside each page. Keys are never left to the window's focus: typed characters went to the
// app's last text field instead of the page, and others' keys would land in a member's chat.

export type Modifier = "shift" | "control" | "alt" | "meta";

// A point by the element under it: the recorder's node id (the same in the host's page and every mirror) and where in
// that element's box, 0 to 1. Each copy finds the element in its own layout; x and y are the fallback.
export type Anchor = { id: number; fx: number; fy: number };

export type PageInput =
  | { type: "mouseMove" | "mouseDown" | "mouseUp"; x: number; y: number; at?: Anchor; button: "left" | "middle" | "right"; clickCount: number; modifiers: Modifier[] }
  | { type: "mouseWheel"; x: number; y: number; at?: Anchor; deltaX: number; deltaY: number; modifiers: Modifier[] }
  | KeyInput;

export const isAnchor = (value: unknown): value is Anchor => {
  const a = value as Record<string, unknown> | null;
  return !!a && typeof a === "object" && Number.isInteger(a.id) && Number(a.id) > 0
    && Number.isFinite(a.fx) && Number.isFinite(a.fy) && Math.abs(Number(a.fx)) <= 4 && Math.abs(Number(a.fy)) <= 4;
};

export type KeyInput =
  | { type: "keyDown" | "keyUp"; key: string; code: string; text?: string; modifiers: Modifier[] }
  | { type: "text"; text: string };

// The page is laid out this wide on every member's screen (scaled to fit), so a point means the same everywhere.
// Its height fills each member's view, at least `minPageHeight`; only how much shows below differs.
export const pageWidth = 1280;
export const minPageHeight = 600;

export function modifiersOf(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): Modifier[] {
  const list: Modifier[] = [];
  if (e.shiftKey) list.push("shift");
  if (e.ctrlKey) list.push("control");
  if (e.altKey) list.push("alt");
  if (e.metaKey) list.push("meta");
  return list;
}

const buttons = ["left", "middle", "right"] as const;
export const buttonOf = (button: number) => buttons[button] ?? "left";

type DomKey = { key: string; code: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };
const modifierKeys = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Dead", "Process", "Unidentified"]);

// A key for the page; typed characters carry their text, which is what puts them in fields.
export function keyInput(type: "keyDown" | "keyUp", e: DomKey): KeyInput | null {
  if (modifierKeys.has(e.key)) return null;
  const plain = !e.ctrlKey && !e.metaKey;
  const text = type === "keyDown" && plain ? (e.key.length === 1 ? e.key : e.key === "Enter" ? "\r" : undefined) : undefined;
  return { type, key: e.key, code: e.code, ...(text ? { text } : {}), modifiers: modifiersOf(e) };
}

// Shortcuts played on every copy of the page: select all, undo, redo. Others (copy, the app's own) are not shared.
export const sharedShortcut = (key: string) => ["a", "z", "y"].includes(key.toLowerCase());

// A wheel turn in page px; Electron's deltas point the other way from the DOM's.
export function wheel(e: { deltaX: number; deltaY: number; deltaMode: number }, at: { x: number; y: number }, modifiers: Modifier[]): PageInput {
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? minPageHeight : 1;
  return { type: "mouseWheel", x: at.x, y: at.y, deltaX: -e.deltaX * unit, deltaY: -e.deltaY * unit, modifiers };
}

// What the address bar makes of typed text: an address as is, a bare host with https, anything else a search.
export function addressFor(text: string): string | null {
  const typed = text.trim();
  if (!typed) return null;
  if (/^https?:\/\//i.test(typed)) return typed;
  if (!/\s/.test(typed) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(typed)) return `https://${typed}`;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(typed)) return `http://${typed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`;
}

// Sent with every message and in presence; members whose apps speak another version are named in the view, since
// their copy of the page drifts (a version mismatch looks like bad sync).
export const browserProtocol = 7;

// "mirror": one member's page, the others watch it. "individual": every member loads it and input plays on every copy.
// "together": every member loads it and acts on their own copy; only the page and a video's playback are shared.
export type SyncMode = "mirror" | "individual" | "together";
export const syncModes: SyncMode[] = ["mirror", "individual", "together"];

export interface BrowserPresence {
  url?: string;
  v?: number;
  host?: true;
  hostAt?: number;
  mode?: SyncMode;
  // The host's video being streamed over the mirror (videoShare.ts `VideoRegion`).
  video?: unknown;
}

type BrowserPeer = { userId: number; state: BrowserPresence };

// A host declaration lasts only while its owner has channel presence. Navigation records the
// declaration time, so a late-arriving presence packet cannot take control back from a newer one.
export function electedHost(me: number | null, peers: BrowserPeer[]): number | null {
  const watching: BrowserPeer[] = (me === null ? [] : [{ userId: me, state: {} }]).concat(peers);
  if (!watching.length) return null;
  const declarations = watching.filter((peer) => peer.state.host === true && Number.isFinite(peer.state.hostAt));
  if (!declarations.length) return Math.min(...watching.map((peer) => peer.userId));
  return declarations
    .toSorted((a, b) => Number(b.state.hostAt) - Number(a.state.hostAt) || a.userId - b.userId)[0]
    .userId;
}

// DOM batches go in chunks this size; a full snapshot of a big page needs a few hundred.
export const domChunkSize = 12_000;
export const maxDomChunks = 1024;
// A proxied resource (4 MB at most, base64) goes in chunks the same size.
export const maxResourceChunks = 512;

// A message between members of a browser channel.
export type BrowserMessage =
  | { t: "host"; at: number }
  | { t: "go"; url: string }
  | { t: "back" } | { t: "forward" } | { t: "reload" } | { t: "close" } | { t: "catchup" }
  | { t: "dom-need" }
  | { t: "mode"; mode: SyncMode }
  | { t: "dom"; id: number; index: number; total: number; data: string }
  | { t: "res-need"; id: number; url: string }
  | { t: "res"; id: number; index: number; total: number; status: number; type: string; data: string }
  | { t: "input"; events: PageInput[] }
  | { t: "scroll"; x: number; y: number }
  | { t: "media"; paused: boolean; time: number };

export function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  switch (m.t) {
    case "host": return Number.isFinite(m.at);
    case "go": return typeof m.url === "string" && /^https?:\/\//i.test(m.url);
    case "back": case "forward": case "reload": case "close": case "catchup": case "dom-need": return true;
    case "mode": return syncModes.includes(m.mode as SyncMode);
    case "dom": return typeof m.id === "number" && Number.isInteger(m.id) && m.id >= 0
      && typeof m.index === "number" && Number.isInteger(m.index) && m.index >= 0
      && typeof m.total === "number" && Number.isInteger(m.total) && m.total > 0 && m.total <= maxDomChunks
      && typeof m.data === "string" && m.data.length <= domChunkSize;
    case "res-need": return Number.isInteger(m.id) && typeof m.url === "string" && m.url.length <= 8192 && /^https?:\/\//i.test(m.url);
    case "res": return Number.isInteger(m.id) && Number.isInteger(m.index) && Number(m.index) >= 0
      && Number.isInteger(m.total) && Number(m.total) > 0 && Number(m.total) <= maxResourceChunks && Number(m.index) < Number(m.total)
      && Number.isInteger(m.status) && typeof m.type === "string" && m.type.length <= 200
      && typeof m.data === "string" && m.data.length <= domChunkSize;
    case "input": return Array.isArray(m.events) && m.events.length <= 32 && m.events.every(isPageInput);
    case "scroll": return Number.isFinite(m.x) && Number.isFinite(m.y);
    case "media": return typeof m.paused === "boolean" && Number.isFinite(m.time);
    default: return false;
  }
}

const inputTypes = new Set(["mouseMove", "mouseDown", "mouseUp", "mouseWheel", "keyDown", "keyUp", "text"]);
const knownModifiers = new Set(["shift", "control", "alt", "meta"]);

function isPageInput(value: unknown): value is PageInput {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  if (!inputTypes.has(e.type as string)) return false;
  if (e.type === "text") return typeof e.text === "string" && e.text.length <= 10000;
  if (!Array.isArray(e.modifiers) || !e.modifiers.every((m) => knownModifiers.has(m))) return false;
  if (e.type === "keyDown" || e.type === "keyUp") {
    return typeof e.key === "string" && e.key.length <= 32 && typeof e.code === "string" && e.code.length <= 32 &&
      (e.text === undefined || (typeof e.text === "string" && e.text.length <= 2));
  }
  const inside = Number.isFinite(e.x) && Number.isFinite(e.y) && (e.at === undefined || isAnchor(e.at));
  if (e.type === "mouseWheel") return inside && Number.isFinite(e.deltaX) && Number.isFinite(e.deltaY);
  return inside && buttons.includes(e.button as never) && Number.isInteger(e.clickCount);
}
