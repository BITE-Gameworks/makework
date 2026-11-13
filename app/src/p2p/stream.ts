// File content streamed between members, one chunk at a time.
//
// The receiver asks a member for content from an offset ("want"), optionally up to an end (a node taking one piece of a
// big file, `fetchRange`). The holder answers with the size and sends
// one chunk ("part"); the receiver writes it to its temporary part and confirms it ("ack"), and only then does
// the holder read and send the next one. Neither side ever holds more than one chunk. A member sends to one
// receiver at a time (a node to `senders`) and answers "busy" to the others, and only for content it has: content it
// hasn't (and can't fetch, `onMissing`) is "missing" even then. One transfer per receiver: a new want from a receiver
// ends the one before (its stop got lost). So a receiver fetches from one holder one thing at a time (`turn`), the next
// waiting for the last: a node loading a member's new images (its keep pass, and on demand for members asking it) asked
// the member for two at once, the second ended the first without a word, and that download stalled until `idleMs`.
// Taking turns, a long download gives way to one waiting behind it after `sliceMs`, once the chunk on its
// way landed: it stops, keeps what arrived and goes on from there at the back of the line, so a new image doesn't wait
// for a 2 GB file to finish. A
// stalled transfer stops after `idleMs` with nothing moving; the receiver keeps what arrived and resumes from there on
// the next try. Moving counts the frames of a chunk on both sides (Trystero reports each 16 KB frame of a big message):
// timed per whole chunk, a link slower than one chunk per `idleMs` (4 MiB in 30 s, about 1.1 Mbit/s) failed every try
// on the same chunk and never finished a big file. The frames move the bars too (`sendingProgress`,
// `progress`): moved only at each chunk's ack, a file under one chunk went from 0 to done and a slow link showed
// nothing for seconds. Either side can stop a transfer; the holder says whether the receiver throws away what
// arrived (`stopSending`).
import { createStore } from "solid-js/store";
import type { Room } from "trystero";
import { chunkSize as defaultChunkSize, type ContentWriter } from "../core/stream";

export interface StreamStore {
  readRange(hash: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer> | null>;
  size(hash: string): Promise<number | null>;
  openWriter(hash: string): Promise<ContentWriter>;
}

export type DownloadResult = "done" | "busy" | "missing" | "failed" | "cancelled";
// "yielded": a download that gave way to the next in line (`sliceMs`), which goes on later.
type Ended = DownloadResult | "yielded";

// `end`: stop there (exclusive) instead of at the end of the file.
type Position = { hash: string; offset: number; end?: number };

// How long a request for content waits for its answer (a node fetching it on demand answers within 8 s, host.ts).
const wantTimeoutMs = 10_000;
// How long a download from one holder runs before it lets a download waiting for that holder go first.
const defaultSliceMs = 5_000;
// `end`: echoed by holders that stop at it (apps before ranges send on to the end of the file).
type WantReply = { size: number; end?: number } | "busy" | null;

// `waiting`: not sent yet (fetching it first, `onMissing`), so not counted among the receivers served.
// `abort`: takes back the chunk on its way when the send stops (Trystero takes one big message per peer at a time, so
// on a slow link the receiver's next transfer from here waited behind it past its deadline).
type Sending = {
  peer: string; hash: string; stopped: boolean; waiting: boolean; acked: ((offset: number | null) => void) | null;
  abort: AbortController;
};
// What a peer that is not a member yet may fetch (`may`), and whether a peer is one (`isMember`).
export type Invitees = { may: (hash: string) => boolean; isMember: (peer: string) => boolean };
// `answered`: the holder answered with the size, so the content is on its way. `moving`: a frame of the chunk at
// `offset` arrived, and `fraction` of that chunk is here now.
// `giveWay`: stop as "yielded" once the chunk on its way landed (`sliceMs`, see the top of this file).
type Receiving = {
  peer: string; answered: boolean; part(bytes: Uint8Array<ArrayBuffer>, offset: number): void;
  moving(offset: number, fraction: number): void;
  giveWay(): void; stop(result: Ended): void;
};
type Queued = { peer: string; cancelled: boolean };

// Whether a frame moves a bar from `shown` to `value`: only forward, and once per whole percent (a fast link reports
// thousands of frames a second, and the label shows whole percents).
const frameMoves = (shown: number | undefined, value: number) =>
  shown === undefined || (value > shown && Math.floor(value * 100) !== Math.floor(shown * 100));
// The download running from a holder, which gives way (`yield`) when another waits for that holder past its slice.
type Slice = { since: number; timer?: ReturnType<typeof setTimeout>; yield(): void };

export class ContentStreams {
  // One per receiving peer.
  private readonly sending = new Map<string, Sending>();
  private readonly receiving = new Map<string, Receiving>();
  // The last transfer from each holder, which the next one from it waits for, and transfers waiting so, by hash.
  private readonly turns = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, Queued>();
  private readonly slices = new Map<string, Slice>();
  private closed = false;
  private readonly progressStore = createStore<Record<string, number | undefined>>({});
  private readonly sendingStore = createStore<Record<string, number | undefined>>({});
  private readonly want;
  private readonly part;
  private readonly ack;
  private readonly stop;
  private readonly idleMs: number;
  private readonly chunkSize: number;
  private readonly sliceMs: number;
  private readonly senders: number;
  // Receivers served at once with `senders` above 1 (nodes): starts at up to 4 and adapts up to `senders` like the
  // catch-up queue (syncQueue.ts): about one more per round while every chunk is acked within a third of `idleMs`,
  // halved (at most once per half `idleMs`) when one takes more than half of it, before transfers would stall.
  private allowed: number;
  private lastDecrease = -Infinity;

  private readonly onSent?: (hash: string, peer: string) => void;
  private readonly onSending?: (hash: string, peer: string, fraction: number) => void;
  private readonly onMissing?: (hash: string) => Promise<boolean | "busy">;
  private readonly refuse?: (hash: string, peer: string) => boolean;
  private readonly invitees?: Invitees;

  // `refuse`: content not given to `peer` though it is here, answered as missing (an upload its member holds back from
  // the nodes, p2p/content.ts).
  // `onSent`: `peer` received all of some content from here. `onSending`: how far a send to `peer` got, 0 to 1, each
  // time its bar moves (`sendingProgress` forgets it when the send ends). `senders`: members served at once. `onMissing`: asked
  // for content not here, fetch it first (a node loading a file another node keeps); resolves whether it is here now,
  // or "busy" while it is still on its way (the asker comes back soon instead of counting it as nowhere).
  // `invitees`: content a peer admitted only by its invite (a joiner, not a member yet) may fetch, a workspace's
  // snapshot state: it needs that before it can become a member. Members-only, a joiner never got it, fell back to the
  // whole history, and got nothing where nobody online still had that (mesh-test s12). With it the
  // transfer is open to such peers (room access "invite") and everything else is refused to them here.
  constructor(
    room: Pick<Room, "makeAction">, private readonly store: StreamStore,
    options: {
      idleMs?: number; chunkSize?: number; sliceMs?: number; senders?: number; onSent?: (hash: string, peer: string) => void;
      onSending?: (hash: string, peer: string, fraction: number) => void;
      onMissing?: (hash: string) => Promise<boolean | "busy">;
      refuse?: (hash: string, peer: string) => boolean;
      invitees?: Invitees;
    } = {},
  ) {
    this.refuse = options.refuse;
    this.onSent = options.onSent;
    this.onSending = options.onSending;
    this.onMissing = options.onMissing;
    this.invitees = options.invitees;
    this.senders = options.senders ?? 1;
    this.allowed = Math.min(4, this.senders);
    this.idleMs = options.idleMs ?? 30_000;
    this.chunkSize = options.chunkSize ?? defaultChunkSize;
    this.sliceMs = options.sliceMs ?? defaultSliceMs;
    const access = options.invitees ? { mwAccess: "invite" } : {};
    this.want = room.makeAction<Position, WantReply>("content-want", {
      kind: "request", ...access,
      onRequest: (want, { peerId }) => this.onWant(want, peerId),
    });
    this.part = room.makeAction<Uint8Array<ArrayBuffer>>("content-part", {
      ...access,
      onMessage: (data, { peerId, metadata }) => {
        const at = metadata as Position | undefined;
        if (!at) return;
        const receiving = this.receiving.get(at.hash);
        if (receiving?.peer === peerId) receiving.part(toBytes(data), at.offset);
      },
      onReceiveProgress: (progress, { peerId, metadata }) => {
        const at = metadata as Position | undefined;
        if (!at) return;
        const receiving = this.receiving.get(at.hash);
        if (receiving?.peer === peerId) receiving.moving(at.offset, progress);
      },
    });
    this.ack = room.makeAction<Position>("content-ack", {
      ...access,
      onMessage: ({ hash, offset }, { peerId }) => {
        const s = this.sending.get(peerId);
        if (s?.hash === hash) s.acked?.(offset);
      },
    });
    this.stop = room.makeAction<{ hash: string; discard?: boolean }>("content-stop", {
      ...access,
      onMessage: ({ hash, discard }, { peerId }) => {
        const s = this.sending.get(peerId);
        if (s?.hash === hash) this.endSending(s);
        const receiving = this.receiving.get(hash);
        if (receiving?.peer === peerId) receiving.stop(discard ? "cancelled" : "failed");
      },
    });
  }

  // How much of a running download has arrived, 0 to 1.
  progress(hash: string): number | undefined {
    return this.progressStore[0][hash];
  }

  // How much of the content has gone to a member while it is being sent to them, 0 to 1.
  sendingProgress(hash: string): number | undefined {
    return this.sendingStore[0][hash];
  }

  // The peer this content is being sent to now. Not reactive on its own: read it after `sendingProgress`, which
  // changes whenever a send starts or ends.
  sendingTo(hash: string): string | undefined {
    for (const s of this.sending.values()) if (s.hash === hash && !s.waiting) return s.peer;
    return undefined;
  }

  // Whether content is on its way here: its holder answered with its size, or it waits its turn behind content from a
  // holder that did (that holder is sending here). A node tells members asking for it "busy" meanwhile (host.ts).
  coming(hash: string): boolean {
    if (this.receiving.get(hash)?.answered) return true;
    const queued = this.queued.get(hash);
    return !!queued && [...this.receiving.values()].some((r) => r.peer === queued.peer && r.answered);
  }

  // Whether something is coming from `peer` or waits its turn for it: a request to it now waits behind that, and makes
  // a whole download give way (`sliceMs`). A node asks such members last for a file it doesn't know the holder of.
  receivingFrom(peer: string): boolean {
    for (const r of this.receiving.values()) if (r.peer === peer) return true;
    for (const q of this.queued.values()) if (q.peer === peer && !q.cancelled) return true;
    return false;
  }

  // Streams the content from `peer` into the store, resuming a part kept from an earlier try.
  async download(hash: string, peer: string): Promise<DownloadResult> {
    let result: Ended;
    let gaveWay = false;
    do {
      result = await this.inTurn(hash, peer, () => this.receive(hash, peer), true);
      gaveWay ||= result === "yielded";
    } while (result === "yielded" && !this.closed);
    // This download gave way and then didn't go on (cancelled or closed while it waited): its progress still showed. Not
    // another one's: a "busy" for a hash whose download gave way and waits to go on keeps its progress.
    if (gaveWay && !this.receiving.has(hash) && !this.queued.has(hash)) this.setProgress(hash, undefined);
    return result === "yielded" ? "failed" : result;
  }

  // Bytes [start, end) of content from `peer`, held in memory and never stored: one piece of a big file for a node
  // (node/host.ts), so `end - start` should be at most a chunk or two.
  async fetchRange(hash: string, start: number, end: number, peer: string): Promise<Uint8Array<ArrayBuffer> | DownloadResult> {
    const result = await this.inTurn(hash, peer, () => this.receiveRange(hash, start, end, peer));
    return result === "yielded" ? "failed" : result;
  }

  // Runs a transfer from `peer` once the one before from it is over (see the top of this file). Its entry in `queued`
  // stays until it is over: between the two, a second transfer of the hash could start beside it. A whole download
  // (`slices`) gives way to a transfer waiting behind it after `sliceMs`.
  private async inTurn<T>(hash: string, peer: string, run: () => Promise<T | Ended>, slices = false): Promise<T | Ended> {
    if (this.receiving.has(hash) || this.queued.has(hash)) return "busy";
    const queued: Queued = { peer, cancelled: false };
    this.queued.set(hash, queued);
    const before = this.turns.get(peer);
    let release!: () => void;
    const over = new Promise<void>((resolve) => (release = resolve));
    const turn = (before ?? Promise.resolve()).then(() => over);
    this.turns.set(peer, turn);
    if (before) this.yieldSoon(peer);
    let slice: Slice | null = null;
    try {
      await before;
      if (queued.cancelled) return "cancelled";
      if (this.closed) return "failed";
      if (slices) {
        slice = { since: performance.now(), yield: () => this.receiving.get(hash)?.giveWay() };
        this.slices.set(peer, slice);
        if (this.waitingFor(peer, queued)) this.yieldSoon(peer);
      }
      return await run();
    } finally {
      if (slice) {
        clearTimeout(slice.timer);
        if (this.slices.get(peer) === slice) this.slices.delete(peer);
      }
      if (this.queued.get(hash) === queued) this.queued.delete(hash);
      release();
      if (this.turns.get(peer) === turn) this.turns.delete(peer);
    }
  }

  // Whether a transfer other than `except` waits for `peer`.
  private waitingFor(peer: string, except: Queued): boolean {
    for (const q of this.queued.values()) if (q !== except && q.peer === peer && !q.cancelled) return true;
    return false;
  }

  // The download running from `peer` gives way once its slice is over, if a transfer still waits for that holder then.
  private yieldSoon(peer: string) {
    const slice = this.slices.get(peer);
    if (!slice || slice.timer) return;
    slice.timer = setTimeout(() => {
      slice.timer = undefined;
      // The running one's own entry is in `queued` too: another waits when there are two.
      if (this.slices.get(peer) === slice && [...this.queued.values()].filter((q) => q.peer === peer && !q.cancelled).length > 1)
        slice.yield();
    }, Math.max(0, slice.since + this.sliceMs - performance.now()));
  }

  private async receive(hash: string, peer: string): Promise<Ended> {
    const writer = await this.store.openWriter(hash);
    let size = Infinity;
    let expected = writer.size;
    let writing: Promise<unknown> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done!: (result: Ended) => void;
    const ended = new Promise<Ended>((resolve) => (done = resolve));
    const end = (result: Ended) => {
      clearTimeout(timer);
      if (this.receiving.get(hash) === receiving) this.receiving.delete(hash);
      done(result);
    };
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => end("failed"), this.idleMs);
    };
    const completeIfWhole = () => {
      if (writer.size >= size) end("done");
    };
    // Giving way waits for the chunk on its way: given way mid-chunk, a link slower than `sliceMs` per chunk dropped it
    // every time, and two downloads from one holder gave way to each other without either moving.
    let givingWay = false;
    const receiving: Receiving = {
      peer,
      answered: false,
      part: (bytes, offset) => {
        if (offset !== expected) return;
        expected += bytes.byteLength;
        idle();
        writing = writing.then(async () => {
          await writer.append(bytes);
          if (size !== Infinity) this.setProgress(hash, writer.size / size);
          // Not acked, so the holder sends no more: it stops on our stop.
          if (givingWay && writer.size < size) return end("yielded");
          void this.ack.send({ hash, offset: writer.size }, { target: peer }).catch(() => {});
          completeIfWhole();
        }).catch(() => end("failed"));
      },
      // A frame of the chunk on its way moves the bar; the exact value follows once the chunk is written. The chunk's
      // length is taken as this side's chunk size.
      moving: (offset, fraction) => {
        idle();
        if (offset !== expected || !Number.isFinite(size) || size <= 0) return;
        const value = Math.min(1, (offset + fraction * Math.min(this.chunkSize, size - offset)) / size);
        if (frameMoves(this.progressStore[0][hash], value)) this.setProgress(hash, value);
      },
      giveWay: () => void (givingWay = true),
      stop: end,
    };
    this.receiving.set(hash, receiving);
    idle();
    // A short wait for the answer: a peer that went away (WebRTC notices only after about 30 s) is skipped soon.
    this.want.request({ hash, offset: writer.size }, { target: peer, timeoutMs: Math.min(this.idleMs, wantTimeoutMs) }).then((reply) => {
      if (reply === "busy") end("busy");
      else if (!reply) end("missing");
      else {
        receiving.answered = true;
        size = reply.size;
        this.setProgress(hash, size ? writer.size / size : 1);
        writing = writing.then(completeIfWhole);
      }
    }, () => end("failed"));

    let result = await ended;
    await writing.catch(() => {});
    if (result !== "done" && result !== "busy" && result !== "missing")
      void this.stop.send({ hash }, { target: peer }).catch(() => {});
    if (result === "done") {
      try {
        await writer.finish(hash);
      } catch (e) {
        console.warn(`Content ${hash.slice(0, 8)} from a member was damaged:`, e);
        result = "failed";
      }
    } else await writer.close(result === "cancelled").catch(() => {});
    // One that gave way goes on soon: its progress stays.
    if (result !== "yielded") this.setProgress(hash, undefined);
    return result;
  }

  private async receiveRange(hash: string, start: number, end: number, peer: string): Promise<Uint8Array<ArrayBuffer> | Ended> {
    const length = end - start;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) return "failed";
    const out = new Uint8Array(new ArrayBuffer(length));
    let got = 0;
    let stopsAtEnd = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done!: (result: Ended) => void;
    const ended = new Promise<Ended>((resolve) => (done = resolve));
    const finish = (result: Ended) => {
      clearTimeout(timer);
      if (this.receiving.get(hash) === receiving) this.receiving.delete(hash);
      done(result);
    };
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish("failed"), this.idleMs);
    };
    const receiving: Receiving = {
      peer,
      answered: false,
      part: (bytes, offset) => {
        if (offset !== start + got) return;
        const take = Math.min(bytes.byteLength, length - got);
        out.set(bytes.subarray(0, take), got);
        got += take;
        idle();
        // The holder waits for this before it sends on (or, at the end, before it is done).
        void this.ack.send({ hash, offset: offset + bytes.byteLength }, { target: peer }).catch(() => {});
        if (got >= length) finish("done");
      },
      moving: idle,
      // Ranges are never sliced (`fetchRange`).
      giveWay: () => finish("yielded"),
      stop: finish,
    };
    this.receiving.set(hash, receiving);
    idle();
    this.want.request({ hash, offset: start, end }, { target: peer, timeoutMs: Math.min(this.idleMs, wantTimeoutMs) }).then((reply) => {
      if (reply === "busy") finish("busy");
      else if (!reply || reply.size < end) finish("missing");
      else {
        receiving.answered = true;
        stopsAtEnd = reply.end === end;
      }
    }, () => finish("failed"));
    const result = await ended;
    // Holders from before ranges would send on to the end of the file.
    if ((result === "done" && !stopsAtEnd) || (result !== "done" && result !== "busy" && result !== "missing"))
      void this.stop.send({ hash }, { target: peer }).catch(() => {});
    return result === "done" ? out : result;
  }

  // Stops a running download (or one waiting its turn) and throws away what arrived.
  cancel(hash: string): void {
    this.receiving.get(hash)?.stop("cancelled");
    const queued = this.queued.get(hash);
    if (queued) queued.cancelled = true;
  }

  // Stops sending the content and tells the receivers to throw away what they got, or with `discard` false to keep it
  // (a later download goes on from there).
  stopSending(hash: string, discard = true): void {
    for (const s of [...this.sending.values()]) {
      if (s.hash !== hash) continue;
      void this.stop.send(discard ? { hash, discard } : { hash }, { target: s.peer }).catch(() => {});
      this.endSending(s);
    }
  }

  close(): void {
    this.closed = true;
    for (const receiving of [...this.receiving.values()]) receiving.stop("failed");
    for (const s of [...this.sending.values()]) this.endSending(s);
  }

  private async onWant({ hash, offset, end }: Position, peer: string): Promise<WantReply> {
    if (this.invitees && !this.invitees.isMember(peer) && !this.invitees.may(hash)) return null;
    if (this.refuse?.(hash, peer)) return null;
    // A receiver fetches one thing from here at a time (`turn`): a new want from it ends the one before.
    const previous = this.sending.get(peer);
    if (previous) this.endSending(previous);
    const sending: Sending = { peer, hash, stopped: false, waiting: true, acked: null, abort: new AbortController() };
    this.sending.set(peer, sending);
    const drop = () => {
      if (this.sending.get(peer) === sending) this.sending.delete(peer);
    };
    let size = await this.store.size(hash);
    if (size === null && this.onMissing && !sending.stopped) {
      const found = await this.onMissing(hash).catch(() => false);
      if (found === "busy") {
        drop();
        return sending.stopped ? null : "busy";
      }
      if (found) size = await this.store.size(hash);
    }
    const until = end ?? size;
    if (size === null || until === null || !Number.isSafeInteger(offset) || offset < 0 || offset > size || sending.stopped
      || !Number.isSafeInteger(until) || until < offset || until > size) {
      drop();
      return null;
    }
    // Only now, for content that is here: "busy" tells the asker to come back for it, and a want waiting for the content
    // (a node fetching it first, up to 8 s) took none of the places of the receivers served.
    if (this.served(sending) >= Math.floor(this.allowed)) {
      drop();
      return "busy";
    }
    sending.waiting = false;
    void this.send(sending, offset, until, size, end !== undefined);
    return end === undefined ? { size } : { size, end: until };
  }

  // Sends from `offset` up to `until`, the next chunk only once the last one is acked. A range (`ranged`) is never
  // a whole send, even when it reaches the end.
  private async send(sending: Sending, offset: number, until: number, size: number, ranged = false) {
    const { peer, hash } = sending;
    this.sent(sending, size ? offset / size : 1);
    try {
      while (offset < until && !sending.stopped) {
        const at = offset;
        const bytes = await this.store.readRange(hash, offset, Math.min(until, offset + this.chunkSize));
        if (!bytes?.byteLength) {
          void this.stop.send({ hash }, { target: peer }).catch(() => {});
          break;
        }
        const ack = this.nextAck(sending);
        const started = performance.now();
        await this.part.send(bytes, {
          target: peer, metadata: { hash, offset }, signal: sending.abort.signal,
          onProgress: (fraction) => {
            ack.moving();
            this.sent(sending, (at + fraction * bytes.byteLength) / size, true);
          },
        });
        const ok = (await ack.offset) === offset + bytes.byteLength;
        if (!sending.stopped) this.adapt(performance.now() - started, ok);
        if (!ok) break;
        offset += bytes.byteLength;
        this.sent(sending, offset / size);
      }
      // After the loop, so content with nothing to send counts too: an empty file, or a receiver whose part already
      // had all of it (its ack of the last chunk got lost).
      if (offset === size && !ranged && !sending.stopped) this.onSent?.(hash, peer);
    } catch (e) {
      if (!sending.stopped) console.warn(`Sending content ${hash.slice(0, 8)} stopped:`, e);
    } finally {
      this.endSending(sending);
    }
  }

  // How far a running send got, for its bar. `frame`: from a frame of a chunk going out, which moves it only forward
  // and once per whole percent (`frameMoves`); the value at a chunk's ack is exact.
  private sent(sending: Sending, value: number, frame = false) {
    if (sending.stopped || (frame && !frameMoves(this.sendingStore[0][sending.hash], value))) return;
    this.sendingStore[1](sending.hash, value);
    this.onSending?.(sending.hash, sending.peer, value);
  }

  // How many receivers to serve at once, from how long the last chunk took to be acked.
  private adapt(ms: number, ok: boolean) {
    if (this.senders <= 1) return;
    if (ok && ms <= this.idleMs / 3) this.allowed = Math.min(this.senders, this.allowed + 1 / this.allowed);
    else if ((!ok || ms > this.idleMs / 2) && performance.now() - this.lastDecrease > this.idleMs / 2) {
      this.lastDecrease = performance.now();
      this.allowed = Math.max(1, this.allowed / 2);
    }
  }

  // Receivers served at once now (nodes: adaptive).
  get sendersNow(): number {
    return Math.floor(this.allowed);
  }

  // The offset the receiver confirms next (`offset`), or null when it stopped or nothing moved for `idleMs`: `moving`
  // (each frame of the chunk going out) starts the wait over, so it counts from the chunk's last frame, not its first.
  private nextAck(sending: Sending): { offset: Promise<number | null>; moving: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let settle!: (offset: number | null) => void;
    const offset = new Promise<number | null>((resolve) => {
      settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sending.acked === settle) sending.acked = null;
        resolve(value);
      };
    });
    sending.acked = settle;
    // A frame reported after the ack (or the stop) can't start a wait of the next chunk's: this one is settled.
    const moving = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => settle(null), this.idleMs);
    };
    moving();
    return { offset, moving };
  }

  // Receivers being sent to now, besides `except`.
  private served(except: Sending): number {
    let count = 0;
    for (const s of this.sending.values()) if (s !== except && !s.waiting) count++;
    return count;
  }

  private endSending(sending: Sending) {
    sending.stopped = true;
    sending.acked?.(null);
    sending.abort.abort();
    if (this.sending.get(sending.peer) === sending) {
      this.sending.delete(sending.peer);
      this.sendingStore[1](sending.hash, undefined);
    }
  }

  private setProgress(hash: string, value: number | undefined) {
    this.progressStore[1](hash, value);
  }
}

function toBytes(data: Uint8Array<ArrayBuffer> | ArrayBuffer): Uint8Array<ArrayBuffer> {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}
