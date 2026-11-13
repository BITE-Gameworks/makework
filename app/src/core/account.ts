// The signed-in account. Accounts live on this device (IndexedDB): a key pair, profile and optionally a linked
// Google account. Password accounts keep their private key encrypted; they move between devices through the user
// server (core/userServer.ts: sign in there with email and password) or as an account file. A forgotten password is
// reset with an emailed code; the key comes back from the user server's recovery copy (off unless turned on), the owner's
// recovery key, or a device still signed in (core/recovery.ts), else the email moves to a fresh account. Google accounts
// keep it non-extractable here and in their Google Drive app folder (core/drive.ts), which every device signing in
// with that Google account uses. Every account is also published to the user server, so others can find it and
// send it private messages.
import { deviceLabel } from "./device";
import { createSignal } from "solid-js";
import { dbAll, dbDelete, dbGet, dbPut } from "./db";
import { desktop, desktopError } from "./desktop";
import { deleteDriveAccounts, readDriveAccount, writeDriveAccount } from "./drive";
import { signInWithGoogle, type GoogleProfile } from "./google";
import {
  accountTag, base64url, createIdentity, exportPkcs8, fromBase64url, importAgreementKey, importPrivateKey, isKeyPair,
  lockPkcs8, unlockPkcs8, type LockedKey,
} from "./identity";
import {
  deviceOpen, deviceSeal, lockWithRecoveryKey, newDeviceKey, newRecoveryKey, openFromDevice, requestKeyPair, sealForDevice,
  unlockWithRecoveryKey,
} from "./recovery";
import {
  answerReset, confirmTotp, deleteUserServerAccount, fetchAccount, fetchRecoveryCopy, findAccount, githubResult, githubStartUrl, newLogin, ownAccount,
  publishAccount, requestCode, requestFromDevice, resetRequestStatus, startReset, startTotp, turnOffTotp, userServer, UserServerError,
  type GitHubSignIn, type Login, type OwnAccount, setUserServerOffline, type PublicAccount, type ResetRequest, type ResetStart,
  type SecondStep, type Signer,
} from "./userServer";
import { randomSeed } from "../ui/identicon";
import { reloadOnPurpose } from "./leaving";

export interface Account {
  id: string;
  username: string;
  // Tells apart people who share the username (ada·4f2a).
  tag: string;
  email: string | null;
  displayName: string;
  color: string;
  // What others see: the uploaded picture (data URL), else "gen:<seed>".
  avatar: string;
  avatarSeed: string;
  avatarImage: string | null;
  google?: { sub: string; email: string; picture: string };
  github?: { id: string; login: string };
  hasPassword: boolean;
  // Kept in its Google account's Drive, so every device signing in with it gets this account.
  inDrive: boolean;
  // The public half of the account's key; peers check signatures with it.
  publicKey: { x: string; y: string };
  // The user server it was last published to, and the one it can be signed in on with its password.
  publishedTo: string | null;
  loginOn: string | null;
  // A local account that was never published (offline mode). Registering it later keeps this id.
  offline?: boolean;
  // Temporarily disconnected on this device; unlike `offline`, this account is still published.
  offlineMode?: boolean;
}

interface StoredAccount {
  id: string;
  username: string;
  displayName: string;
  color: string;
  avatarSeed?: string;
  avatarImage?: string | null;
  // When the profile (name, color, avatar) was last changed here; the user server keeps the newest across devices.
  profileUpdatedAt?: number;
  publicKey: JsonWebKey;
  createdAt: string;
  google?: { sub: string; email: string; picture: string };
  locked?: LockedKey;
  key?: CryptoKey;
  agreementKey?: CryptoKey;
  inDrive?: boolean;
  publishedTo?: string;
  loginOn?: string;
  // Made with the password while it was known, waiting to go to the user server.
  pendingLogin?: Login;
  email?: string;
  github?: { id: string; login: string };
  // The key, encrypted with this device's own key: lets this device approve a password reset elsewhere, change the
  // password or make a recovery key without asking for the password.
  deviceCopy?: { iv: string; data: string };
  // A local account that was never published (offline mode). Registering it later keeps this id.
  offline?: boolean;
  offlineMode?: boolean;
}

// A whole account as a file: an export (key locked with the account's password) or the copy in Google Drive (key
// as PKCS#8 in `privateKey`, protected by Google's access control instead).
export interface AccountFile {
  makework: "account";
  v: 1;
  id: string;
  username: string;
  displayName: string;
  color: string;
  avatarSeed?: string;
  avatarImage?: string | null;
  publicKey: JsonWebKey;
  createdAt: string;
  google?: { sub: string; email: string; picture: string };
  locked?: LockedKey;
  privateKey?: string;
}

interface Session {
  accountId: string;
  key: CryptoKey;
  agreementKey?: CryptoKey;
}

interface Keys {
  key: CryptoKey;
  // Null for sessions saved before private messages; signing in again with the password gives one.
  agreementKey: CryptoKey | null;
}

export type AccountSync =
  | { state: "idle" | "syncing" | "ok" | "local" }
  | { state: "offline" | "error"; message: string };

const sessionKey = "current";
export const avatarColors = ["#c9a27e", "#b3261e", "#8a6d4b", "#5b7c99", "#3a8fb7", "#611f49", "#4f7a3a", "#a35d9b", "#c47f1a"];
export const usernamePattern = /^[a-z0-9._]{2,32}$/;
export const minPasswordLength = 8;
export const passwordRule = `Use at least ${minPasswordLength} characters for the password.`;

const [account, setAccount] = createSignal<Account | null>(null);
const [accountSync, setAccountSync] = createSignal<AccountSync>({ state: "idle" });
export { account, accountSync };
let signingKey: CryptoKey | null = null;
let agreementKey: CryptoKey | null = null;

// The private key of the signed-in account, for signing what it sends to peers.
export function accountKey(): CryptoKey {
  if (!signingKey) throw new Error("Not signed in.");
  return signingKey;
}

// The same key for agreeing on message keys with other accounts (ECDH); null in sessions saved before it existed.
export function accountAgreementKey(): CryptoKey | null {
  return agreementKey;
}

async function keysFrom(pkcs8: Uint8Array<ArrayBuffer>): Promise<Keys> {
  return { key: await importPrivateKey(pkcs8, false), agreementKey: await importAgreementKey(pkcs8) };
}

export class AuthError extends Error {}

export async function listAccounts(): Promise<Account[]> {
  const stored = await dbAll<StoredAccount>("accounts");
  return stored.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).map(toAccount);
}

export async function restoreSession(): Promise<boolean> {
  const session = await dbGet<Session>("sessions", sessionKey);
  const stored = session && await dbGet<StoredAccount>("accounts", session.accountId);
  if (!session || !stored) return false;
  start(stored, { key: session.key, agreementKey: session.agreementKey ?? stored.agreementKey ?? null });
  return true;
}

// Sends the code that confirms the email for a new account.
export function sendSignUpCode(email: string): Promise<void> {
  return requestCode(email, "register");
}

// Makes the account and publishes it with its confirmed email and its login. Fails, keeping nothing, when the code is wrong or the email is in use.
export async function register(input: {
  email: string; code: string; username: string; displayName: string; password: string; remember: boolean;
}) {
  const username = input.username.trim().toLowerCase();
  checkUsername(username);
  if (input.password.length < minPasswordLength) throw new AuthError(passwordRule);
  const identity = await createIdentity(true);
  const pkcs8 = await exportPkcs8(identity.privateKey);
  const locked = await lockPkcs8(pkcs8, input.password);
  const stored: StoredAccount = {
    id: identity.id, username, displayName: input.displayName.trim() || username, color: randomColor(), avatarSeed: randomSeed(),
    publicKey: identity.publicKey, createdAt: new Date().toISOString(), locked, email: input.email.trim().toLowerCase(),
  };
  // Re-imported so the session copy is non-extractable.
  const keys = await keysFrom(pkcs8);
  await publishAccount({ id: stored.id, key: keys.key }, {
    ...publicPart(stored), login: { ...(await newLogin(input.password)), locked }, email: stored.email, code: input.code.trim(),
  });
  stored.publishedTo = stored.loginOn = userServer();
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, input.remember);
}

// Makes a local account that is never published: MakeWork works without signing up. It signs everything like any
// account, so registering it later keeps its id, its workspaces and its history (registerExisting).
export async function createOfflineAccount(remember: boolean): Promise<void> {
  const identity = await createIdentity(true);
  const pkcs8 = await exportPkcs8(identity.privateKey);
  const keys = await keysFrom(pkcs8);
  const stored: StoredAccount = {
    id: identity.id, username: "you", displayName: "You", color: randomColor(), avatarSeed: randomSeed(),
    publicKey: identity.publicKey, createdAt: new Date().toISOString(), offline: true,
  };
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
}

// Turns the signed-in offline account into a published one: the same key goes to the user server with the chosen
// email, username and password, so its id, its members and everything it signed stay the same.
export async function registerExisting(input: {
  email: string; code: string; username: string; displayName: string; password: string; remember: boolean;
}): Promise<void> {
  const username = input.username.trim().toLowerCase();
  checkUsername(username);
  if (input.password.length < minPasswordLength) throw new AuthError(passwordRule);
  const { stored, pkcs8 } = await currentPkcs8();
  if (!stored.offline) throw new AuthError("This account is already on the user server.");
  stored.username = username;
  stored.displayName = input.displayName.trim() || username;
  stored.email = input.email.trim().toLowerCase();
  stored.locked = await lockPkcs8(pkcs8, input.password);
  const keys = await keysFrom(pkcs8);
  await publishAccount({ id: stored.id, key: keys.key }, {
    ...publicPart(stored), login: { ...(await newLogin(input.password)), locked: stored.locked }, email: stored.email, code: input.code.trim(),
  });
  delete stored.offline;
  stored.publishedTo = stored.loginOn = userServer();
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, input.remember);
}

export async function signIn(accountId: string, password: string, remember: boolean): Promise<void> {
  const stored = await dbGet<StoredAccount>("accounts", accountId);
  if (!stored?.locked) throw new AuthError("This account has no password; continue with Google.");
  const pkcs8 = await unlockPkcs8(stored.locked, password);
  if (!pkcs8) throw new AuthError("Wrong password.");
  if (stored.loginOn !== userServer()) stored.pendingLogin = await newLogin(password);
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, await keysFrom(pkcs8), remember);
}

// Signs in with an account kept on the user server, adding it to this device. Accounts from before emails give
// their username instead. The user server hands the key out only with a second step: "totp" asks for a code from
// the account's authenticator app, "email" means it just mailed a code. Nothing happened here yet then; the same
// call with that code (`step`) signs in. (Accounts without either sign in at once.)
export async function signInOnline(
  login: string, password: string, remember: boolean, step?: { kind: SecondStep; code: string },
): Promise<"in" | SecondStep> {
  const email = login.includes("@") ? login.trim().toLowerCase() : null;
  const confirm = { device: deviceLabel(), ...(step ? { [step.kind === "email" ? "code" : "totp"]: step.code } : {}) };
  let online: Awaited<ReturnType<typeof fetchAccount>>;
  try {
    online = await fetchAccount(email ? { email } : { username: login.replace(/^@/, "") }, password, confirm);
  } catch (e) {
    if (e instanceof UserServerError && e.needs) return e.needs;
    throw e;
  }
  const pkcs8 = await unlockPkcs8(online.locked, password);
  if (!pkcs8) throw new AuthError("Wrong password.");
  const publicKey: JsonWebKey = { kty: "EC", crv: "P-256", ...online.publicKey };
  const keys = await keysFrom(pkcs8);
  if (!(await isKeyPair(online.id, keys.key, publicKey))) throw new AuthError("The account on the user server is damaged.");
  const all = await dbAll<StoredAccount>("accounts");
  const stored: StoredAccount = {
    ...all.find((a) => a.id === online.id), ...fromPublic(online), locked: online.locked, publishedTo: userServer(), loginOn: userServer(),
  };
  if (email) stored.email = email;
  delete stored.pendingLogin;
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
  return "in";
}

function fromPublic(online: PublicAccount): StoredAccount {
  const avatar = online.profile.avatar;
  return {
    id: online.id, username: online.username, displayName: online.profile.displayName,
    color: online.profile.color || randomColor(), publicKey: { kty: "EC", crv: "P-256", ...online.publicKey },
    createdAt: new Date(online.createdAt).toISOString(),
    avatarSeed: avatar.startsWith("gen:") ? avatar.slice(4) : randomSeed(), avatarImage: avatar.startsWith("gen:") ? null : avatar || null,
    profileUpdatedAt: online.profile.updatedAt,
  };
}

// Password reset, step 1: an emailed code (sent only if the email has an account).
export function sendResetCode(email: string): Promise<void> {
  return requestCode(email, "reset");
}

// A password reset, or a GitHub sign-in whose key has to come back the same ways (then `githubToken` is set and
// `email` may be empty).
export type PasswordReset = ResetStart & { email: string; githubToken?: string; github?: { id: string; login: string } };

// Step 2: the code proves the email; the answer says how the key can come back.
export async function startPasswordReset(email: string, code: string): Promise<PasswordReset> {
  return { ...(await startReset(email, code)), email: email.trim().toLowerCase() };
}

// Step 3, one of: the user server's copy, the recovery key, or a device that is still signed in.
// The user server hands the copy out once per reset, so the key is kept here for this reset: a later step that fails
// (setting the new password) can be tried again without starting over.
const serverCopies = new Map<string, Promise<string>>();
export async function keyFromServerCopy(reset: ResetStart, totp?: string): Promise<Uint8Array<ArrayBuffer>> {
  let copy = serverCopies.get(reset.token);
  if (!copy) {
    copy = fetchRecoveryCopy(reset.token, totp);
    serverCopies.set(reset.token, copy);
    copy.catch(() => serverCopies.delete(reset.token));
  }
  return fromBase64url(await copy);
}

export async function keyFromRecoveryKey(reset: ResetStart, recoveryKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const pkcs8 = reset.recoveryLocked && await unlockWithRecoveryKey(reset.recoveryLocked, recoveryKey);
  if (!pkcs8) throw new AuthError("That recovery key doesn't fit this account.");
  return pkcs8;
}

// Asks the account's signed-in devices; resolves once one approves. `signal` stops waiting.
export async function keyFromDevice(reset: ResetStart, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const pair = await requestKeyPair();
  const id = await requestFromDevice(reset.token, pair.publicKey, deviceLabel());
  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (signal.aborted) break;
    const { status, sealed } = await resetRequestStatus(reset.token, id);
    if (status === "denied") throw new AuthError("The other device turned the reset down.");
    if (status === "approved" && sealed) {
      const pkcs8 = await openFromDevice(sealed, pair.privateKey);
      if (!pkcs8) throw new AuthError("The other device sent something this one can't open.");
      return pkcs8;
    }
  }
  throw new AuthError("Stopped waiting.");
}

// Step 4: the key back, locked with the new password, and signed in. A GitHub sign-in has no password (null): the
// key then stays on this device like a Google account's.
export async function finishPasswordReset(
  reset: PasswordReset, pkcs8: Uint8Array<ArrayBuffer>, password: string | null, remember: boolean,
): Promise<void> {
  if (password !== null && password.length < minPasswordLength) throw new AuthError(passwordRule);
  const keys = await keysFrom(pkcs8);
  const online = reset.account;
  const publicKey: JsonWebKey = { kty: "EC", crv: "P-256", ...online.publicKey };
  if (!(await isKeyPair(online.id, keys.key, publicKey))) throw new AuthError("That key belongs to another account.");
  const all = await dbAll<StoredAccount>("accounts");
  const stored: StoredAccount = { ...all.find((a) => a.id === online.id), ...fromPublic(online) };
  if (reset.email) stored.email = reset.email;
  if (reset.github) stored.github = reset.github;
  delete stored.pendingLogin;
  if (password !== null) {
    stored.locked = await lockPkcs8(pkcs8, password);
    await publishAccount({ id: stored.id, key: keys.key }, { ...publicPart(stored), login: { ...(await newLogin(password)), locked: stored.locked } });
    stored.loginOn = userServer();
  } else if (!stored.locked) {
    stored.key = keys.key;
    stored.agreementKey = keys.agreementKey ?? undefined;
  }
  stored.publishedTo = userServer();
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
}

// Opens GitHub (the system browser on desktop, else a popup) and fetches the user server's answer with the one-time
// code it sent back to this device: a loopback port on desktop, public/github-callback.html in the browser.
async function signInWithGitHub(signal: AbortSignal): Promise<GitHubSignIn> {
  const session = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const once = desktop?.githubSignIn ? await desktopGitHubCode(session, signal) : await popupGitHubCode(session, signal);
  return githubResult(session, once);
}

async function desktopGitHubCode(session: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new AuthError("Sign-in was cancelled.");
  const stop = () => void desktop!.githubCancel?.();
  signal.addEventListener("abort", stop);
  try {
    return await desktop!.githubSignIn!({ server: userServer(), session });
  } catch (e) {
    throw new AuthError(desktopError(e).message);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function popupGitHubCode(session: string, signal: AbortSignal): Promise<string> {
  const popup = window.open(githubStartUrl(session, location.origin), "makework-github", "popup,width=520,height=720");
  if (!popup) return Promise.reject(new AuthError("The sign-in popup was blocked."));
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel("makework-github");
    const done = () => {
      channel.close();
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancelled);
    };
    const fail = (message: string) => {
      done();
      popup.close();
      reject(new AuthError(message));
    };
    const cancelled = () => fail("Sign-in was cancelled.");
    channel.onmessage = (event: MessageEvent<{ once?: string | null }>) => {
      if (!event.data?.once) return;
      done();
      resolve(event.data.once);
    };
    // Not `popup.closed`: GitHub's pages cut the popup off from this window (Cross-Origin-Opener-Policy), and then it
    // reads as closed while the person is still signing in. Cancel (the signal) or the time limit end the wait.
    const timeout = setTimeout(() => fail("Sign-in took too long. Try again."), 10 * 60_000);
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled);
  });
}

// What a GitHub sign-in did: signed in here, a key that has to come back another way, or a GitHub user no account is
// linked to yet. The last one (with `createIfUnlinked` false) is left to the person when this device has accounts.
export type GitHubOutcome =
  | { kind: "in" }
  | { kind: "reset"; reset: PasswordReset }
  | { kind: "unlinked"; result: GitHubSignIn };

// Signs in with GitHub: the linked account (its key from this device, else the recovery copy), or a new account.
export async function continueWithGitHub(remember: boolean, signal: AbortSignal, createIfUnlinked: boolean): Promise<GitHubOutcome> {
  const result = await signInWithGitHub(signal);
  if (!result.account || !result.reset) {
    if (!createIfUnlinked) return { kind: "unlinked", result };
    await newGitHubAccount(result, remember);
    return { kind: "in" };
  }
  const reset: PasswordReset = { ...result.reset, account: result.account, email: "", githubToken: result.githubToken, github: result.github };
  const here = await dbGet<StoredAccount>("accounts", result.account.id);
  const local = here?.deviceCopy ? await deviceOpen(here.deviceCopy, await deviceKey()) : null;
  if (local) await finishPasswordReset(reset, local, null, remember);
  else if (reset.recoveryCopy && !reset.totp) await finishPasswordReset(reset, await keyFromServerCopy(reset), null, remember);
  else return { kind: "reset", reset };
  return { kind: "in" };
}

// Makes a fresh account for a GitHub user nothing is linked to yet (the person chose that).
export function createAccountWithGitHub(result: GitHubSignIn, remember: boolean): Promise<void> {
  return newGitHubAccount(result, remember);
}

async function newGitHubAccount(result: GitHubSignIn, remember: boolean): Promise<void> {
  const identity = await createIdentity(true);
  const pkcs8 = await exportPkcs8(identity.privateKey);
  const keys = await keysFrom(pkcs8);
  const stored: StoredAccount = {
    id: identity.id, username: usernameFrom(result.github.login), displayName: result.github.name || result.github.login,
    color: randomColor(), avatarSeed: randomSeed(), publicKey: identity.publicKey, createdAt: new Date().toISOString(),
    github: { id: result.github.id, login: result.github.login }, key: keys.key, agreementKey: keys.agreementKey ?? undefined,
  };
  await publishAccount({ id: stored.id, key: keys.key }, { ...publicPart(stored), githubToken: result.githubToken });
  stored.publishedTo = userServer();
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
}

// Links a GitHub user to the signed-in account (moving it off another account it was linked to).
export async function connectGitHub(signal: AbortSignal): Promise<void> {
  const result = await signInWithGitHub(signal);
  const stored = await currentStored();
  await publishAccount(signer(), { ...publicPart(stored), githubToken: result.githubToken });
  stored.github = { id: result.github.id, login: result.github.login };
  await dbPut("accounts", stored);
  setAccount(toAccount(stored));
}

// When the key can't come back: a new account (new key and id) takes over the email. Servers and friends see a new person.
// A GitHub sign-in (no password) moves the GitHub link instead of the email.
export async function resetToFreshAccount(reset: PasswordReset, password: string | null, remember: boolean): Promise<void> {
  if (password !== null && password.length < minPasswordLength) throw new AuthError(passwordRule);
  const identity = await createIdentity(true);
  const pkcs8 = await exportPkcs8(identity.privateKey);
  const keys = await keysFrom(pkcs8);
  const old = reset.account;
  const stored: StoredAccount = {
    id: identity.id, username: old.username, displayName: old.profile.displayName, color: old.profile.color || randomColor(),
    avatarSeed: randomSeed(), publicKey: identity.publicKey, createdAt: new Date().toISOString(),
  };
  if (password !== null) stored.locked = await lockPkcs8(pkcs8, password);
  else Object.assign(stored, { key: keys.key, agreementKey: keys.agreementKey ?? undefined });
  if (reset.githubToken) stored.github = reset.github;
  else stored.email = reset.email;
  await publishAccount({ id: stored.id, key: keys.key }, {
    ...publicPart(stored),
    ...(stored.locked && password !== null ? { login: { ...(await newLogin(password)), locked: stored.locked } } : {}),
    ...(reset.githubToken ? { githubToken: reset.githubToken } : { email: stored.email, resetToken: reset.token }),
  });
  stored.publishedTo = userServer();
  if (stored.locked) stored.loginOn = userServer();
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
}

// Signs in to the Google account's MakeWork account: the one kept in its Drive, else (made before accounts were
// kept there) one linked to it on this device, else a new one, saved to its Drive.
export async function continueWithGoogle(remember: boolean, loginHint?: string): Promise<void> {
  const google = await signInWithGoogle(loginHint);
  const all = await dbAll<StoredAccount>("accounts");
  const saved = await readDriveAccount<AccountFile>(google.accessToken);
  if (saved) {
    const file = checkFile(saved);
    if (!file.privateKey) throw new AuthError("The account in your Google Drive has no key.");
    const keys = await keysFrom(fromBase64url(file.privateKey));
    if (!(await isKeyPair(file.id, keys.key, file.publicKey))) throw new AuthError("The account in your Google Drive is damaged.");
    const stored = all.find((a) => a.id === file.id) ?? fromFile(file);
    stored.google = googleLink(google);
    stored.key = keys.key;
    stored.agreementKey = keys.agreementKey ?? undefined;
    stored.inDrive = true;
    await keepDeviceCopy(stored, fromBase64url(file.privateKey));
    await dbPut("accounts", stored);
    return begin(stored, keys, remember);
  }
  // Its key can't be read back out to save it to Drive, so it stays an account of this device only.
  const linked = all.find((a) => a.google?.sub === google.sub && a.key);
  // (Drive accounts below get a device copy; ones linked here only have a key that can't be read out.)
  if (linked?.key) return begin(linked, { key: linked.key, agreementKey: linked.agreementKey ?? null }, remember);

  const identity = await createIdentity(true);
  const stored: StoredAccount = {
    id: identity.id, username: usernameFrom(google.email.split("@")[0] || google.name), displayName: google.name,
    color: randomColor(), avatarSeed: randomSeed(), publicKey: identity.publicKey, createdAt: new Date().toISOString(),
    google: googleLink(google), inDrive: true,
  };
  const pkcs8 = await exportPkcs8(identity.privateKey);
  await writeDriveAccount(google.accessToken, { ...toFile(stored), privateKey: base64url(pkcs8) }, replacedName());
  const keys = await keysFrom(pkcs8);
  stored.key = keys.key;
  stored.agreementKey = keys.agreementKey ?? undefined;
  await keepDeviceCopy(stored, pkcs8);
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
}

// The signed-in password account as a file, its key locked with the account's password.
export async function exportAccount(): Promise<{ fileName: string; text: string }> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored?.locked) throw new AuthError("Only accounts with a password can be exported.");
  return { fileName: `${stored.username}.makework-account.json`, text: JSON.stringify(toFile(stored), null, 2) };
}

// Adds an account file to this device and signs in to it. A file linked to a Google account becomes the account
// in that Google account's Drive (replacing one there), so it needs the same Google sign-in.
export async function importAccount(text: string, password: string, remember: boolean): Promise<void> {
  let file: AccountFile;
  try {
    file = checkFile(JSON.parse(text));
  } catch {
    throw new AuthError("That isn't a MakeWork account file.");
  }
  if (!file.locked) throw new AuthError("That account file has no key in it.");
  const pkcs8 = await unlockPkcs8(file.locked, password);
  if (!pkcs8) throw new AuthError("Wrong password.");
  const keys = await keysFrom(pkcs8);
  if (!(await isKeyPair(file.id, keys.key, file.publicKey))) throw new AuthError("That account file is damaged.");
  const all = await dbAll<StoredAccount>("accounts");
  const others = all.filter((a) => a.id !== file.id);

  if (file.google) {
    const google = await signInWithGoogle(file.google.email || undefined);
    // A recovered account may know only the email.
    const same = file.google.sub ? google.sub === file.google.sub : google.email.toLowerCase() === file.google.email.toLowerCase();
    if (!same) throw new AuthError(`This account belongs to ${file.google.email}. Sign in with that Google account.`);
    const stored: StoredAccount = {
      ...fromFile(file), google: googleLink(google), key: keys.key, agreementKey: keys.agreementKey ?? undefined, inDrive: true,
    };
    delete stored.locked;
    await writeDriveAccount(google.accessToken, { ...toFile(stored), privateKey: base64url(pkcs8) }, replacedName());
    await dbPut("accounts", stored);
    return begin(stored, keys, remember);
  }
  if (others.length !== all.length) throw new AuthError("This account is already on this device. Sign in with it.");
  const stored: StoredAccount = { ...fromFile(file), pendingLogin: await newLogin(password) };
  await dbPut("accounts", stored);
  await begin(stored, keys, remember);
}

export async function updateProfile(changes: {
  displayName?: string; color?: string; avatarSeed?: string; avatarImage?: string | null;
}): Promise<void> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored) return;
  if (changes.displayName !== undefined) stored.displayName = changes.displayName.trim() || stored.username;
  if (changes.color !== undefined) stored.color = changes.color;
  if (changes.avatarSeed !== undefined) stored.avatarSeed = changes.avatarSeed;
  if (changes.avatarImage !== undefined) stored.avatarImage = changes.avatarImage;
  stored.profileUpdatedAt = Date.now();
  await dbPut("accounts", stored);
  setAccount(toAccount(stored));
  void syncAccount();
}

// Temporarily stops network activity without changing whether this account is published. This is per device; the
// regular online/DND/hidden choice is synced separately with the account's preferences.
export async function setOfflineMode(value: boolean): Promise<void> {
  const current = account();
  if (!current || current.offline || current.offlineMode === value) return;
  const stored = await dbGet<StoredAccount>("accounts", current.id);
  if (!stored) return;
  stored.offlineMode = value;
  if (value) setUserServerOffline(true);
  try {
    await dbPut("accounts", stored);
  } catch (e) {
    if (value) setUserServerOffline(!!current.offlineMode);
    throw e;
  }
  if (!value) setUserServerOffline(false);
  setAccount(toAccount(stored));
  if (value) setAccountSync({ state: "local" });
  else void syncAccount();
}

export async function renameAccount(username: string): Promise<void> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored) return;
  const name = username.trim().replace(/^@/, "").toLowerCase();
  if (name === stored.username) return;
  checkUsername(name);
  stored.username = name;
  await dbPut("accounts", stored);
  setAccount(toAccount(stored));
  await syncAccount();
}

// Lets the password account be signed in to on other computers through the current user server.
export async function allowSignInElsewhere(password: string): Promise<void> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored?.locked) throw new AuthError("Only accounts with a password can sign in this way.");
  if (!(await unlockPkcs8(stored.locked, password))) throw new AuthError("Wrong password.");
  stored.pendingLogin = await newLogin(password);
  await dbPut("accounts", stored);
  await syncAccount();
  const result = accountSync();
  if (result.state === "offline" || result.state === "error") throw new AuthError(result.message);
}

// What the user server knows of the signed-in account that is only for its owner: email and recovery settings.
export async function ownAccountInfo(): Promise<OwnAccount> {
  return ownAccount(signer());
}

export function sendEmailCode(email: string): Promise<void> {
  return requestCode(email, "register");
}

// Adds or changes the account's email, with the code sent to it.
export async function setEmail(email: string, code: string): Promise<void> {
  const stored = await currentStored();
  await publishAccount(signer(), { ...publicPart(stored), email, code: code.trim() });
  stored.email = email.trim().toLowerCase();
  await dbPut("accounts", stored);
  setAccount(toAccount(stored));
}

// Authenticator app setup for the signed-in account; see core/userServer.ts.
export function beginTotp(): Promise<{ secret: string; uri: string }> {
  return startTotp(signer());
}

export function finishTotp(code: string): Promise<string[]> {
  return confirmTotp(signer(), code);
}

export function removeTotp(code: string): Promise<void> {
  return turnOffTotp(signer(), code);
}

export class NeedsPassword extends AuthError {
  constructor() {
    super("Enter your password to do this on this device.");
  }
}

// The key's bytes for the signed-in account: from this device's copy, else from the Google account's Drive (a
// Google sign-in), else unlocked with the password. Whichever worked leaves a device copy for next time.
async function currentPkcs8(password?: string): Promise<{ stored: StoredAccount; pkcs8: Uint8Array<ArrayBuffer> }> {
  const stored = await currentStored();
  const device = await deviceKey();
  let pkcs8 = stored.deviceCopy ? await deviceOpen(stored.deviceCopy, device) : null;
  if (!pkcs8 && stored.google && stored.inDrive && !stored.locked) {
    const google = await signInWithGoogle(stored.google.email);
    const saved = await readDriveAccount<AccountFile>(google.accessToken);
    const file = saved ? checkFile(saved) : null;
    if (file?.id !== stored.id || !file.privateKey) throw new AuthError(`This account's key isn't in the Google Drive of ${google.email}.`);
    pkcs8 = fromBase64url(file.privateKey);
  } else if (!pkcs8 && password !== undefined && stored.locked) {
    pkcs8 = await unlockPkcs8(stored.locked, password);
    if (!pkcs8) throw new AuthError("Wrong password.");
  }
  if (!pkcs8) {
    if (stored.locked) throw new NeedsPassword();
    if (stored.google && !stored.inDrive)
      throw new AuthError("This account was made before accounts were saved to Google Drive, so its key can't be read out to do this.");
    throw new AuthError("This computer can't read this account's key. Sign out and sign in again here to do this.");
  }
  if (!stored.deviceCopy) {
    await keepDeviceCopy(stored, pkcs8);
    await dbPut("accounts", stored);
  }
  return { stored, pkcs8 };
}

export async function changePassword(next: string, current?: string): Promise<void> {
  if (next.length < minPasswordLength) throw new AuthError(passwordRule);
  const { stored, pkcs8 } = await currentPkcs8(current);
  const locked = await lockPkcs8(pkcs8, next);
  await publishAccount(signer(), { ...publicPart(stored), login: { ...(await newLogin(next)), locked } });
  stored.locked = locked;
  stored.loginOn = userServer();
  delete stored.pendingLogin;
  await dbPut("accounts", stored);
  setAccount(toAccount(stored));
}

// A new recovery key (replacing any old one); shown to the user once, never kept here.
export async function createRecoveryKey(password?: string): Promise<string> {
  const { stored, pkcs8 } = await currentPkcs8(password);
  const recoveryKey = newRecoveryKey();
  await publishAccount(signer(), { ...publicPart(stored), recoveryLocked: await lockWithRecoveryKey(pkcs8, recoveryKey) });
  return recoveryKey;
}

export async function setRecoveryCopy(on: boolean, password?: string): Promise<void> {
  if (!on) {
    await publishAccount(signer(), { ...publicPart(await currentStored()), recoveryCopy: null });
    return;
  }
  const { stored, pkcs8 } = await currentPkcs8(password);
  await publishAccount(signer(), { ...publicPart(stored), recoveryCopy: base64url(pkcs8) });
}

// A password reset started elsewhere: approving hands the key over, sealed for that device only.
export async function approveReset(request: ResetRequest, password?: string): Promise<void> {
  const { pkcs8 } = await currentPkcs8(password);
  await answerReset(signer(), request.id, await sealForDevice(pkcs8, request.publicKey));
}

export function denyReset(request: ResetRequest): Promise<void> {
  return answerReset(signer(), request.id, null);
}

function signer(): Signer {
  const current = account();
  if (!current || !signingKey) throw new AuthError("Not signed in.");
  return { id: current.id, key: signingKey };
}

async function currentStored(): Promise<StoredAccount> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored) throw new AuthError("Not signed in.");
  return stored;
}

function publicPart(stored: StoredAccount) {
  return {
    username: stored.username,
    publicKey: { x: stored.publicKey.x!, y: stored.publicKey.y! },
    profile: { displayName: stored.displayName, color: stored.color, avatar: toAccount(stored).avatar, updatedAt: stored.profileUpdatedAt ?? 0 },
  };
}

// Takes another device's profile (the user server keeps the newest) into the stored account. True when it changed.
function applyProfile(stored: StoredAccount, profile: PublicAccount["profile"]): boolean {
  const next = { ...stored };
  next.displayName = profile.displayName;
  next.color = profile.color;
  if (profile.avatar.startsWith("gen:")) {
    next.avatarSeed = profile.avatar.slice(4);
    next.avatarImage = null;
  } else if (profile.avatar) next.avatarImage = profile.avatar;
  next.profileUpdatedAt = profile.updatedAt ?? stored.profileUpdatedAt;
  const changed = next.displayName !== stored.displayName || next.color !== stored.color
    || next.avatarSeed !== stored.avatarSeed || next.avatarImage !== stored.avatarImage;
  Object.assign(stored, next);
  return changed;
}

// Brings a profile changed on another device (name, color or avatar). Anything changed here since wins.
export async function pullProfile(): Promise<void> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored) return;
  const remote = await findAccount({ id: stored.id });
  if (!remote || (remote.profile.updatedAt ?? 0) < (stored.profileUpdatedAt ?? 0)) return;
  if (!applyProfile(stored, remote.profile)) return;
  await dbPut("accounts", stored);
  if (account()?.id === stored.id) setAccount(toAccount(stored));
}

let watchingProfile = false;
let lastProfilePull = 0;
// Looks for a profile changed on another device: on start and then at most every 5 minutes when the window gets focus.
export function watchProfile(): void {
  if (watchingProfile) return;
  watchingProfile = true;
  const pull = () => {
    if (Date.now() - lastProfilePull < 5 * 60_000) return;
    lastProfilePull = Date.now();
    void pullProfile().catch((e) => {
      if (!(e instanceof UserServerError)) console.warn("Checking the account profile failed:", e);
    });
  };
  pull();
  window.addEventListener("focus", pull);
}

let pulling: Promise<void> | null = null;
// The account with the newest profile the user server knows, for sending to a workspace as it connects: waits for a
// running sync, pulls when the profile wasn't checked in the last minute (one pull for workspaces opening together),
// and gives up after `maxWaitMs` (offline, the local profile is the newest there is).
export async function freshProfile(maxWaitMs = 5000): Promise<Account | null> {
  const check = syncing.then(() => {
    if (pulling || Date.now() - lastProfilePull < 60_000) return pulling ?? undefined;
    lastProfilePull = Date.now();
    pulling = pullProfile().finally(() => {
      pulling = null;
    });
    return pulling;
  }).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([check, new Promise((resolve) => (timer = setTimeout(resolve, maxWaitMs)))]);
  clearTimeout(timer);
  return account();
}

// One AES key per device, never extractable, kept with the sessions.
async function deviceKey(): Promise<CryptoKey> {
  const existing = await dbGet<CryptoKey>("sessions", "device");
  if (existing) return existing;
  const key = await newDeviceKey();
  await dbPut("sessions", key, "device");
  return key;
}

async function keepDeviceCopy(stored: StoredAccount, pkcs8: Uint8Array<ArrayBuffer>): Promise<void> {
  stored.deviceCopy = await deviceSeal(pkcs8, await deviceKey());
}

let syncing: Promise<void> = Promise.resolve();

// Resolves once the running publish is done; check `accountSync()` for how it went.
export function accountPublished(): Promise<void> {
  return syncing;
}

// Publishes the signed-in account (username, public key, profile, and the login if one is waiting) to the user
// server. Runs after every sign-in and profile change, and when the user server changes.
export function syncAccount(): Promise<void> {
  syncing = syncing.then(publish, publish);
  return syncing;
}

async function publish(): Promise<void> {
  const current = account();
  const stored = current && await dbGet<StoredAccount>("accounts", current.id);
  if (!stored || !signingKey) return;
  // An offline account isn't published; there is nothing to sync until it is registered.
  if (stored.offline || stored.offlineMode) {
    setAccountSync({ state: "local" });
    return;
  }
  const url = userServer();
  setAccountSync({ state: "syncing" });
  try {
    const result = await publishAccount({ id: stored.id, key: signingKey }, {
      ...publicPart(stored),
      login: stored.pendingLogin && stored.locked ? { ...stored.pendingLogin, locked: stored.locked } : undefined,
    });
    // The user server keeps the newest profile across devices; take it when another device's is newer. An older user
    // server sends none: reading it failed the sync ("Cannot read properties of undefined (reading 'displayName')").
    if (result.profile) {
      applyProfile(stored, result.profile);
      lastProfilePull = Date.now();
    }
    stored.publishedTo = url;
    if (stored.pendingLogin) stored.loginOn = url;
    delete stored.pendingLogin;
    await dbPut("accounts", stored);
    if (account()?.id === stored.id) setAccount(toAccount(stored));
    setAccountSync({ state: "ok" });
  } catch (e) {
    if (account()?.id === stored.id && account()?.offlineMode) {
      setAccountSync({ state: "local" });
      return;
    }
    if (e instanceof UserServerError && e.status === 410 && account()?.id === stored.id) {
      await forgetAccount(stored.id);
      reloadOnPurpose();
      return;
    }
    if (!(e instanceof UserServerError)) console.warn("Publishing the account failed:", e);
    const message = e instanceof Error ? e.message : String(e);
    setAccountSync(e instanceof UserServerError && e.offline ? { state: "offline", message } : { state: "error", message });
  }
}

// Reloads, so every workspace connection and view starts over for the next account.
export async function signOut(): Promise<void> {
  await dbDelete("sessions", sessionKey);
  reloadOnPurpose();
}

// Deletes the signed-in account from the user server, with everything kept there for it, then from this device.
// A Google account's copy in its Drive goes first, or signing in with Google again would bring the account back.
export async function deleteAccount(): Promise<void> {
  const stored = await currentStored();
  if (stored.inDrive && stored.google) await deleteDriveAccounts((await signInWithGoogle(stored.google.email)).accessToken);
  await deleteUserServerAccount(signer());
  await forgetAccount(stored.id);
  reloadOnPurpose();
}

// Removes the account from this device (its device copy of the key is part of the stored account), and its remembered
// session. Its servers and messages stay, for when it signs in here again.
export async function forgetAccount(accountId: string): Promise<void> {
  const session = await dbGet<Session>("sessions", sessionKey);
  if (session?.accountId === accountId) await dbDelete("sessions", sessionKey);
  await dbDelete("accounts", accountId);
}

async function begin(stored: StoredAccount, keys: Keys, remember: boolean) {
  const session: Session = { accountId: stored.id, key: keys.key, ...(keys.agreementKey && { agreementKey: keys.agreementKey }) };
  if (remember) await dbPut("sessions", session, sessionKey);
  else await dbDelete("sessions", sessionKey);
  start(stored, keys);
}

function start(stored: StoredAccount, keys: Keys) {
  signingKey = keys.key;
  agreementKey = keys.agreementKey;
  setUserServerOffline(!!stored.offlineMode);
  // Accounts made before generated avatars get theirs on first sign-in.
  if (!stored.avatarSeed) {
    stored.avatarSeed = randomSeed();
    void dbPut("accounts", stored);
  }
  setAccount(toAccount(stored));
  void syncAccount();
}

function toFile(stored: StoredAccount): AccountFile {
  return {
    makework: "account", v: 1, id: stored.id, username: stored.username, displayName: stored.displayName,
    color: stored.color, avatarSeed: stored.avatarSeed, avatarImage: stored.avatarImage ?? null,
    publicKey: stored.publicKey, createdAt: stored.createdAt, google: stored.google, locked: stored.locked,
  };
}

function fromFile(file: AccountFile): StoredAccount {
  return {
    id: file.id, username: file.username, displayName: file.displayName, color: file.color,
    avatarSeed: file.avatarSeed, avatarImage: file.avatarImage ?? null, publicKey: file.publicKey,
    createdAt: file.createdAt, google: file.google, locked: file.locked,
  };
}

function checkFile(value: unknown): AccountFile {
  const file = value as AccountFile;
  if (file?.makework !== "account" || file.v !== 1 || typeof file.id !== "string" || typeof file.username !== "string"
    || !file.publicKey?.x || !file.publicKey?.y) throw new AuthError("That isn't a MakeWork account.");
  return file;
}

const googleLink = (google: GoogleProfile) => ({ sub: google.sub, email: google.email, picture: google.picture });
const replacedName = () => `account-replaced-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

function toAccount(stored: StoredAccount): Account {
  return {
    id: stored.id, username: stored.username, tag: accountTag(stored.id), email: stored.email ?? null,
    displayName: stored.displayName, color: stored.color,
    avatar: stored.avatarImage || `gen:${stored.avatarSeed ?? stored.username}`,
    avatarSeed: stored.avatarSeed ?? stored.username, avatarImage: stored.avatarImage ?? null,
    google: stored.google, github: stored.github, hasPassword: !!stored.locked, inDrive: !!stored.inDrive, publicKey: { x: stored.publicKey.x!, y: stored.publicKey.y! },
    publishedTo: stored.publishedTo ?? null, loginOn: stored.loginOn ?? null, offline: !!stored.offline,
    offlineMode: !!stored.offlineMode,
  };
}

// Anyone may share a username; the tag from the account id tells them apart.
function checkUsername(username: string) {
  if (!usernamePattern.test(username))
    throw new AuthError("Usernames are 2 to 32 characters: lowercase letters, digits, dots and underscores.");
}

function usernameFrom(wanted: string): string {
  return wanted.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 32).padEnd(2, "_");
}

function randomColor() {
  return avatarColors[Math.floor(Math.random() * avatarColors.length)];
}
