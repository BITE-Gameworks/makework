// The user server (`user-server/`): accounts that work on every computer, private messages waiting for their
// recipient, and small encrypted documents of each account (vaults). Which one the app uses is a setting, MakeWork's own by default. Requests that act as an account are
// signed with its key; passwords never leave this computer (only a key derived from one, to sign in elsewhere).
import { createSignal } from "solid-js";
import { base64url, fromBase64url, sign, type LockedKey } from "./identity";
import { readJson, writeJson } from "./storage";
import { trimEnd } from "./text";

export const defaultUserServer = normalizeUrl(import.meta.env.VITE_USER_SERVER_URL || "me.makework.dev");
const storageKey = "mw.userServer";
const loginIterations = 600_000;
let offlineMode = false;
let requestController = new AbortController();

const [userServer, setUserServerUrl] = createSignal(readJson(storageKey, defaultUserServer));
export { userServer };

export interface Signer {
  id: string;
  key: CryptoKey;
}

export interface PublicAccount {
  id: string;
  username: string;
  // Tells apart people who share the username (ada·4f2a).
  tag: string;
  publicKey: { x: string; y: string };
  // `updatedAt` (ms) is when the profile was last changed on any device: the user server keeps the newest one.
  profile: { displayName: string; color: string; avatar: string; updatedAt?: number };
  hasPassword: boolean;
  createdAt: number;
}

export interface Login {
  salt: string;
  iterations: number;
  auth: string;
}

export interface WaitingMessage {
  id: string;
  from: string;
  body: string;
  at: number;
}

export interface Relations {
  friends: PublicAccount[];
  // Friend requests to this account, and from it.
  incoming: PublicAccount[];
  outgoing: PublicAccount[];
  blocked: PublicAccount[];
  // Whether people who aren't friends may send messages.
  allowStrangers: boolean;
}

export type RelationChange = "request" | "accept" | "remove" | "block" | "unblock";

// What a sign-in still needs before the user server hands out the key: the code it just emailed, or one from the
// account's authenticator app.
export type SecondStep = "email" | "totp";

export class UserServerError extends Error {
  constructor(readonly status: number, message: string, readonly needs: SecondStep | null = null) {
    super(message);
  }

  get offline(): boolean {
    return this.status === 0;
  }
}

export const userServerOffline = () => offlineMode;

export function setUserServerOffline(value: boolean): void {
  if (offlineMode === value) return;
  offlineMode = value;
  if (value) requestController.abort();
  requestController = new AbortController();
}

// "me.example.com" -> "https://me.example.com"; local addresses get http.
export function normalizeUrl(input: string): string {
  const trimmed = trimEnd(input.trim(), "/");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const local = /^(localhost|127\.|\[::1\])/i.test(trimmed);
  return `${local ? "http" : "https"}://${trimmed}`;
}

export function hostOf(url = userServer()): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function setUserServer(url: string): void {
  const next = normalizeUrl(url);
  writeJson(storageKey, next);
  setUserServerUrl(next);
}

// What the user server offers besides accounts, e.g. GitHub sign-in (only where it has a GitHub app).
export async function serverFeatures(): Promise<{ github: boolean; githubClientId: string | null }> {
  const info = await call<{ github?: boolean; github_client_id?: string | null }>("GET", "/");
  return { github: !!info.github, githubClientId: info.github_client_id ?? null };
}

// The version this user server reports; null when it is from before servers reported one.
export async function userServerVersion(): Promise<string | null> {
  const info = await call<{ version?: unknown }>("GET", "/");
  return typeof info.version === "string" ? info.version : null;
}

// Mailed by the user server to where feedback goes; no account involved.
export async function sendFeedback(feedback: { message: string; report: string; reply: string; version: string; system: string }): Promise<void> {
  await call("POST", "/feedback", { body: feedback });
}

// Confirms that the address is a MakeWork user server; its name.
export async function checkUserServer(url: string): Promise<string> {
  const info = await call<{ makework?: string; name?: string }>("GET", "/", { base: normalizeUrl(url) });
  if (info.makework !== "user-server") throw new UserServerError(400, `${hostOf(normalizeUrl(url))} isn't a MakeWork user server.`);
  return info.name ?? hostOf(normalizeUrl(url));
}

// What signs in elsewhere: a key derived from the password with its own salt, so the user server can't unlock the
// account's private key with it.
export async function newLogin(password: string): Promise<Login> {
  const salt = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iterations: loginIterations, auth: await loginKey(password, salt, loginIterations) };
}

async function loginKey(password: string, salt: string, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64url(salt), iterations }, material, 256);
  return base64url(new Uint8Array(bits));
}

// `email` with its emailed `code` (or a `resetToken`, to take over the email of a lost account) sets the email.
// `recoveryCopy` (the key as PKCS#8, base64url) and `recoveryLocked`: null removes them, left out keeps them.
// The answer's `profile` is the newest one the server keeps (another device's may be newer); a user server from before
// profiles followed the account sends none.
export function publishAccount(signer: Signer, account: {
  username: string;
  publicKey: { x: string; y: string };
  profile: PublicAccount["profile"];
  login?: Login & { locked: LockedKey };
  email?: string;
  code?: string;
  resetToken?: string;
  // Links the GitHub user of a GitHub sign-in to this account.
  githubToken?: string;
  recoveryCopy?: string | null;
  recoveryLocked?: LockedKey | null;
}): Promise<{ created: boolean; profile?: PublicAccount["profile"] }> {
  return call("PUT", "/me", { body: account, signer });
}

export interface OwnAccount {
  email: string | null;
  // The linked GitHub login.
  github: string | null;
  hasPassword: boolean;
  recoveryCopy: boolean;
  // The owner turned the copy off; no device makes a new one by itself then.
  recoveryOff: boolean;
  recoveryKey: boolean;
  // Whether this user server keeps recovery copies at all.
  keepsCopies: boolean;
  // Sign-ins on a new computer take a code from an authenticator app; `backupCodes` is how many unused ones are left.
  totp?: boolean;
  backupCodes?: number;
}

export function ownAccount(signer: Signer): Promise<OwnAccount> {
  return call("GET", "/me", { signer });
}

// Sends a 6-digit code to the email: to confirm it ("register") or to reset the password of its account.
export function requestCode(email: string, purpose: "register" | "reset"): Promise<void> {
  return call("POST", "/email/code", { body: { email: email.trim().toLowerCase(), purpose } });
}

export interface ResetStart {
  token: string;
  account: PublicAccount;
  recoveryCopy: boolean;
  recoveryLocked: LockedKey | null;
  // The recovery copy also takes a code from the account's authenticator app.
  totp?: boolean;
}

export function startReset(email: string, code: string): Promise<ResetStart> {
  return call("POST", "/reset/start", { body: { email: email.trim().toLowerCase(), code: code.trim() } });
}

// The account key (PKCS#8, base64url) from the user server's recovery copy. `totp` when the account uses an
// authenticator app (a current code or a backup code).
export async function fetchRecoveryCopy(token: string, totp?: string): Promise<string> {
  return (await call<{ privateKey: string }>("POST", "/reset/copy", { body: totp === undefined ? { token } : { token, totp: totp.trim() } })).privateKey;
}

// Authenticator app setup: a new secret (base32, and as an `otpauth://` link for a QR code), turned on only once
// `confirmTotp` gets a code from the app. Its answer holds the backup codes, shown once.
export function startTotp(signer: Signer): Promise<{ secret: string; uri: string }> {
  return call("POST", "/me/totp/start", { body: {}, signer });
}

export async function confirmTotp(signer: Signer, code: string): Promise<string[]> {
  return (await call<{ backupCodes: string[] }>("POST", "/me/totp/confirm", { body: { code: code.trim() }, signer })).backupCodes;
}

// Takes a current code or a backup code.
export async function turnOffTotp(signer: Signer, code: string): Promise<void> {
  await call("POST", "/me/totp/off", { body: { code: code.trim() }, signer });
}

export async function requestFromDevice(token: string, publicKey: { x: string; y: string }, device: string): Promise<string> {
  return (await call<{ id: string }>("POST", "/reset/request", { body: { token, publicKey, device } })).id;
}

export function resetRequestStatus(token: string, id: string): Promise<{ status: "waiting" | "approved" | "denied"; sealed: string | null }> {
  return call("GET", `/reset/request?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`);
}

export interface ResetRequest {
  id: string;
  publicKey: { x: string; y: string };
  at: number;
  // How the requesting device named itself, e.g. "Windows · Chrome".
  device: string | null;
}

export async function pendingResets(signer: Signer): Promise<ResetRequest[]> {
  return (await call<{ requests: ResetRequest[] }>("GET", "/me/resets", { signer })).requests;
}

// Approves with the key sealed to the requesting device, or denies with null.
export function answerReset(signer: Signer, id: string, sealed: string | null): Promise<void> {
  return call("POST", "/me/resets", { body: sealed === null ? { id } : { id, sealed }, signer });
}

export interface GitHubSignIn {
  githubToken: string;
  github: { id: string; login: string; name: string };
  // The account linked to that GitHub user, if any, and how its key can come back.
  account: PublicAccount | null;
  reset: { token: string; recoveryCopy: boolean; recoveryLocked: LockedKey | null; totp?: boolean } | null;
}

// Where the browser build sends the person to sign in with GitHub: `session` is a random id kept by the app, and the
// user server sends the answer's one-time code back to `origin` (one of the origins it knows the web app at). The
// desktop app starts it in the main process instead, with a loopback port (desktop.githubSignIn).
export const githubStartUrl = (session: string, origin: string) =>
  `${userServer()}/github/start?session=${encodeURIComponent(session)}&origin=${encodeURIComponent(origin)}`;

// The answer, for the session id and the one-time code that came back to this device; handed out once.
export function githubResult(session: string, once: string): Promise<{ status: "done" } & GitHubSignIn> {
  return call("GET", `/github/result?session=${encodeURIComponent(session)}&once=${encodeURIComponent(once)}`);
}

// The account with its locked key, for a correct email (or, for accounts from before emails, username) and password.
// The password alone isn't enough: an account with an authenticator app needs `totp` (else this fails with `needs`
// "totp"), and one with an email needs the code the user server mails when `code` is left out (naming `device`,
// "Windows · Chrome"; this fails with `needs` "email"). The same call with the code then gets the account.
export async function fetchAccount(
  login: { email: string } | { username: string }, password: string, confirm: { code?: string; totp?: string; device?: string } = {},
): Promise<PublicAccount & { locked: LockedKey }> {
  const by = "email" in login ? { email: login.email.trim().toLowerCase() } : { username: login.username.trim().toLowerCase() };
  const [field, value] = Object.entries(by)[0];
  const { salt, iterations } = await call<{ salt: string; iterations: number }>("GET", `/login?${field}=${encodeURIComponent(value)}`);
  const auth = await loginKey(password, salt, iterations);
  const body = {
    ...by, auth, ...(confirm.device ? { device: confirm.device } : {}), ...(confirm.code === undefined ? {} : { code: confirm.code.trim() }),
    ...(confirm.totp === undefined ? {} : { totp: confirm.totp.trim() }),
  };
  return (await call<{ account: PublicAccount & { locked: LockedKey } }>("POST", "/login", { body })).account;
}

// Null when there is no such account. `name` is a username with its tag, "ada·4f2a" (or "ada#4f2a").
export async function findAccount(by: { name: string } | { email: string; signer: Signer } | { id: string }): Promise<PublicAccount | null> {
  let query: string;
  if ("email" in by) query = `email=${encodeURIComponent(by.email.trim().toLowerCase())}`;
  else if ("name" in by) {
    const [username, tag = ""] = by.name.trim().replace(/^@/, "").toLowerCase().split(/[·#]/);
    query = `username=${encodeURIComponent(username)}&tag=${encodeURIComponent(tag)}`;
  } else query = `id=${encodeURIComponent(by.id)}`;
  try {
    return (await call<{ account: PublicAccount }>("GET", `/users?${query}`, "signer" in by ? { signer: by.signer } : {})).account;
  } catch (e) {
    if (e instanceof UserServerError && e.status === 404) return null;
    throw e;
  }
}

// Finds someone by email or by username with its tag (ada·4f2a); a bare username isn't enough since anyone may share it.
export async function findPerson(query: string, signer: Signer): Promise<PublicAccount> {
  const q = query.trim();
  if (!q) throw new UserServerError(400, "Enter an email or a name with its tag, like ada·4f2a.");
  const isEmail = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(q);
  if (!isEmail && !/[·#]/.test(q)) throw new UserServerError(400, `Many people can be @${q.replace(/^@/, "")}: add their tag (like ada·4f2a) or use their email.`);
  const found = await findAccount(isEmail ? { email: q, signer } : { name: q });
  if (!found) throw new UserServerError(404, `No one on ${hostOf()} is ${q}.`);
  return found;
}

// How a person is named where people must be told apart: @ada·4f2a.
export const handleOf = (person: { username: string; tag?: string; bot?: boolean }) =>
  `@${person.username}${person.tag ? `${person.bot ? "#" : "·"}${person.tag}` : ""}`;

export function leaveMessage(signer: Signer, message: { id: string; to: string; body: string }): Promise<void> {
  return call("POST", "/messages", { body: message, signer });
}

// Messages waiting for this account, and its friends and requests as they are now.
export function waitingMessages(signer: Signer): Promise<{ messages: WaitingMessage[]; relations: Relations }> {
  return call("GET", "/messages", { signer });
}

export function fetchRelations(signer: Signer): Promise<Relations> {
  return call("GET", "/me/relations", { signer });
}

// "remove" unfriends, declines a request to this account or cancels one from it.
export function changeRelation(signer: Signer, action: RelationChange, id: string): Promise<Relations> {
  return call("POST", "/me/relations", { body: { action, id }, signer });
}

export function changeSettings(signer: Signer, settings: { allowStrangers: boolean }): Promise<Relations> {
  return call("PUT", "/me/settings", { body: settings, signer });
}

export function confirmMessages(signer: Signer, ids: string[]): Promise<void> {
  return call("POST", "/messages/ack", { body: { ids }, signer });
}

// Mailed to whoever runs the user server, with the reporter's account and email so they can answer.
export function reportAccount(signer: Signer, account: string, reason: string): Promise<void> {
  return call("POST", "/report", { body: { account, reason }, signer });
}

// Deletes the account and everything the user server keeps for it. Its id can't be published again.
export function deleteUserServerAccount(signer: Signer): Promise<void> {
  return call("DELETE", "/me", { signer });
}

// An encrypted document of the account's own; `rev` 0 when there is none yet.
export function readVault(signer: Signer, name: string): Promise<{ data: string | null; rev: number }> {
  return call("GET", `/me/vault/${name}`, { signer });
}

// Fails with status 409 when it changed since `rev` was read.
export function writeVault(signer: Signer, name: string, data: string, rev: number): Promise<{ rev: number }> {
  return call("PUT", `/me/vault/${name}`, { body: { data, rev }, signer });
}

async function call<T>(method: string, path: string, options: { body?: unknown; signer?: Signer; base?: string } = {}): Promise<T> {
  if (offlineMode) throw new UserServerError(0, "Offline mode is on.");
  const base = options.base ?? userServer();
  const url = new URL(path, `${base}/`);
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (options.signer) headers["X-MW-Auth"] = await authHeader(options.signer, method, url, body);
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: body || undefined, cache: "no-store", signal: requestController.signal });
  } catch {
    throw new UserServerError(0, offlineMode ? "Offline mode is on." : `Can't reach ${hostOf(base)}.`);
  }
  const answer = await response.json().catch(() => null) as (T & { error?: string; needsCode?: unknown; needsTotp?: unknown }) | null;
  if (!response.ok || !answer) {
    const needs = answer?.needsTotp === true ? "totp" : answer?.needsCode === true ? "email" : null;
    throw new UserServerError(response.status, answer?.error ?? `${hostOf(base)} answered ${response.status}.`, needs);
  }
  return answer;
}

// `X-MW-Auth` for a request acting as the account: its signature of the method, host, path, time and body. Also taken by
// MakeWork's TURN worker (p2p/ice.ts).
export async function authHeader(signer: Signer, method: string, url: URL, body = ""): Promise<string> {
  const time = Date.now();
  const signed = `${method} ${url.host}${trimEnd(url.pathname, "/") || "/"}\n${time}\n${await sha256(body)}`;
  return `${signer.id}.${time}.${await sign(signer.key, signed)}`;
}

async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
