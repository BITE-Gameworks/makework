// Secrets for bots (a model server's key). A credential is a name plus one envelope per holder, each sealed to the
// holder's account key by whoever wrote it (the same sealing as private messages), so the workspace log never holds
// the secret in the clear. Holders are members with "Store credentials" (the owner included) and authorized nodes.
// A holder that opens the app seals existing credentials for holders added since (`shareWithNewHolders`).
import { accountAgreementKey, account } from "./account";
import { workspaceApi } from "./workspaces";
import { workspaceLedger } from "./serverless";
import { standingOf } from "./roles";
import { isSealed, pairKeys, seal, unseal } from "../dm/crypto";
import { userNumberOf } from "../p2p/log";
import { publicKeysOf } from "../p2p/memberKeys";
import type { Row } from "../p2p/permissions";

type Holder = { userId: number; id: string; publicKey: { x: string; y: string } };

const opened = new Map<string, string>();

function holders(workspaceId: string): Holder[] {
  const ledger = workspaceLedger(workspaceId);
  if (!ledger) throw new Error("This workspace is not open.");
  const nodes = new Set(ledger.select("nodes", "nodes_nodes", {}).filter((row) => row.status === "authorized").map((row) => Number(row.user_id)));
  const profiles = new Set(ledger.select("members", "members_profiles", {}).filter((row) => row.bot !== true).map((row) => Number(row.user_id)));
  const owner = ledger.owner;
  return [...publicKeysOf(ledger)].map(([userId, key]) => ({ userId, ...key })).filter((h) =>
    nodes.has(h.userId) || (profiles.has(h.userId) || h.userId === owner) && standingOf(workspaceId, h.userId).permissions.has("store_credentials"));
}

async function sealFor(workspaceId: string, credential: string, secret: string, holder: Holder): Promise<string> {
  const agreement = accountAgreementKey();
  const me = account();
  if (!agreement || !me) throw new Error("This account can't encrypt credentials on this device.");
  const keys = await pairKeys(agreement, me.id, holder);
  return JSON.stringify(await seal(keys, { id: `credential:${workspaceId}:${credential}:${holder.userId}`, from: me.id, to: holder.id, at: Date.now() },
    { text: secret, attachments: [] }));
}

async function sealAll(workspaceId: string, credential: string, secret: string) {
  const all = holders(workspaceId);
  const me = account();
  if (!me || !all.some((h) => h.id === me.id)) throw new Error("You need the Store credentials permission.");
  return JSON.stringify(await Promise.all(all.map(async (h) => ({ user_id: h.userId, sealed: await sealFor(workspaceId, credential, secret, h) }))));
}

export const credentials = (workspaceId: string): Promise<Row[]> => workspaceApi(workspaceId).plugin("bots").read("bots_credentials");

export async function storeCredential(workspaceId: string, name: string, secret: string): Promise<void> {
  if (!secret) throw new Error("Enter the secret.");
  const shares = await sealAll(workspaceId, name, secret);
  await workspaceApi(workspaceId).plugin("bots").call("credential-create", { name, shares });
}

export async function replaceCredential(workspaceId: string, id: number, name: string, secret: string): Promise<void> {
  const shares = await sealAll(workspaceId, name, secret);
  await workspaceApi(workspaceId).plugin("bots").call("credential-replace", { id, shares });
  opened.delete(`${workspaceId}:${id}`);
}

export async function removeCredential(workspaceId: string, id: number): Promise<void> {
  await workspaceApi(workspaceId).plugin("bots").call("credential-remove", { id });
  opened.delete(`${workspaceId}:${id}`);
}

// The secret, if this account holds it; null otherwise.
export async function credentialSecret(workspaceId: string, id: number): Promise<string | null> {
  const cached = opened.get(`${workspaceId}:${id}`);
  if (cached !== undefined) return cached;
  const ledger = workspaceLedger(workspaceId);
  const agreement = accountAgreementKey();
  const me = account();
  if (!ledger || !agreement || !me) return null;
  const share = ledger.select("bots", "bots_credential_shares", { credential_id: id, user_id: ledger.me })[0];
  if (!share) return null;
  const sealed: unknown = JSON.parse(String(share.sealed));
  if (!isSealed(sealed) || sealed.to !== me.id) return null;
  // Whoever sealed it, holder or not any more.
  const sender = publicKeysOf(ledger).get(userNumberOf(sealed.from));
  if (!sender || sender.id !== sealed.from) return null;
  const payload = await unseal(await pairKeys(agreement, me.id, sender), sealed);
  if (!payload?.text) return null;
  opened.set(`${workspaceId}:${id}`, payload.text);
  return payload.text;
}

// Seals every credential this account can read for holders that have none yet (a new administrator, a new node).
export async function shareWithNewHolders(workspaceId: string): Promise<void> {
  const ledger = workspaceLedger(workspaceId);
  if (!ledger || !account()) return;
  const rows = ledger.select("bots", "bots_credentials", {});
  if (!rows.length) return;
  const api = workspaceApi(workspaceId).plugin("bots");
  const all = holders(workspaceId);
  for (const row of rows) {
    const id = Number(row.id);
    const have = new Set(ledger.select("bots", "bots_credential_shares", { credential_id: id }).map((s) => Number(s.user_id)));
    const missing = all.filter((h) => !have.has(h.userId));
    if (!missing.length) continue;
    const secret = await credentialSecret(workspaceId, id).catch(() => null);
    if (secret === null) continue;
    for (const holder of missing)
      await api.call("credential-share", { id, user_id: holder.userId, sealed: await sealFor(workspaceId, String(row.name), secret, holder) })
        .catch((e) => console.warn("Credential not shared:", e));
  }
}
