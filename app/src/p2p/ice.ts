// TURN relays, the last resort for members who can't reach each other directly. Workspace rooms offer them with every
// connection (sync.ts; WebRTC still prefers direct paths), DM links after a failed one. A call's media needs them most:
// it goes only over direct links, never through another member (ADR 0019).
// Short-lived Cloudflare credentials come from our worker (`turn-worker/`), which stops handing them out at a monthly
// cap and gives them only to signed requests of user server accounts, a few per account and address an hour. So they
// are fetched when a workspace opens without fresh ones, and renewed only when a connection is made after they got old,
// never in the background: an app left running doesn't use up the account's grants.
import { createSignal } from "solid-js";
import { account, accountKey } from "../core/account";
import { readJson, writeJson } from "../core/storage";
import { authHeader, hostOf, normalizeUrl } from "../core/userServer";

// A setting (Settings > Account), next to the user server whose accounts it serves.
export const defaultTurnServer = normalizeUrl(import.meta.env.VITE_TURN_URL || "turn.makework.dev");
const storageKey = "mw.turnServer";
const [turnServer, setTurnServerUrl] = createSignal(readJson(storageKey, defaultTurnServer));
export { turnServer };
const timeoutMs = 5000;
const retryMs = 60_000;
// Renewed when a connection is made this long before the credentials run out.
const marginMs = 600_000;

let turnServers: RTCIceServer[] = [];
let fetching: Promise<void> | null = null;
// When the credentials should be renewed and when they run out; after a failure or refusal, not before `retryAt`.
let renewAt = 0;
let expiresAt = 0;
let retryAt = 0;
// Why the last fetch gave none (null: none asked for yet, or it gave some).
let refusal: string | null = null;

// The credentials for a connection being made now; starts renewing them when they are getting old.
export function currentTurn(): RTCIceServer[] {
  const now = Date.now();
  if (now >= renewAt) void startRefresh();
  return now < expiresAt ? turnServers : [];
}

// Fetches credentials unless fresh ones are here; resolves once they are in or after a few seconds.
export function loadTurn(): Promise<void> {
  if (Date.now() < renewAt) return Promise.resolve();
  return Promise.race([startRefresh(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

function startRefresh(): Promise<void> {
  if (!fetching && Date.now() >= retryAt) fetching = refresh().finally(() => (fetching = null));
  return fetching ?? Promise.resolve();
}

async function refresh(): Promise<void> {
  try {
    const me = account();
    if (!me) throw new Error("not signed in");
    const url = turnServer();
    const auth = await authHeader({ id: me.id, key: accountKey() }, "GET", new URL(url));
    const response = await fetch(url, { cache: "no-store", headers: { "X-MW-Auth": auth } });
    // Refusals (cap reached, too many requests, account not on the user server) say when to ask again.
    const body = (await response.json().catch(() => null)) as { iceServers?: unknown; ttl?: unknown; reason?: string } | null;
    if (!body) throw new Error(`${response.status} ${response.statusText}`);
    // A missing or odd lifetime would make every time below NaN, and then nothing ever asked again.
    const ttl = Number(body.ttl);
    const servers = Array.isArray(body.iceServers) ? (body.iceServers as RTCIceServer[]) : [];
    if (servers.length && Number.isFinite(ttl) && ttl > 0) {
      turnServers = servers;
      expiresAt = Date.now() + ttl * 1000;
      renewAt = expiresAt - marginMs;
      refusal = null;
    } else {
      console.warn("TURN credentials not given:", body.reason ?? response.status);
      refusal = String(body.reason ?? (servers.length ? "no lifetime given" : response.status));
      retryAt = Date.now() + Math.max(retryMs, Number.isFinite(ttl) ? ttl * 1000 : 0);
    }
  } catch (e) {
    console.warn("TURN credentials not loaded:", e);
    refusal = (e as Error)?.message ?? String(e);
    retryAt = Date.now() + retryMs;
  }
}

// For call diagnostics: whether this device has TURN credentials now, or why not. A call goes only over direct links
// (ADR 0019), so without them members behind strict NATs can't link.
export function turnStatus(): string {
  if (Date.now() < expiresAt) return "ready";
  if (refusal) return `not given: ${refusal}`;
  return expiresAt > 0 ? "ran out, renewed on the next connection" : "not asked for yet";
}

// Credentials come from the new address from the next time a room needs them.
export function setTurnServer(url: string): void {
  const next = normalizeUrl(url);
  writeJson(storageKey, next);
  setTurnServerUrl(next);
  turnServers = [];
  fetching = null;
  refusal = null;
  renewAt = expiresAt = retryAt = 0;
}

// Confirms that the address hands out TURN credentials (unsigned, so it answers with a refusal in that shape).
export async function checkTurnServer(url: string): Promise<void> {
  const target = normalizeUrl(url);
  let body: { iceServers?: unknown } | null = null;
  try {
    body = await (await fetch(target, { cache: "no-store" })).json();
  } catch {
    throw new Error(`Can't reach ${hostOf(target)}, or it isn't a MakeWork TURN server.`);
  }
  if (!Array.isArray(body?.iceServers)) throw new Error(`${hostOf(target)} isn't a MakeWork TURN server.`);
}
