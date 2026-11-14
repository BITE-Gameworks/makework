// Host connections (docs/glossary.md): this member's named tokens for git hosts on this computer, several per host, and
// which one each version control channel uses here. Only names are listed here; the tokens themselves are kept by
// core/secrets.ts under the connection's key: "<host>" for the GitHub sign-in (and tokens saved before connections
// had names), "<host>#<id>" for each named one.
import { createSignal } from "solid-js";
import { account } from "../../../core/account";
import { signOutOfGitHub } from "../../../core/githubAuth";
import { forgetToken, getToken, setToken } from "../../../core/secrets";
import { readJson, writeJson } from "../../../core/storage";
import { hostUser } from "./providers";

export interface Connection {
  key: string;
  name: string;
  host: string;
  // When a channel last picked it or it was added; the latest is offered first.
  used: number;
}

type Fetch = typeof fetch;

const listKey = () => `mw.git.connections.${account()?.id ?? "nobody"}`;
const readList = () => readJson<Connection[]>(listKey(), []);

// Changes after every connection added, renamed, forgotten or picked, so views showing them read them again.
const [revision, setRevision] = createSignal(0);
export const connectionRevision = revision;

function writeList(list: Connection[]): void {
  writeJson(listKey(), list);
  setRevision((n) => n + 1);
}

// Later than every connection's `used`, so the latest pick is first even within one millisecond.
const stamp = (list: Connection[]) => Math.max(Date.now(), ...list.map((c) => c.used + 1));

// This host's connections, the latest used first. The plain "<host>" slot is listed while it holds a token: the
// GitHub sign-in writes it from the main process, and a token saved before connections had names is found there
// (named after its host until renamed). While it reads empty (signed out elsewhere, a locked keychain) it is only
// left out, so its name and place come back with it; forgetConnection drops it for good.
export async function connectionsFor(host: string): Promise<Connection[]> {
  host = host.toLowerCase();
  let list = readList();
  const kept = !!(await getToken(host));
  if (kept && !list.some((c) => c.key === host)) {
    list = [...list, { key: host, name: host, host, used: 0 }];
    writeList(list);
  }
  return list.filter((c) => c.host === host && (c.key !== host || kept)).sort((a, b) => b.used - a.used);
}

export function renameConnection(key: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  writeList(readList().map((c) => (c.key === key ? { ...c, name: trimmed } : c)));
}

// After signing in to GitHub (the desktop app keeps it in the "github.com" slot): listed as the latest connection,
// named after the login.
export function nameGitHubSignIn(login: string | null): void {
  const list = readList().filter((c) => c.key !== "github.com");
  const name = login ? `GitHub sign-in (${login})` : "GitHub sign-in";
  writeList([...list, { key: "github.com", name, host: "github.com", used: stamp(readList()) }]);
}

// Which connection a channel uses on this computer: a key, or "none" for no token at all. Its submodules on the
// repository's own host use the same one; a submodule on another host has the channel's pick for that host
// (`ownHost`), so reading it never replaces the channel's own.
const choicePrefix = "mw.git.connection.";
const choiceKey = (workspaceId: string, channelId: number, ownHost?: string) =>
  `${choicePrefix}${workspaceId}:${channelId}${ownHost ? `@${ownHost.toLowerCase()}` : ""}`;
const readChoice = (workspaceId: string, channelId: number, ownHost?: string) =>
  readJson<string | null>(choiceKey(workspaceId, channelId, ownHost), null);
const writeChoice = (workspaceId: string, channelId: number, key: string, ownHost?: string) => {
  writeJson(choiceKey(workspaceId, channelId, ownHost), key);
  setRevision((n) => n + 1);
};

// Every channel's pick on this computer: its storage key and the pick.
function eachChoice(visit: (storageKey: string, chosen: string) => void): void {
  try {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name?.startsWith(choicePrefix)) names.push(name);
    }
    for (const name of names) {
      const chosen = readJson<string | null>(name, null);
      if (chosen) visit(name, chosen);
    }
  } catch {
    // No storage: no picks kept.
  }
}

// `ownHost`: the pick is for the channel's submodules on that host, which isn't its repository's.
export function useConnection(workspaceId: string, channelId: number, key: string, ownHost?: string): void {
  const list = readList();
  const at = list.findIndex((c) => c.key === key);
  if (at >= 0) writeJson(listKey(), list.map((c, i) => (i === at ? { ...c, used: stamp(list) } : c)));
  writeChoice(workspaceId, channelId, key, ownHost);
}

// The key of the connection a channel uses for `host`, null for none. A channel without a pick here (made before
// connections had names, or on another computer), or with one for another host (its repository changed), takes the
// host's own slot when it holds a token (what it used before connections had names), else the latest connection for
// the host, and keeps it, so connections added later don't change who it acts as. A forgotten one is never replaced
// by another: the channel asks again. `own`: `host` is a submodule's and not the repository's, with a pick of its own.
export async function channelConnectionKey(workspaceId: string, channelId: number, host: string, own = false): Promise<string | null> {
  host = host.toLowerCase();
  const ownHost = own ? host : undefined;
  const connections = await connectionsFor(host);
  // Read after the wait, so a pick made meanwhile (the setup form saves one once the repository is set) wins.
  const chosen = readChoice(workspaceId, channelId, ownHost);
  if (chosen === "none") return null;
  if (chosen?.split("#")[0] === host) return connections.some((c) => c.key === chosen) ? chosen : null;
  const fallback = connections.find((c) => c.key === host) ?? connections[0];
  if (!fallback) return null;
  writeChoice(workspaceId, channelId, fallback.key, ownHost);
  return fallback.key;
}

// How many channels on this computer picked each connection, by key.
export function connectionUses(): Map<string, number> {
  const uses = new Map<string, number>();
  eachChoice((_name, chosen) => uses.set(chosen, (uses.get(chosen) ?? 0) + 1));
  return uses;
}

// Forgets the token and its name. Channels that used it have none until another is picked (they ask when the host
// refuses), even when the GitHub sign-in's slot is filled again by a later sign-in. The GitHub sign-in is signed out,
// so views showing the GitHub login read it again.
export async function forgetConnection(key: string): Promise<void> {
  if (key === "github.com") await signOutOfGitHub();
  else await forgetToken(key);
  eachChoice((name, chosen) => chosen === key && writeJson(name, "none"));
  writeList(readList().filter((c) => c.key !== key));
}

export async function channelToken(workspaceId: string, channelId: number, host: string, own = false): Promise<string | null> {
  const key = await channelConnectionKey(workspaceId, channelId, host, own);
  return key ? getToken(key) : null;
}

// For the desktop app's fetch, pull and push (electron/main.js `git:account`): each working copy's folder and the key
// of its channel's connection, "" for no token. Folders whose channel has no pick here are left out (main then uses
// the plain "<host>" slot, as before connections had names). An emptied plain slot needs no check: main finds it empty.
// `ownHost`: a submodule's folder whose host isn't the channel's repository's.
export function folderCredentials(copies: { workspaceId: string; channelId: number; folder: string; ownHost?: string }[]): Record<string, string> {
  const saved = new Set(readList().map((c) => c.key));
  const credentials: Record<string, string> = {};
  for (const { workspaceId, channelId, folder, ownHost } of copies) {
    const chosen = readChoice(workspaceId, channelId, ownHost);
    if (!chosen) continue;
    credentials[folder] = chosen === "none" || (chosen.includes("#") && !saved.has(chosen)) ? "" : chosen;
  }
  return credentials;
}

// Every connection kept here, by host, the latest used first within one. The common hosts' own slots are looked at
// too, so a GitHub sign-in shows before any channel used it.
export async function allConnections(): Promise<Connection[]> {
  for (const host of new Set(["github.com", "gitlab.com", ...readList().map((c) => c.host)])) await connectionsFor(host);
  return readList().sort((a, b) => a.host.localeCompare(b.host) || b.used - a.used);
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

// `base`, or "base 2", "base 3"... when a connection already has that name.
function unique(base: string, list: Connection[]): string {
  const taken = new Set(list.map((c) => c.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

// Saves a token as a connection for `host` and returns it; a token already saved for the host gives its connection.
// Without a name it is named after the user the host says the token is for ("octocat on github.com").
// Throws when the token can't be kept on this device (no keychain).
export async function addConnection(added: { host: string; provider: "github" | "gitlab"; token: string; name?: string },
  fetchFn: Fetch = fetch): Promise<Connection> {
  const host = added.host.toLowerCase();
  for (const c of await connectionsFor(host)) if ((await getToken(c.key)) === added.token) return c;
  const typed = added.name?.trim();
  const user = typed ? null : await hostUser(added.provider, host, added.token, fetchFn);
  const key = `${host}#${newId()}`;
  await setToken(key, added.token);
  const list = readList();
  const connection: Connection = { key, name: typed || unique(user ? `${user} on ${host}` : `${host} token`, list), host, used: stamp(list) };
  writeList([...list, connection]);
  return connection;
}
