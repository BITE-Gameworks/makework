// Getting an account's key back after a forgotten password: recovery keys (the owner keeps one, the user server a
// copy of the account key locked with it) and handing the key from a device still signed in to the one resetting.
import { base64url, fromBase64url, lockPkcs8, unlockPkcs8, type LockedKey } from "./identity";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// 24 characters of 32 = 120 bits: guessing it is hopeless, so fewer PBKDF2 rounds than a password needs.
const recoveryIterations = 100_000;

// Like "K7QF-2MXA-9PLE-W3RT-HN8D-C4VZ".
export function newRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

// Spaces, dashes and case don't matter when it is typed back.
function cleanRecoveryKey(input: string): string {
  const chars = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return chars.match(/.{1,4}/g)?.join("-") ?? "";
}

export const lockWithRecoveryKey = (pkcs8: Uint8Array<ArrayBuffer>, recoveryKey: string) =>
  lockPkcs8(pkcs8, cleanRecoveryKey(recoveryKey), recoveryIterations);

export const unlockWithRecoveryKey = (locked: LockedKey, recoveryKey: string) => unlockPkcs8(locked, cleanRecoveryKey(recoveryKey));

const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;

// The resetting device's one-time key pair; the public half goes to the user server with the request.
export async function requestKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: { x: string; y: string } }> {
  const pair = await crypto.subtle.generateKey(ecdh, false, ["deriveKey"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: { x: jwk.x!, y: jwk.y! } };
}

async function sharedKey(privateKey: CryptoKey, publicKey: { x: string; y: string }): Promise<CryptoKey> {
  const theirs = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...publicKey }, ecdh, false, []);
  return crypto.subtle.deriveKey({ name: "ECDH", public: theirs }, privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// On the approving device: the account key sealed so only the requesting device can open it.
export async function sealForDevice(pkcs8: Uint8Array<ArrayBuffer>, requester: { x: string; y: string }): Promise<string> {
  const mine = await requestKeyPair();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sharedKey(mine.privateKey, requester), pkcs8);
  return JSON.stringify({ publicKey: mine.publicKey, iv: base64url(iv), data: base64url(new Uint8Array(data)) });
}

export async function openFromDevice(sealed: string, privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const { publicKey, iv, data } = JSON.parse(sealed) as { publicKey: { x: string; y: string }; iv: string; data: string };
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await sharedKey(privateKey, publicKey), fromBase64url(data)));
  } catch {
    return null;
  }
}

// A copy of the account key only this device can open, made at sign-in while the key's bytes are at hand, so this
// device can approve a reset on another one later. Encrypted with a device key that can't leave the browser.
export async function deviceSeal(pkcs8: Uint8Array<ArrayBuffer>, deviceKey: CryptoKey): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, deviceKey, pkcs8);
  return { iv: base64url(iv), data: base64url(new Uint8Array(data)) };
}

export async function deviceOpen(sealed: { iv: string; data: string }, deviceKey: CryptoKey): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(sealed.iv) }, deviceKey, fromBase64url(sealed.data)));
  } catch {
    return null;
  }
}

export function newDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
