// Private messages between two accounts. Each message is sealed for the pair (dm/crypto.ts) and goes straight to
// the other side while both are online (dm/link.ts); otherwise it waits on the user server until the recipient's
// app picks it up and confirms it, which deletes it there. Attached files never leave the sender's computer
// until the recipient downloads them from it, while both are online.
//
// Conversations are kept per account on this device: the list in localStorage, the messages in IndexedDB.
import { batch, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { account, accountAgreementKey, accountKey } from "../core/account";
import { refHash } from "../core/content";
import { dbGet, dbGetRange, dbDeleteRange, dbPut, prefixRange } from "../core/db";
import { base64url } from "../core/identity";
import type { Upload } from "../core/files";
import { current, messagesHome, openConversation } from "../core/navigation";
import { notify } from "../core/notifier";
import { onOnlineStatusChange, sharedPresenceStatus } from "../core/onlineStatus";
import { readJson, writeJson } from "../core/storage";
import {
  confirmMessages, findAccount, findPerson, leaveMessage, waitingMessages, type PublicAccount, type Signer, UserServerError,
} from "../core/userServer";
import { playSound } from "../theme/sounds";
import { applyRelations, mayMessage } from "./friends";
import { pairKeys, seal, unseal, isSealed, type Attachment, type Change, type PairKeys, type Payload, type Sealed } from "./crypto";
import { PairLink } from "./link";

export type { Attachment };

export interface Conversation {
  // The other account.
  id: string;
  username: string;
  displayName: string;
  color: string;
  avatar: string;
  publicKey: { x: string; y: string };
  lastAt: number;
  lastText: string;
  unread: number;
}

export type MessageStatus = "sending" | "waiting" | "delivered" | "received" | "failed";

export interface DmMessage {
  id: string;
  peer: string;
  mine: boolean;
  at: number;
  text: string;
  attachments: Attachment[];
  status: MessageStatus;
  // Why it wasn't sent, when the user server said.
  error?: string;
  editedAt?: number;
  deleted?: boolean;
  // Emoji shortcode -> the account ids that reacted with it.
  reactions?: Record<string, string[]>;
}

const checkEveryMs = 45_000;
// Rooms are kept open for conversations active this recently, so messages arrive at once.
const liveForMs = 30 * 24 * 3_600_000;
const maxLive = 20;

const [state, setState] = createStore<{ conversations: Conversation[]; messages: Record<string, DmMessage[] | undefined> }>({
  conversations: [],
  messages: {},
});
// Bumped when a room opens or closes, so `isOnline` sees new rooms.
const [linksChanged, setLinksChanged] = createSignal(0);
// Why messages can't be used right now, if they can't.
const [blocked, setBlocked] = createSignal<string | null>(null);

const keys = new Map<string, Promise<PairKeys>>();
const links = new Map<string, PairLink>();
const connecting = new Map<string, Promise<PairLink>>();
// Own attachments per conversation: what the other side may download from here.
const shared = new Map<string, Set<string>>();
let me: { id: string; signer: Signer; agreementKey: CryptoKey } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let checking = false;
let started = false;
let generation = 0;
const onFocus = () => void checkInbox();

export const conversations = () => state.conversations;
export const conversation = (id: string | undefined) => state.conversations.find((c) => c.id === id);
export const messagesWith = (peer: string) => state.messages[peer];
export const isOnline = (peer: string) => {
  linksChanged();
  return links.get(peer)?.online ?? false;
};
// Online as the other side chose to be shown (dots and labels); `isOnline` is whether messages go straight across.
export const appearsStatus = (peer: string) => {
  linksChanged();
  return links.get(peer)?.shownStatus ?? null;
};
export const messagesBlocked = blocked;

export const unreadTotal = () => state.conversations.reduce((sum, c) => sum + c.unread, 0);
export const linkOf = (peer: string) => links.get(peer);

// Starts after sign-in: opens rooms for recent conversations and checks the user server for waiting messages.
export function startMessages(): void {
  if (started) return;
  const signed = account();
  const agreementKey = accountAgreementKey();
  if (!signed) return;
  started = true;
  generation++;
  setState("conversations", readJson<Conversation[]>(listKey(signed.id), []));
  // Offline accounts have no user server, so they can't be found or messaged.
  if (signed.offline) {
    setBlocked("Create an account to use private messages.");
    return;
  }
  if (signed.offlineMode) {
    setBlocked("Offline mode is on. Choose Online, Do not disturb or Hidden to reconnect.");
    return;
  }
  if (!agreementKey) {
    setBlocked(signed.hasPassword
      ? "Sign out and sign in again with your password to use private messages on this computer."
      : signed.inDrive
        ? "Sign out and continue with Google again to use private messages on this computer."
        // Its key was never readable, so the message key can't be made from it.
        : "This account was made before Google accounts were kept in Google Drive, so it can't use private messages.");
    return;
  }
  me = { id: signed.id, signer: { id: signed.id, key: accountKey() }, agreementKey };
  const now = Date.now();
  state.conversations.filter((c) => now - c.lastAt < liveForMs).slice(0, maxLive).forEach((c) => void connect(c));
  void refreshProfiles();
  void checkInbox();
  window.addEventListener("focus", onFocus);
}

export function stopMessages(reason?: string): void {
  if (!started && !links.size) return;
  started = false;
  generation++;
  clearTimeout(timer);
  timer = undefined;
  window.removeEventListener("focus", onFocus);
  for (const link of links.values()) link.close();
  links.clear();
  connecting.clear();
  me = null;
  setBlocked(reason ?? null);
  setLinksChanged((n) => n + 1);
}

onOnlineStatusChange(() => {
  const status = sharedPresenceStatus();
  for (const link of links.values()) link.announceStatus(status);
});

// Finds someone on the user server by email or name·tag and opens the conversation with them.
export async function startConversation(query: string): Promise<void> {
  if (!me) throw new Error(blocked() ?? "Not signed in.");
  const found = await findPerson(query, me.signer);
  if (found.id === me.id) throw new Error("That's you.");
  openWith(found);
}

export function openWith(person: PublicAccount): void {
  if (!conversation(person.id)) addConversation(person);
  if (me) void connect(conversation(person.id)!);
  openConversation(person.id);
}

export async function loadMessages(peer: string): Promise<void> {
  if (!me || state.messages[peer]) return;
  const stored = await dbGetRange<DmMessage>("messages", prefixRange(`${me.id}:${peer}`));
  setState("messages", peer, stored);
  const c = conversation(peer);
  if (c) void connect(c);
}

export function markRead(peer: string): void {
  if (!conversation(peer)?.unread) return;
  updateConversation(peer, { unread: 0 });
}

// `uploads`: files already copied into the content store (messaging/MessageComposer).
export async function sendMessage(peer: string, text: string, uploads: Upload[]): Promise<void> {
  const c = conversation(peer);
  if (!me || !c) return;
  const attachments: Attachment[] = [];
  for (const { file, url, thumb, width, height } of uploads) {
    const hash = refHash(url)!;
    attachments.push({ hash, name: file.name, size: file.size, type: file.type || "application/octet-stream", thumb, width, height });
    sharedWith(peer).add(hash);
  }
  const message: DmMessage = { id: newId(), peer, mine: true, at: Date.now(), text, attachments, status: "sending" };
  await save(message);
  updateConversation(peer, { lastAt: message.at, lastText: preview(message) });
  await deliver(message);
}

export function editMessage(message: DmMessage, text: string): Promise<void> {
  return sendChange(message, { of: message.id, at: message.at, edit: text });
}

// Deletes it on both sides.
export function deleteMessage(message: DmMessage): Promise<void> {
  return sendChange(message, { of: message.id, at: message.at, delete: true });
}

export function react(message: DmMessage, code: string): Promise<void> {
  const on = !message.reactions?.[code]?.includes(me?.id ?? "");
  return sendChange(message, { of: message.id, at: message.at, react: code, on });
}

// A change goes like a message (live, else waiting on the user server) and is applied here at once.
async function sendChange(message: DmMessage, change: Change): Promise<void> {
  if (!me) return;
  const c = conversation(message.peer)!;
  const header = { id: newId(), from: me.id, to: c.id, at: Date.now() };
  const sealed = await seal(await keysFor(c), header, { text: "", attachments: [], change } satisfies Payload);
  await applyChange(message.peer, me.id, header.at, change);
  const link = await connect(c);
  if (await link.deliver(sealed)) return;
  await leaveMessage(me.signer, { id: header.id, to: c.id, body: JSON.stringify(sealed) });
}

async function applyChange(peer: string, from: string, at: number, change: Change): Promise<void> {
  const key = keyOf({ peer, at: change.at, id: change.of });
  const stored = await dbGet<DmMessage>("messages", key);
  if (!stored) return;
  const author = stored.mine ? me!.id : peer;
  let next: DmMessage;
  if ("react" in change) {
    const reactions = { ...stored.reactions };
    const by = (reactions[change.react] ?? []).filter((id) => id !== from);
    if (change.on) by.push(from);
    if (by.length) reactions[change.react] = by;
    else delete reactions[change.react];
    next = { ...stored, reactions };
  } else if (from !== author || stored.deleted) {
    return;
  } else if ("delete" in change) {
    next = { ...stored, deleted: true, text: "", attachments: [], reactions: {} };
  } else {
    // An older edit arriving late (from the user server) doesn't undo a newer one.
    if ((stored.editedAt ?? 0) > at) return;
    next = { ...stored, text: change.edit, editedAt: at };
  }
  await dbPut("messages", next, key);
  if (state.messages[peer]) setState("messages", peer, (m) => m.id === change.of, reconcile(next));
}

// Sends a message that couldn't be sent again.
export function retry(message: DmMessage): Promise<void> {
  return deliver(message);
}

// Downloads an attachment from the other side (both must be online).
export async function downloadAttachment(peer: string, attachment: Attachment): Promise<string> {
  const link = links.get(peer);
  if (!link?.online) return `${conversation(peer)?.displayName ?? "They"} must be online to send it.`;
  const result = await link.download(attachment.hash);
  if (result === "done") return "";
  if (result === "busy") return "They are sending another file. Try again in a moment.";
  if (result === "missing") return "It isn't on their computer any more.";
  return result === "cancelled" ? "" : "The download stopped. Try again.";
}

// Forgets the conversation and its messages on this computer.
export async function deleteConversation(peer: string): Promise<void> {
  if (!me) return;
  closeConversationLink(peer);
  keys.delete(peer);
  await dbDeleteRange("messages", prefixRange(`${me.id}:${peer}`));
  batch(() => {
    setState("conversations", (list) => list.filter((c) => c.id !== peer));
    setState("messages", peer, undefined);
  });
  saveList();
  if (current()?.peer === peer) openConversation("");
}

async function deliver(message: DmMessage) {
  if (!me) return;
  const c = conversation(message.peer)!;
  setStatus(message, "sending");
  const sealed = await seal(await keysFor(c), { id: message.id, from: me.id, to: c.id, at: message.at },
    { text: message.text, attachments: message.attachments } satisfies Payload);
  const link = await connect(c);
  if (await link.deliver(sealed)) return setStatus(message, "delivered");
  try {
    await leaveMessage(me.signer, { id: message.id, to: c.id, body: JSON.stringify(sealed) });
    setStatus(message, "waiting");
  } catch (e) {
    if (!(e instanceof UserServerError)) console.warn("Message not sent:", e);
    setStatus(message, "failed", e instanceof UserServerError && !e.offline ? e.message : undefined);
  }
}

type Received = "stored" | "invalid" | "later";

async function receive(sealed: Sealed): Promise<Received> {
  if (!me || (sealed.to !== me.id && sealed.from !== me.id)) return "invalid";
  const mine = sealed.from === me.id;
  const peer = mine ? sealed.to : sealed.from;
  if (!mine && !mayMessage(peer)) return "invalid";
  if (!conversation(peer)) {
    let found: PublicAccount | null;
    try {
      found = await findAccount({ id: peer });
    } catch {
      return "later";
    }
    if (!found) return "invalid";
    addConversation(found);
  }
  const c = conversation(peer)!;
  const payload = await unseal(await keysFor(c), sealed);
  if (!payload) return "invalid";
  if (payload.change) {
    await applyChange(peer, sealed.from, sealed.at, payload.change);
    return "stored";
  }
  if (await dbGet("messages", keyOf({ peer, at: sealed.at, id: sealed.id }))) return "stored";
  const message: DmMessage = {
    id: sealed.id, peer, mine, at: sealed.at, text: payload.text, attachments: payload.attachments, status: mine ? "delivered" : "received",
  };
  if (mine) message.attachments.forEach((a) => sharedWith(peer).add(a.hash));
  await save(message);
  const looking = isLooking(peer);
  updateConversation(peer, {
    lastAt: Math.max(c.lastAt, message.at), lastText: preview(message), unread: mine || looking ? c.unread : c.unread + 1,
  });
  if (!mine && !looking) {
    playSound("notification");
    notify({
      tag: `dm:${peer}`, title: c.displayName, body: preview(message), icon: c.avatar.startsWith("data:") ? c.avatar : undefined,
      onClick: () => openConversation(peer),
    });
  }
  void connect(c);
  return "stored";
}

// Picks up messages waiting on the user server, then confirms them so they are deleted there.
async function checkInbox(): Promise<void> {
  if (!me || checking) return;
  checking = true;
  clearTimeout(timer);
  try {
    const { messages: waiting, relations } = await waitingMessages(me.signer);
    applyRelations(relations);
    updateProfiles([...relations.friends, ...relations.incoming, ...relations.outgoing, ...relations.blocked]);
    const done: string[] = [];
    for (const m of waiting) {
      let sealed: unknown;
      try {
        sealed = JSON.parse(m.body);
      } catch {
        sealed = null;
      }
      const result = isSealed(sealed) && sealed.id === m.id && sealed.from === m.from ? await receive(sealed) : "invalid";
      if (result !== "later") done.push(m.id);
    }
    if (done.length) await confirmMessages(me.signer, done);
    if (waiting.length >= 200) {
      checking = false;
      return checkInbox();
    }
  } catch (e) {
    // Offline, or the account isn't on the user server yet: tried again later.
    if (!(e instanceof UserServerError)) console.warn("Checking for messages failed:", e);
  } finally {
    checking = false;
    if (me) timer = setTimeout(() => void checkInbox(), checkEveryMs);
  }
}

// The room with this conversation's other side.
function connect(c: Conversation): Promise<PairLink> {
  let link = connecting.get(c.id);
  if (!link) {
    link = open(c, generation);
    connecting.set(c.id, link);
    void link.catch(() => {
      if (connecting.get(c.id) === link) connecting.delete(c.id);
    });
  }
  return link;
}

async function open(c: Conversation, openedIn: number): Promise<PairLink> {
  const signed = me;
  if (!signed) throw new Error("Private messages are unavailable.");
  const pair = await keysFor(c);
  const stored = await dbGetRange<DmMessage>("messages", prefixRange(`${signed.id}:${c.id}`));
  if (me !== signed || generation !== openedIn) throw new Error("Private messages were disconnected.");
  stored.filter((m) => m.mine).forEach((m) => m.attachments.forEach((a) => sharedWith(c.id).add(a.hash)));
  const link = new PairLink(pair, signed.id, c.id, (hash) => sharedWith(c.id).has(hash), async (sealed) => (await receive(sealed)) === "stored", sharedPresenceStatus);
  links.set(c.id, link);
  setLinksChanged((n) => n + 1);
  return link;
}

function keysFor(c: Conversation): Promise<PairKeys> {
  let pair = keys.get(c.id);
  if (!pair) {
    pair = pairKeys(me!.agreementKey, me!.id, c);
    keys.set(c.id, pair);
  }
  return pair;
}

// Names, usernames and pictures change; ids and keys don't.
async function refreshProfiles() {
  for (const c of state.conversations) {
    try {
      const found = await findAccount({ id: c.id });
      if (found) updateProfiles([found]);
    } catch {
      return;
    }
  }
}

function updateProfiles(people: PublicAccount[]) {
  for (const person of people) {
    if (conversation(person.id)) setState("conversations", (c) => c.id === person.id, profileOf(person));
  }
  saveList();
}

// Blocking closes the room, so nothing more arrives from them live; it opens again with the conversation.
export function closeConversationLink(peer: string): void {
  links.get(peer)?.close();
  links.delete(peer);
  connecting.delete(peer);
  setLinksChanged((n) => n + 1);
}

function addConversation(found: PublicAccount) {
  setState("conversations", (list) => [
    { id: found.id, publicKey: found.publicKey, lastAt: Date.now(), lastText: "", unread: 0, ...profileOf(found) },
    ...list,
  ]);
  saveList();
}

function profileOf(found: PublicAccount) {
  return {
    username: found.username, displayName: found.profile.displayName || found.username, color: found.profile.color,
    avatar: found.profile.avatar || `gen:${found.username}`,
  };
}

function updateConversation(peer: string, changes: Partial<Conversation>) {
  setState("conversations", (c) => c.id === peer, changes);
  setState("conversations", (list) => [...list].sort((a, b) => b.lastAt - a.lastAt));
  saveList();
}

async function save(message: DmMessage) {
  await dbPut("messages", { ...message, attachments: [...message.attachments] }, keyOf(message));
  if (!state.messages[message.peer]) return;
  setState("messages", message.peer, produce((list) => {
    if (!list || list.some((m) => m.id === message.id)) return;
    list.push(message);
    list.sort((a, b) => a.at - b.at);
  }));
}

function setStatus(message: DmMessage, status: MessageStatus, error?: string) {
  const stored = { ...message, attachments: [...message.attachments], status, error };
  void dbPut("messages", stored, keyOf(message));
  setState("messages", message.peer, (m) => m.id === message.id, { status, error });
}

function sharedWith(peer: string): Set<string> {
  let set = shared.get(peer);
  if (!set) shared.set(peer, (set = new Set()));
  return set;
}

function isLooking(peer: string): boolean {
  const here = current();
  return document.hasFocus() && here?.workspaceId === messagesHome && here.peer === peer;
}

function preview(message: DmMessage): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 120);
  const n = message.attachments.length;
  return n === 1 ? message.attachments[0].name : `${n} files`;
}

function saveList() {
  if (me ?? account()) writeJson(listKey((me ?? { id: account()!.id }).id), state.conversations);
}

const listKey = (accountId: string) => `mw.conversations.${accountId}`;
const keyOf = (m: { peer: string; at: number; id: string }) => `${me!.id}:${m.peer}:${String(m.at).padStart(15, "0")}:${m.id}`;
const newId = () => base64url(crypto.getRandomValues(new Uint8Array(16)));
