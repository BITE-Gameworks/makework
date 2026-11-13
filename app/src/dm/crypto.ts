// End-to-end encryption of private messages. Two accounts agree on a secret with their account keys (ECDH on
// P-256), so nobody else, the user server included, can read their messages or find their private room. From it
// come the message key (AES-GCM), and the id and password of the room the two meet in when both are online.
import { base64url, fromBase64url } from "../core/identity";
import { compareText } from "../core/text";

export interface PairKeys {
  message: CryptoKey;
  roomId: string;
  roomPassword: string;
}

export interface Attachment {
  hash: string;
  name: string;
  size: number;
  type: string;
  // Small preview of an image, shown until the file is downloaded from the sender.
  thumb: string | null;
  width: number | null;
  height: number | null;
}

export interface Payload {
  text: string;
  attachments: Attachment[];
  // Instead of a new message: a change to an earlier one (`of` its id, `at` its time). Edits and deletes only
  // from its author; a reaction from either side, on or off.
  change?: Change;
}

export type Change =
  | { of: string; at: number; edit: string }
  | { of: string; at: number; delete: true }
  | { of: string; at: number; react: string; on: boolean };

// A message as it travels: who, when, and the encrypted payload. The header is bound to the ciphertext, so it
// can't be changed on the way.
export interface Sealed {
  v: 1;
  id: string;
  from: string;
  to: string;
  at: number;
  iv: string;
  data: string;
}

const encoder = new TextEncoder();

export async function pairKeys(own: CryptoKey, ownId: string, peer: { id: string; publicKey: { x: string; y: string } }): Promise<PairKeys> {
  const peerKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...peer.publicKey },
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, own, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits", "deriveKey"]);
  // Code-unit order, the same on both devices: the pair goes into the key.
  const pair = [ownId, peer.id].sort(compareText).join(":");
  const params = (use: string) => ({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("makework-dm-v1"), info: encoder.encode(`${use}:${pair}`) });
  const bits = async (use: string, length: number) => base64url(new Uint8Array(await crypto.subtle.deriveBits(params(use), base, length)));
  return {
    message: await crypto.subtle.deriveKey(params("message"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    roomId: await bits("room", 128),
    roomPassword: await bits("password", 256),
  };
}

export async function seal(keys: PairKeys, header: Omit<Sealed, "v" | "iv" | "data">, payload: Payload): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: headerBytes(header) }, keys.message,
    encoder.encode(JSON.stringify(payload)));
  return { v: 1, ...header, iv: base64url(iv), data: base64url(new Uint8Array(data)) };
}

// Null when it wasn't sealed with this pair's key or was changed.
export async function unseal(keys: PairKeys, sealed: Sealed): Promise<Payload | null> {
  try {
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(sealed.iv), additionalData: headerBytes(sealed) },
      keys.message, fromBase64url(sealed.data));
    const payload = JSON.parse(new TextDecoder().decode(data)) as Payload;
    const change = changeOf(payload.change);
    return { text: String(payload.text ?? ""), attachments: Array.isArray(payload.attachments) ? payload.attachments : [], ...(change ? { change } : {}) };
  } catch {
    return null;
  }
}

function changeOf(value: unknown): Change | undefined {
  const c = value as Record<string, unknown> | null | undefined;
  if (!c || typeof c.of !== "string" || typeof c.at !== "number") return undefined;
  if (typeof c.edit === "string") return { of: c.of, at: c.at, edit: c.edit };
  if (c.delete === true) return { of: c.of, at: c.at, delete: true };
  if (typeof c.react === "string" && typeof c.on === "boolean") return { of: c.of, at: c.at, react: c.react, on: c.on };
  return undefined;
}

export function isSealed(value: unknown): value is Sealed {
  const s = value as Sealed;
  return s?.v === 1 && typeof s.id === "string" && typeof s.from === "string" && typeof s.to === "string"
    && typeof s.at === "number" && typeof s.iv === "string" && typeof s.data === "string";
}

function headerBytes(header: { id: string; from: string; to: string; at: number }) {
  return encoder.encode(`${header.id}|${header.from}|${header.to}|${header.at}`);
}
