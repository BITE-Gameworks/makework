// Sealing chat text with a channel key (ADR 0021): AES-256-GCM, bound to the channel and the author so a sealed text
// can't be moved to another channel or passed off as someone else's. Synchronous, so data handlers can use it.
// A sealed text is "mwe1.<epoch>.<nonce>.<ciphertext>"; anything else is plain text from before encryption.
import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, fromBase64url } from "../core/identity";

const prefix = "mwe1.";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const isSealedText = (text: unknown): text is string => typeof text === "string" && text.startsWith(prefix);

export const newChannelKey = () => crypto.getRandomValues(new Uint8Array(32));

// A short fingerprint of a key, kept with its epoch, so a member can tell a key that was given to them is the one used.
export const keyCheck = (key: Uint8Array) =>
  base64url(sha256(new Uint8Array([...encoder.encode("makework-chat-key-check|"), ...key])).slice(0, 16));

const bound = (channelId: number, authorId: number) => encoder.encode(`makework-chat|${channelId}|${authorId}`);

export function sealText(key: Uint8Array, epoch: number, channelId: number, authorId: number, text: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const data = gcm(key, nonce, bound(channelId, authorId)).encrypt(encoder.encode(text));
  return `${prefix}${epoch}.${base64url(nonce)}.${base64url(data)}`;
}

// The epoch a sealed text needs, or null for plain text.
export function epochOf(text: string): number | null {
  if (!isSealedText(text)) return null;
  const epoch = Number(text.slice(prefix.length).split(".")[0]);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

// Null when the key, channel or author doesn't match, or the text was changed.
export function openText(key: Uint8Array, channelId: number, authorId: number, sealed: string): string | null {
  try {
    const [, nonce, data] = sealed.slice(prefix.length).split(".");
    return decoder.decode(gcm(key, fromBase64url(nonce), bound(channelId, authorId)).decrypt(fromBase64url(data)));
  } catch {
    return null;
  }
}
