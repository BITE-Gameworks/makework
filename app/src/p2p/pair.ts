// Adding a node to a workspace without an invite (Workspace settings > Nodes > Add a node). A node waits in a room only
// its code opens: `mwn1.<node account id>.<pair secret>`, printed by `node makework-node.mjs start` and `code`. A member
// with "Manage nodes" pastes the code; the app asks the node for its key, checks it against the code, adds the node's
// row authorized (system/nodes.ts `add`, so every member counts the node as part of the workspace from its first
// connection) and sends it the workspace: its id and room secret, sealed to the node's key and signed by the member.
// The node then hosts it like any member, without an invite. The room, signaling through the public relays and
// direct WebRTC like a workspace's, works wherever the node is, behind a router or not.
import type { JoinRoomConfig, Room } from "trystero";
import { accountId, sign, verify } from "../core/identity";
import { isSealed, pairKeys, seal, unseal, type Sealed } from "../dm/crypto";
import { relayUrls } from "./relays";

export const pairAppId = "makework-pair";
const askMs = 15_000;
const part = /^[A-Za-z0-9_-]{16,}$/;

export interface NodeCode {
  id: string;
  secret: string;
}

export function nodeCode(code: NodeCode): string {
  return `mwn1.${code.id}.${code.secret}`;
}

export function parseNodeCode(text: string): NodeCode | null {
  const [prefix, id, secret, ...rest] = text.trim().split(".");
  if (prefix !== "mwn1" || !part.test(id ?? "") || !part.test(secret ?? "") || rest.length > 0) return null;
  return { id, secret };
}

// The room a node waits in: its id and password from the code, so only someone with the code finds it.
export function pairRoom(code: NodeCode): { roomId: string; config: Omit<JoinRoomConfig, "appId"> & { appId: string } } {
  return { roomId: `pair:${code.id}`, config: { appId: pairAppId, password: code.secret, relayConfig: { urls: relayUrls } } };
}

// What a node gets to host a workspace: its room secret and how to follow the next ones.
export interface HostOffer {
  workspace: string;
  name: string;
  secret: string;
  generation: number;
  recoverySecrets: string[];
  // The account that added the node (for `list`).
  addedBy: string;
}

type Key = { x: string; y: string };
type PairMessage =
  | { kind: "ask"; nonce: string }
  | { kind: "key"; nonce: string; key: Key; signature: string }
  | { kind: "host"; nonce: string; workspace: string; from: string; fromKey: Key; sealed: Sealed; signature: string }
  | { kind: "hosting"; nonce: string; ok: boolean; error?: string };

const keyText = (nonce: string, node: string) => `makework-pair-key-v1|${nonce}|${node}`;
const hostText = (nonce: string, node: string, workspace: string, sealed: Sealed) =>
  `makework-pair-host-v1|${nonce}|${node}|${workspace}|${sealed.iv}|${sealed.data}`;

function pairAction(room: Room) {
  const action = room.makeAction<never>("pair") as unknown as {
    send(data: PairMessage, options: { target: string }): Promise<void>;
    onMessage: ((data: PairMessage, context: { peerId: string }) => void) | null;
  };
  return action;
}

export interface NodeIdentityKeys {
  id: string;
  key: Key;
  privateKey: CryptoKey;
  agreementKey?: CryptoKey;
}

// The node's side: answers who it is, and takes the workspaces members add it to. `host` saves the workspace (node.json)
// and resolves once it does; a failure goes back to the member's app as its message.
export function listenForPairing(room: Room, node: NodeIdentityKeys, host: (offer: HostOffer) => Promise<void>): () => void {
  const action = pairAction(room);
  const asked = new Map<string, string>();
  action.onMessage = (message, { peerId }) => void (async () => {
    if (!message || typeof message !== "object" || typeof message.nonce !== "string" || message.nonce.length > 64) return;
    if (message.kind === "ask") {
      asked.set(peerId, message.nonce);
      await action.send({ kind: "key", nonce: message.nonce, key: node.key, signature: await sign(node.privateKey, keyText(message.nonce, node.id)) }, { target: peerId });
      return;
    }
    if (message.kind !== "host" || asked.get(peerId) !== message.nonce) return;
    asked.delete(peerId);
    const reply = (ok: boolean, error?: string) => action.send({ kind: "hosting", nonce: message.nonce, ok, ...(error ? { error } : {}) }, { target: peerId });
    try {
      if (typeof message.from !== "string" || !message.fromKey || typeof message.fromKey.x !== "string" || typeof message.fromKey.y !== "string"
        || !isSealed(message.sealed) || message.sealed.to !== node.id || message.sealed.from !== message.from)
        return await reply(false, "That request to host a workspace is malformed.");
      if (await accountId({ crv: "P-256", ...message.fromKey }) !== message.from
        || !(await verify({ kty: "EC", crv: "P-256", ...message.fromKey }, hostText(message.nonce, node.id, message.workspace, message.sealed), message.signature)))
        return await reply(false, "That request to host a workspace isn't signed by its sender.");
      if (!node.agreementKey) return await reply(false, "This node's key can't open sealed workspaces.");
      const keys = await pairKeys(node.agreementKey, node.id, { id: message.from, publicKey: message.fromKey });
      const payload = await unseal(keys, message.sealed);
      const sent = payload ? JSON.parse(payload.text) as Partial<HostOffer> : null;
      if (!sent || typeof sent.secret !== "string" || !part.test(sent.secret) || !part.test(message.workspace))
        return await reply(false, "That workspace couldn't be opened on the node.");
      await host({
        workspace: message.workspace, name: String(sent.name ?? ""), secret: sent.secret,
        generation: Number(sent.generation ?? 0) || 0,
        recoverySecrets: Array.isArray(sent.recoverySecrets) ? sent.recoverySecrets.filter((s): s is string => typeof s === "string" && part.test(s)) : [],
        addedBy: message.from,
      });
      await reply(true);
    } catch (e) {
      await reply(false, (e as Error).message || "The node couldn't host the workspace.").catch(() => {});
    }
  })().catch((e) => console.warn("Pairing request not answered:", e));
  room.onPeerLeave = (peer) => void asked.delete(peer);
  return () => {
    action.onMessage = null;
  };
}

export interface Pairing {
  // The node's key, checked against the code, once it answered.
  onKey?: (key: Key) => void;
  // Adds the node's row (authorized) before it gets the workspace, so members let it in from the start.
  authorize(key: Key): Promise<void>;
  workspace(): Omit<HostOffer, "addedBy" | "workspace"> & { workspace: string };
}

export interface Admin {
  id: string;
  publicKey: Key;
  privateKey: CryptoKey;
  agreementKey: CryptoKey;
}

// The member's side: finds the node in its room (up to `waitMs`), checks its key, authorizes it, sends the workspace,
// and resolves once the node saved it. Throws with a message for the user.
export async function pairWithNode(room: Room, code: NodeCode, admin: Admin, pairing: Pairing, waitMs = 45_000): Promise<Key> {
  const action = pairAction(room);
  const answers = new Map<string, (message: PairMessage) => void>();
  action.onMessage = (message, { peerId }) => answers.get(`${peerId}:${message?.kind}`)?.(message);
  const answer = <K extends PairMessage["kind"]>(peer: string, kind: K, ms: number) => {
    const reply = new Promise<Extract<PairMessage, { kind: K }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        answers.delete(`${peer}:${kind}`);
        reject(new Error("The node stopped answering. Try again."));
      }, ms);
      answers.set(`${peer}:${kind}`, (message) => {
        clearTimeout(timer);
        answers.delete(`${peer}:${kind}`);
        resolve(message as Extract<PairMessage, { kind: K }>);
      });
    });
    // Awaited after the ask is sent; if that send throws first, the timeout's rejection must not go unhandled.
    reply.catch(() => {});
    return reply;
  };
  const peer = await new Promise<string>((resolve, reject) => {
    const present = Object.keys(room.getPeers())[0];
    if (present) return resolve(present);
    const timer = setTimeout(() => reject(new Error("No node answered with this code. Check that it is running and that the code is its current one (`node makework-node.mjs code`).")), waitMs);
    room.onPeerJoin = (joined) => {
      clearTimeout(timer);
      resolve(joined);
    };
  });
  const nonce = crypto.randomUUID();
  const keyReply = answer(peer, "key", askMs);
  await action.send({ kind: "ask", nonce }, { target: peer });
  const { key, signature } = await keyReply;
  if (!key || typeof key.x !== "string" || typeof key.y !== "string" || await accountId({ crv: "P-256", ...key }) !== code.id
    || !(await verify({ kty: "EC", crv: "P-256", ...key }, keyText(nonce, code.id), signature)))
    throw new Error("The node that answered isn't the one this code is for.");
  pairing.onKey?.(key);
  await pairing.authorize(key);
  const workspace = pairing.workspace();
  const keys = await pairKeys(admin.agreementKey, admin.id, { id: code.id, publicKey: key });
  const sealed = await seal(keys, { id: `pair:${nonce}`, from: admin.id, to: code.id, at: Date.now() }, {
    text: JSON.stringify({ name: workspace.name, secret: workspace.secret, generation: workspace.generation, recoverySecrets: workspace.recoverySecrets }),
    attachments: [],
  });
  const hosting = answer(peer, "hosting", askMs);
  await action.send({
    kind: "host", nonce, workspace: workspace.workspace, from: admin.id, fromKey: admin.publicKey, sealed,
    signature: await sign(admin.privateKey, hostText(nonce, code.id, workspace.workspace, sealed)),
  }, { target: peer });
  const result = await hosting;
  if (!result.ok) throw new Error(result.error || "The node couldn't host the workspace.");
  return key;
}
