// The private room of two accounts, while both are online: messages go straight to the other side, and attached
// files stream from the sender's computer (p2p/stream.ts). Only the two accounts can find and enter the room (its
// id and password come from their shared secret, dm/crypto.ts), which may also hold their other devices.
import { createSignal, type Accessor } from "solid-js";
import { joinRoom, type Room } from "trystero";
import { contentSize, openWriter, readRange } from "../core/stream";
import { currentTurn, loadTurn } from "../p2p/ice";
import { relayUrls } from "../p2p/relays";
import { ContentStreams, type DownloadResult } from "../p2p/stream";
import { isSealed, type PairKeys, type Sealed } from "./crypto";
import type { SharedPresenceStatus } from "../core/presence";

const appId = "makework-dm";
const ackWaitMs = 4000;

export class PairLink {
  readonly peers: Accessor<string[]>;
  private readonly setPeers: (peers: string[]) => void;
  private readonly statuses: Accessor<Record<string, SharedPresenceStatus>>;
  private readonly setStatuses: (statuses: Record<string, SharedPresenceStatus>) => void;
  private readonly sendStatus: (status: { hidden: boolean; status: SharedPresenceStatus | null }, peer?: string) => Promise<unknown>;
  private readonly room: Room;
  readonly streams: ContentStreams;
  private readonly sendSealed: (sealed: Sealed, peer?: string) => Promise<unknown>;
  private readonly sendAck: (ack: { id: string; by: string }, peer: string) => Promise<unknown>;
  private readonly waiting = new Map<string, () => void>();

  // `shared`: content this side may send in this room (its own attachments in this conversation).
  constructor(
    keys: PairKeys, private readonly ownId: string, private readonly peerId: string,
    private readonly shared: (hash: string) => boolean,
    receive: (sealed: Sealed) => Promise<boolean>,
    private readonly getStatus: () => SharedPresenceStatus | null,
  ) {
    [this.peers, this.setPeers] = createSignal<string[]>([]);
    [this.statuses, this.setStatuses] = createSignal<Record<string, SharedPresenceStatus>>({});
    let failed = false;
    // Same relay list as every server room (p2p/sync.ts): members of a private room meet on any shared relay, so a
    // relay that blocks the DM app id can't split two devices of the same account.
    const config = { appId, password: keys.roomPassword, relayConfig: { urls: relayUrls }, get turnConfig() { return failed ? currentTurn() : []; } };
    this.room = joinRoom(config, keys.roomId, {
      onJoinError: () => {
        failed = true;
        void loadTurn();
      },
    });
    const status = this.room.makeAction<{ hidden: boolean; status?: SharedPresenceStatus | null }>("dm-status");
    this.sendStatus = (s, peer) => status.send(s, peer ? { target: peer } : undefined);
    status.onMessage = (message, { peerId }) => {
      const next = { ...this.statuses() };
      if (message.status === "online" || message.status === "away" || message.status === "dnd")
        next[peerId] = message.status;
      else if (message.status === null || message.hidden) delete next[peerId];
      else if (message.hidden === false) next[peerId] = "online";
      this.setStatuses(next);
    };
    this.room.onPeerJoin = (peer) => {
      this.setPeers([...this.peers().filter((p) => p !== peer), peer]);
      const current = this.getStatus();
      void this.sendStatus({ hidden: !current, status: current }, peer).catch(() => {});
    };
    this.room.onPeerLeave = (peer) => {
      this.setPeers(this.peers().filter((p) => p !== peer));
      const next = { ...this.statuses() };
      delete next[peer];
      this.setStatuses(next);
    };

    const message = this.room.makeAction<string>("dm");
    const ack = this.room.makeAction<{ id: string; by: string }>("dm-ack");
    this.sendSealed = (sealed, peer) => message.send(JSON.stringify(sealed), peer ? { target: peer } : undefined);
    this.sendAck = (a, peer) => ack.send(a, { target: peer });
    message.onMessage = (data, { peerId }) => {
      let sealed: unknown;
      try {
        sealed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isSealed(sealed)) return;
      void receive(sealed).then((stored) => {
        if (stored && sealed.to === this.ownId) void this.sendAck({ id: sealed.id, by: this.ownId }, peerId).catch(() => {});
      });
    };
    ack.onMessage = ({ id, by }) => {
      if (by === this.peerId) this.waiting.get(id)?.();
    };

    this.streams = new ContentStreams(this.room, {
      readRange: (hash, start, end) => (this.shared(hash) ? readRange(hash, start, end) : Promise.resolve(null)),
      size: (hash) => (this.shared(hash) ? contentSize(hash) : Promise.resolve(null)),
      openWriter: (hash) => openWriter(hash),
    });
  }

  get online(): boolean {
    return this.peers().length > 0;
  }

  // Online as the other side wants to be shown.
  get shownStatus(): SharedPresenceStatus | null {
    const statuses = new Set(this.peers().map((peer) => this.statuses()[peer]));
    return statuses.has("dnd") ? "dnd" : statuses.has("online") ? "online" : statuses.has("away") ? "away" : null;
  }

  get shownOnline(): boolean {
    return this.shownStatus !== null;
  }

  announceStatus(status = this.getStatus()): void {
    void this.sendStatus({ hidden: status === null, status }).catch(() => {});
  }

  // Sends to everyone in the room (the other account and this account's other devices); true once the other
  // account confirmed it.
  deliver(sealed: Sealed): Promise<boolean> {
    if (!this.online) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (delivered: boolean) => {
        clearTimeout(timer);
        this.waiting.delete(sealed.id);
        resolve(delivered);
      };
      const timer = setTimeout(() => done(false), ackWaitMs);
      this.waiting.set(sealed.id, () => done(true));
      void this.sendSealed(sealed).catch(() => done(false));
    });
  }

  // Downloads an attachment from whoever in the room has it.
  async download(hash: string): Promise<DownloadResult> {
    let result: DownloadResult = "missing";
    for (const peer of this.peers()) {
      result = await this.streams.download(hash, peer);
      if (result === "done" || result === "cancelled") return result;
    }
    return result;
  }

  close(): void {
    this.streams.close();
    void this.room.leave();
  }
}
