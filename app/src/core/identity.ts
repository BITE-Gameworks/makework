import { sha256 } from "@noble/hashes/sha2.js";
import { trimEnd } from "./text";

// A local identity: an ECDSA P-256 key pair kept on the device. Other members will recognise the account by its
// public key, so there is no server that checks passwords. A password only encrypts the private key at rest.

const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
export const defaultIterations = 600_000;

export interface LockedKey {
  salt: string;
  iv: string;
  data: string;
  iterations: number;
}

export interface Identity {
  id: string;
  publicKey: JsonWebKey;
  privateKey: CryptoKey;
}

// The private key is extractable only so it can be locked with a password right away.
export async function createIdentity(extractable: boolean): Promise<Identity> {
  const pair = await crypto.subtle.generateKey(algorithm, extractable, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { id: await accountId(publicKey), publicKey, privateKey: pair.privateKey };
}

// Short, stable id from the public key: the first 16 bytes of its SHA-256, base64url.
export async function accountId(publicKey: JsonWebKey): Promise<string> {
  const text = `${publicKey.crv}:${publicKey.x}:${publicKey.y}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url(new Uint8Array(hash).slice(0, 16));
}

// The same id, worked out synchronously: the policy checks an admin-added node's key against its user id while
// replaying, and replays don't wait.
export function accountIdOf(key: { x: string; y: string }): string {
  return base64url(sha256(new TextEncoder().encode(`P-256:${key.x}:${key.y}`)).slice(0, 16));
}

// What tells apart people who share a username (ada·4f2a): the first two bytes of the account id, as hex. The user
// server computes the same.
export function accountTag(id: string): string {
  try {
    return [...fromBase64url(id).slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

export async function lockKey(privateKey: CryptoKey, password: string, iterations = defaultIterations): Promise<LockedKey> {
  return lockPkcs8(new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey)), password, iterations);
}

export async function lockPkcs8(pkcs8: Uint8Array<ArrayBuffer>, password: string, iterations = defaultIterations): Promise<LockedKey> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await passwordKey(password, salt, iterations), pkcs8);
  return { salt: base64url(salt), iv: base64url(iv), data: base64url(new Uint8Array(data)), iterations };
}

// Null for a wrong password. The key comes back non-extractable.
export async function unlockKey(locked: LockedKey, password: string): Promise<CryptoKey | null> {
  const pkcs8 = await unlockPkcs8(locked, password);
  return pkcs8 && importPrivateKey(pkcs8, false);
}

// The private key's bytes (PKCS#8), or null for a wrong password.
export async function unlockPkcs8(locked: LockedKey, password: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const key = await passwordKey(password, fromBase64url(locked.salt), locked.iterations);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(locked.iv) }, key, fromBase64url(locked.data)));
  } catch {
    return null;
  }
}

export function importPrivateKey(pkcs8: Uint8Array<ArrayBuffer>, extractable: boolean): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8, algorithm, extractable, ["sign"]);
}

// The same private key for ECDH, to agree on the key that encrypts private messages with another account.
export function importAgreementKey(pkcs8: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export async function exportPkcs8(privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
}

// Whether a private key, public key and account id belong together.
export async function isKeyPair(id: string, privateKey: CryptoKey, publicKey: JsonWebKey): Promise<boolean> {
  try {
    return id === await accountId(publicKey) && await verify(publicKey, id, await sign(privateKey, id));
  } catch {
    return false;
  }
}

export async function sign(privateKey: CryptoKey, text: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(text));
  return base64url(new Uint8Array(signature));
}

export async function verify(publicKey: JsonWebKey, text: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("jwk", publicKey, algorithm, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature), new TextEncoder().encode(text));
}

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return trimEnd(btoa(binary).replaceAll("+", "-").replaceAll("/", "_"), "=");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// Claims of a JWT, without checking its signature (only for tokens received straight from Google over TLS).
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Not a JWT.");
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Record<string, unknown>;
}
