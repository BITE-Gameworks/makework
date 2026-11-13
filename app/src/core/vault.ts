// Small documents of the signed-in account kept on the user server, encrypted so only this account can read them
// (the key comes from the account key agreeing with itself, so every computer signed in to it has it). Changes
// merge with what other computers wrote meanwhile.
import { account, accountAgreementKey, accountKey } from "./account";
import { base64url, fromBase64url } from "./identity";
import { readVault, UserServerError, writeVault, type Signer } from "./userServer";

const encoder = new TextEncoder();
let cached: { id: string; key: Promise<CryptoKey> } | null = null;

// Null when this session has no agreement key (sessions saved before private messages).
function access(): { signer: Signer; key: Promise<CryptoKey> } | null {
  const me = account();
  const own = accountAgreementKey();
  if (!me || !own) return null;
  if (cached?.id !== me.id) {
    // A derivation that failed isn't kept, so the next vault access tries again.
    const entry = { id: me.id, key: vaultKey(own, me.publicKey) };
    entry.key.catch(() => {
      if (cached === entry) cached = null;
    });
    cached = entry;
  }
  return { signer: { id: me.id, key: accountKey() }, key: cached.key };
}

async function vaultKey(own: CryptoKey, publicKey: { x: string; y: string }): Promise<CryptoKey> {
  const self = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...publicKey }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: self }, own, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("makework-vault-v1"), info: encoder.encode("vault") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Reads the document, applies `change` and writes it back, again over a newer copy if another computer wrote
// meanwhile. `change` returns null to leave it as it is. Resolves with the document, or null without access.
export async function updateVault<T>(name: string, change: (current: T | null) => T | null): Promise<T | null> {
  // An offline or temporarily disconnected account has no user server access.
  if (account()?.offline || account()?.offlineMode) return null;
  const ready = access();
  if (!ready) return null;
  const key = await ready.key;
  for (let attempt = 0; ; attempt++) {
    const { data, rev } = await readVault(ready.signer, name);
    const current = data === null ? null : await open<T>(key, name, data);
    const next = change(current);
    if (next === null) return current;
    try {
      await writeVault(ready.signer, name, await seal(key, name, next), rev);
      return next;
    } catch (e) {
      if (!(e instanceof UserServerError && e.status === 409) || attempt >= 4) throw e;
    }
  }
}

// The document as it is now, without writing anything; null when there is none or this session has no access.
export async function readVaultDoc<T>(name: string): Promise<T | null> {
  if (account()?.offline || account()?.offlineMode) return null;
  const ready = access();
  if (!ready) return null;
  const { data } = await readVault(ready.signer, name);
  return data === null ? null : open<T>(await ready.key, name, data);
}

async function seal(key: CryptoKey, name: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(name) }, key, encoder.encode(JSON.stringify(value)));
  return `${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}

async function open<T>(key: CryptoKey, name: string, sealed: string): Promise<T> {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(name) }, key, fromBase64url(data));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
