// The chat keys this device holds for one workspace, and the work that keeps them moving (ADR 0021): it opens the keys
// given to this account, gives the ones it holds to members who may read them and lack them, and makes a new epoch
// when someone lost access or a guest arrived. Lent to the chat data plugin to seal and open text (system/backend.ts
// Services); `KeyedTransport` makes sure a channel's key is here before a chat write reaches it.
import type { PluginClient } from "../api/client";
import type { Transport } from "../api/transport";
import type { ApiValue, ServerEvent } from "../api/types";
import { base64url, fromBase64url } from "../core/identity";
import { isSealed, pairKeys, seal, unseal, type PairKeys } from "../dm/crypto";
import type { ChatSealer } from "../system/backend";
import { InvalidRequest } from "../system/errors";
import { epochOf, isSealedText, keyCheck, newChannelKey, openText, sealText } from "./chatCrypto";
import { epochsOf, keyPlan, mayRead, mayReadChannel, readers, type Epoch } from "./chatKeys";
import type { Ledger } from "./ledger";
import { userNumberOf } from "./log";
import { publicKeysOf, type PublicKeyOf } from "./memberKeys";
import { roleTablesFrom, type Row } from "./permissions";

// Members holding a key wait a moment before giving it, so one usually does it and the others see it done.
const settleMs = 1500;
const spreadMs = 3000;
const grantBatch = 200;
const keyedActions = new Set(["post-message", "post-bot-message", "post-poll", "edit-poll", "edit-message", "attach"]);

type Account = { id: string; publicKey: { x: string; y: string } };

export class ChatKeyring implements ChatSealer {
  private readonly keys = new Map<string, Uint8Array>();
  private readonly tried = new Set<number>();
  private readonly pairs = new Map<string, Promise<PairKeys>>();
  private readonly epochs = new Map<number, Epoch[]>();
  private chat?: PluginClient;
  private changed?: () => void;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | null = null;
  private readonly ensuring = new Map<number, Promise<void>>();
  private stopped = false;

  constructor(private readonly ledger: Ledger, private readonly account: Account, private readonly agreement: CryptoKey | null) {}

  // Once the workspace's API exists: where keys are written, and whom to tell when keys arrive.
  start(chat: PluginClient, changed: () => void): void {
    this.chat = chat;
    this.changed = changed;
    this.unsubscribe = this.ledger.subscribe((event: ServerEvent) => {
      if (event.plugin === "chat" && event.table.startsWith("chat_key")) this.epochs.clear();
      if (["chat", "members", "roles", "channels"].includes(event.plugin) && (event.plugin !== "chat" || event.table.startsWith("chat_key"))) this.soon();
    });
    this.soon(0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.unsubscribe?.();
  }

  private readonly rows = (plugin: string, table: string, where: Record<string, ApiValue> = {}) => this.ledger.select(plugin, table, where) as Row[];
  private readonly roles = () => roleTablesFrom(this.rows);
  private epochList(channelId: number): Epoch[] {
    let list = this.epochs.get(channelId);
    if (!list) this.epochs.set(channelId, (list = epochsOf(this.rows, channelId)));
    return list;
  }
  private readonly held = (e: Epoch) => this.keys.get(`${e.channelId}:${e.epoch}:${e.check}`);

  seal(channelId: number, authorId: number, text: string): string {
    const current = this.epochList(channelId).at(-1);
    const key = current && this.held(current);
    if (!current || !key) throw new InvalidRequest("This channel's key isn't on this device yet. Try again in a moment.");
    return sealText(key, current.epoch, channelId, authorId, text);
  }

  open(channelId: number, authorId: number, text: string): string | null {
    if (!isSealedText(text)) return text;
    const epoch = this.epochList(channelId).find((e) => e.epoch === epochOf(text));
    const key = epoch && this.held(epoch);
    return key ? openText(key, channelId, authorId, text) : null;
  }

  guestSince(userId: number): number | null {
    return this.roles().guests?.get(userId) ?? null;
  }

  // Before posting: this device holds the channel's current key, made new when the plan says or there is none.
  // One at a time per channel, so two quick posts don't both make the next epoch.
  ensure(channelId: number): Promise<void> {
    return this.oneAtATime(channelId, () => this.ready(channelId));
  }

  // Work on a channel's keys after the work already queued for it (posts' ensure, the background pass), never beside it.
  private oneAtATime(channelId: number, work: () => Promise<void>): Promise<void> {
    const before = this.ensuring.get(channelId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(work);
    this.ensuring.set(channelId, next);
    return next;
  }

  private async ready(channelId: number): Promise<void> {
    await this.openGrants();
    const roles = this.roles();
    if (!mayReadChannel(this.rows, roles, this.ledger.owner, this.ledger.me, channelId)) return;
    const plan = keyPlan(this.rows, roles, this.ledger.owner, channelId, () => false);
    const current = this.epochList(channelId).at(-1);
    if (plan.rotate || !current || !this.held(current)) await this.rotate(channelId);
  }

  // The keys sealed to this account that weren't opened yet. A key that doesn't match its epoch's check is skipped.
  // A grant whose sender or epoch isn't known here yet (history still arriving) is tried again on a later round;
  // only one that opened, or can't ever open, is done with.
  private async openGrants(): Promise<void> {
    const waiting = this.rows("chat", "chat_key_grants", { user_id: this.ledger.me }).filter((g) => !this.tried.has(g.id));
    if (waiting.length === 0 || !this.agreement) return;
    const senders = publicKeysOf(this.ledger);
    let opened = false;
    for (const grant of waiting) {
      try {
        const sealed: unknown = JSON.parse(String(grant.sealed));
        if (!isSealed(sealed) || sealed.to !== this.account.id) {
          this.tried.add(grant.id);
          continue;
        }
        const sender = senders.get(userNumberOf(sealed.from));
        const epoch = this.epochList(Number(grant.channel_id)).find((e) => e.epoch === Number(grant.epoch));
        if (!sender || sender.id !== sealed.from || !epoch) continue;
        this.tried.add(grant.id);
        const payload = await unseal(await this.pairWith(sender), sealed);
        if (!payload?.text) continue;
        const key = fromBase64url(payload.text);
        if (keyCheck(key) !== epoch.check) continue;
        this.keys.set(`${epoch.channelId}:${epoch.epoch}:${epoch.check}`, key);
        opened = true;
      } catch {
        // A grant that can't be read is left; another member may give the key again.
        this.tried.add(grant.id);
      }
    }
    if (opened) this.changed?.();
  }

  private pairWith(peer: PublicKeyOf): Promise<PairKeys> {
    let pair = this.pairs.get(peer.id);
    if (!pair) {
      // A derivation that failed isn't kept, so the next seal or open for this peer tries again.
      pair = pairKeys(this.agreement!, this.account.id, peer).catch((e) => {
        this.pairs.delete(peer.id);
        throw e;
      });
      this.pairs.set(peer.id, pair);
    }
    return pair;
  }

  private async sealFor(grants: { userId: number; epoch: Epoch; key: Uint8Array }[]) {
    const keys = publicKeysOf(this.ledger);
    const sealed: { channel_id: number; epoch: number; user_id: number; sealed: string }[] = [];
    for (const g of grants) {
      const to = g.userId === this.ledger.me ? { id: this.account.id, publicKey: this.account.publicKey } : keys.get(g.userId);
      if (!to) continue;
      const envelope = await seal(await this.pairWith(to), {
        id: `chat:${g.epoch.channelId}:${g.epoch.epoch}:${g.userId}`, from: this.account.id, to: to.id, at: Date.now(),
      }, { text: base64url(g.key), attachments: [] });
      sealed.push({ channel_id: g.epoch.channelId, epoch: g.epoch.epoch, user_id: g.userId, sealed: JSON.stringify(envelope) });
    }
    return sealed;
  }

  // A new epoch for everyone who may read it, after the guests who joined so far, so they can read it too.
  private async rotate(channelId: number): Promise<void> {
    if (!this.agreement || !this.chat) throw new Error("This account can't encrypt chat on this device.");
    const roles = this.roles();
    const owner = this.ledger.owner;
    const key = newChannelKey();
    const createdAt = Math.max(Date.now(), ...[...(roles.guests?.values() ?? [])].map((t) => t + 1));
    const epoch: Epoch = {
      channelId, epoch: (this.epochList(channelId).at(-1)?.epoch ?? 0) + 1, check: keyCheck(key), createdBy: this.ledger.me, createdAt,
    };
    const people = readers(this.rows, owner).filter((u) => mayRead(this.rows, roles, owner, u, epoch));
    if (!people.includes(this.ledger.me)) people.push(this.ledger.me);
    const grants = await this.sealFor(people.map((userId) => ({ userId, epoch, key })));
    this.keys.set(`${channelId}:${epoch.epoch}:${epoch.check}`, key);
    await this.chat.call("add-chat-key", {
      channel_id: channelId, epoch: epoch.epoch, check: epoch.check, created_at: new Date(createdAt).toISOString(),
      grants: JSON.stringify(grants.map(({ user_id, sealed }) => ({ user_id, sealed }))),
    });
    this.epochs.delete(channelId);
  }

  private soon(delay = settleMs + Math.random() * spreadMs): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running ??= this.pass().catch((e) => console.warn("Chat keys:", e)).finally(() => (this.running = null));
    }, delay);
  }

  // One round of keeping keys: open, rotate where someone lost access or a guest can't read the current key, give.
  private async pass(): Promise<void> {
    await this.openGrants();
    if (!this.agreement || !this.chat || this.stopped) return;
    const roles = this.roles();
    const owner = this.ledger.owner;
    const me = this.ledger.me;
    const channels = [...new Set(this.rows("chat", "chat_keys").map((k) => Number(k.channel_id)))]
      .filter((id) => mayReadChannel(this.rows, roles, owner, me, id));
    const give: { userId: number; epoch: Epoch; key: Uint8Array }[] = [];
    for (const channelId of channels) {
      const plan = keyPlan(this.rows, roles, owner, channelId, (n) => !!this.held(this.epochList(channelId).find((e) => e.epoch === n)!));
      if (plan.rotate === "lost-access" || plan.rotate === "guest") {
        // In line with posts' ensure, and only if the plan still says so then: a post may have rotated meanwhile.
        await this.oneAtATime(channelId, async () => {
          const still = keyPlan(this.rows, this.roles(), owner, channelId, (n) => !!this.held(this.epochList(channelId).find((e) => e.epoch === n)!));
          if (still.rotate === "lost-access" || still.rotate === "guest") await this.rotate(channelId);
        }).catch((e) => console.warn(`Chat keys of channel ${channelId}:`, e));
        continue;
      }
      for (const g of plan.grants) {
        const epoch = this.epochList(channelId).find((e) => e.epoch === g.epoch)!;
        give.push({ userId: g.userId, epoch, key: this.held(epoch)! });
      }
    }
    for (let i = 0; i < give.length && !this.stopped; i += grantBatch) {
      const sealed = await this.sealFor(give.slice(i, i + grantBatch));
      if (sealed.length) await this.chat.call("grant-chat-keys", { grants: JSON.stringify(sealed) });
    }
  }

  // The channel a chat write is about, from its request (`KeyedTransport`).
  channelOfRequest(raw: { plugin?: unknown; action?: unknown; args?: Record<string, unknown> }): number | null {
    if (raw.plugin !== "chat" || !keyedActions.has(String(raw.action))) return null;
    if (raw.args?.channel_id != null) return Number(raw.args.channel_id);
    const message = this.rows("chat", "chat_messages", { id: Number(raw.args?.message_id) })[0];
    return message ? Number(message.channel_id) : null;
  }
}

// Each open workspace's keyring, for code that reads chat from the signed history itself (workspace history).
const keyrings = new Map<string, ChatKeyring>();
export const setKeyring = (workspaceId: string, keyring: ChatKeyring | null) =>
  void (keyring ? keyrings.set(workspaceId, keyring) : keyrings.delete(workspaceId));

// Chat text opened with this device's keys; plain text as it is, null when sealed with a key that isn't here.
export function openChatText(workspaceId: string, channelId: number, authorId: number, text: string): string | null {
  return isSealedText(text) ? keyrings.get(workspaceId)?.open(channelId, authorId, text) ?? null : text;
}

// A workspace's transport with this device's chat keys made ready before a chat write: the data plugin seals
// synchronously and can't wait for a key.
export class KeyedTransport implements Transport {
  constructor(private readonly inner: Transport, private readonly keyring: ChatKeyring) {}

  async send(request: string): Promise<string> {
    let channel: number | null = null;
    try {
      channel = this.keyring.channelOfRequest(JSON.parse(request));
    } catch {
      // Not ours to judge; the plugin answers.
    }
    if (channel !== null) await this.keyring.ensure(channel).catch((e) => console.warn("Chat key not ready:", e));
    return this.inner.send(request);
  }

  subscribe(handler: (event: ServerEvent) => void): () => void {
    return this.inner.subscribe(handler);
  }

  close(): void {
    this.inner.close();
  }
}
