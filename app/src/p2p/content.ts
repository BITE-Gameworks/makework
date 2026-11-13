// Which file content this device keeps for a serverless workspace, and moving it between members.
//
// Kept (fetched automatically, kept up to date): everything the user added themselves, files and attachments
// they synced one by one, and up to the auto-download size: files in synced channels and folders, attachments
// in synced channels and chat images. Everything else is a ghost (name, size, preview), a pointer to content
// that one online member streams when it is opened, which syncs it. Downloads run one at a time, streamed
// chunk by chunk to disk (p2p/stream.ts). On desktop, the workspace is also written as a readable folder,
// ~/MakeWork/<server>/channels/... or <server folder>/channels/... (p2p/diskView.ts).
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SyncRoom } from "./roomGroup";
import { deleteContent, hasContent, markFinished, refHash, registerContentSync, type ContentSync, type SyncMark } from "../core/content";
import { desktop } from "../core/desktop";
import { readJson, writeJson } from "../core/storage";
import { sniffExtension } from "../core/fileNames";
import { findChannel, workspaces } from "../core/workspaces";
import { linkContext, parseLink } from "../core/links";
import { contentSize, openWriter, readRange } from "../core/stream";
import { ghostThresholdBytes } from "../core/ui";
import type { MockBackend } from "../system/backend";
import { parseDeclared, type DeclaredManifest } from "../system/declared";
import { showNotice } from "../core/notices";
import { diskLayoutFor, exportProviderFor } from "../plugins/registry";
import type { JsonRow } from "../system/data";
import { diskChannels, diskEntries, type DiskSource } from "./diskView";
import type { DiskEntry } from "../plugins/types";
import { FolderSync } from "./folderSync";
import { ContentStreams } from "./stream";
import type { WorkspaceSync } from "./sync";
import { Deliveries } from "./deliveries";
import { nodeLinkOf, nodePeers } from "./nodes";

const retryMs = 30_000;
// How often new uploads still on their way are asked about at the nodes (p2p/nodes.ts `node-holds`).
const confirmEveryMs = 15_000;
// And how soon after the user sends one on (`uploadToNode`), so a node that has it already says so at once.
const confirmSoonMs = 200;
// After a "busy" answer: the holder is serving others, or a node is still loading the file (a new upload goes
// uploader -> node -> members when members reach each other only through nodes), so it comes soon.
const busyRetryMs = 5_000;
// File extensions sniffed from content's first bytes, by hash (content never changes).
const sniffed = new Map<string, string>();
const links = new Set<ContentLink>();

export class ContentLink implements ContentSync {
  private marks: SyncMark[];
  private readonly retained = new Map<string, number>();
  // File entry -> its content, as of the last `wanted` pass.
  private fileRefs = new Map<number, string>();
  private readonly fetching = new Set<string>();
  private readonly fetches = new Map<string, Promise<boolean>>();
  // Downloads the user cancelled, kept a pointer until the item is opened or synced again (by mark key).
  private readonly skipped = new Map<string, string>();
  // Content with a part on this device from an unfinished download, to delete once nothing wants it.
  private readonly partials = new Set<string>();
  // Content asked for through ensureContent, by how many requests are running.
  private readonly asked = new Map<string, number>();
  private readonly unavailable = flags();
  private readonly transferring = flags();
  private readonly declaredPlugins = new Set<string>();
  private readonly marksChanged = createSignal(0);
  private readonly cleanups: (() => void)[] = [];
  private readonly streams: ContentStreams | null = null;
  // New uploads from this device that no node has all of yet: quitting asks first (p2p/deliveries.ts). `waiting`: the
  // same for the labels ("Uploading to the node"), reactive; this window's view (another window's show there).
  // `reached`: how far a node got taking each of them in, 0 to 1, kept while the pull pauses (the node gives way to
  // another download, or drops out), so the bar holds its place.
  private readonly deliveries: Deliveries;
  private readonly waiting = createStore<Record<string, true | undefined>>({});
  private readonly reached = createStore<Record<string, number | undefined>>({});
  // Uploads the user cancelled on their way to a node: held back, so this device gives them to no node until the user
  // sends them on (`uploadToNode`). A node asks again for what it lacks about once a minute, so stopping the send alone
  // lasted that long. A list in localStorage for every window of the app (a popped-out tab is asked by the node too),
  // read again whenever a node asks; `held` is this window's view of it, reactive.
  private readonly heldKey: string;
  private readonly held = createStore<Record<string, true | undefined>>({});
  private readonly room: SyncRoom | null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  // Content a holder answered "busy" for, until when it waits to be asked for again.
  private readonly busyUntil = new Map<string, number>();
  private busyTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshAgain = false;
  private closed = false;
  private readonly folder: FolderSync | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly backend: MockBackend,
    sync: WorkspaceSync,
    private readonly userId: number,
    private readonly storageKey: string,
    // Which members to ask first for content (the closest node first, p2p/nodes.ts).
    // Who to ask first for a file: the nodes that keep it (NodeLink.orderFor).
    private readonly order: (peers: string[], hash: string) => string[] = (peers) => peers,
  ) {
    this.marks = readJson<SyncMark[]>(storageKey, []);
    const deliveriesKey = `${storageKey}.deliveries`;
    this.deliveries = new Deliveries({ read: () => readJson(deliveriesKey, {}), write: (entries) => writeJson(deliveriesKey, entries) });
    for (const hash of this.deliveries.pending(() => true)) this.waiting[1](hash, true);
    this.heldKey = `${storageKey}.held`;
    this.readHeld();
    // Uploads on their way a node may have already (the same bytes from another member, or taken in while this device
    // didn't see it): asked about while any are on their way and a node is reached.
    const confirming = setInterval(() => void this.confirmDeliveries().catch(() => {}), confirmEveryMs);
    this.cleanups.push(() => clearInterval(confirming));
    this.refreshDeclaredPlugins();
    this.room = sync.room;
    if (this.room) {
      const room = this.room;
      this.streams = new ContentStreams(room, { readRange, size: contentSize, openWriter: (hash) => openWriter(hash, workspaceId) }, {
        onSent: (hash, peer) => {
          const nodes = nodeLinkOf(workspaceId);
          if (!nodes?.isNode(peer)) return markFinished(hash, "sent");
          nodes.noteHeld(peer, hash);
          this.delivered(hash);
        },
        // The furthest any node got: two nodes may take turns, and either one finishing counts.
        onSending: (hash, peer, fraction) => {
          if (!this.waiting[0][hash] || !nodeLinkOf(workspaceId)?.isNode(peer)) return;
          this.reached[1](hash, Math.max(this.reached[0][hash] ?? 0, fraction));
        },
        // Held back from the nodes; members who ask still get it.
        refuse: (hash, peer) => !!nodeLinkOf(workspaceId)?.isNode(peer) && this.readHeld().has(hash),
        // A joiner (not a member yet) may fetch the workspace's snapshot state from here, nothing else.
        invitees: {
          may: (hash) => this.rows("members", "members_snapshots").some((row) => refHash(String(row.content ?? "")) === hash),
          isMember: (peer) => room.isMember?.(peer) ?? true,
        },
      });
      this.cleanups.push(sync.onPeers(() => this.schedule(true), () => {}));
    }
    this.cleanups.push(backend.subscribe((event) => {
      if (event.plugin === "channels" && event.table === "channels_plugins") this.refreshDeclaredPlugins();
      if (event.plugin === "files" && event.table === "files_entries" && event.change === "delete") this.letGo(event.ids);
      if (["files", "chat", "design", "docs", "code", "channels", "members", "emoji"].includes(event.plugin) ||
        this.declaredPlugins.has(event.plugin)) this.schedule();
    }));
    this.cleanups.push(registerContentSync(workspaceId, this));
    // Renamed, moved, hidden or shown channels change the folder.
    this.cleanups.push(createRoot((dispose) => {
      createEffect(on(() => {
        const server = workspaces.byId[workspaceId];
        return server?.status === "ready" && JSON.stringify([server.categories, server.channels]);
      }, () => this.schedule(), { defer: true }));
      return dispose;
    }));
    if (desktop?.mirror) {
      const folder = new FolderSync(workspaceId, () => this.diskSource(), (fetch) => this.schedule(fetch));
      this.folder = folder;
      this.cleanups.push(() => folder.close());
    }
    links.add(this);
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.deliveries.flush();
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.confirmTimer);
    clearTimeout(this.busyTimer);
    this.streams?.close();
    this.cleanups.forEach((cleanup) => cleanup());
    links.delete(this);
  }

  isMarked(mark: SyncMark): boolean {
    this.marksChanged[0]();
    return this.marks.some((m) => m.kind === mark.kind && m.id === mark.id);
  }

  setMark(mark: SyncMark, on: boolean): void {
    if (on) for (const [hash, key] of this.skipped) if (key === markKey(mark)) this.skipped.delete(hash);
    if (this.isMarked(mark) === on) {
      // Kept by a folder or channel sync: a download cancelled earlier starts again.
      if (on) this.schedule(true);
      return;
    }
    const before = on ? null : this.wanted();
    this.marks = on ? [...this.marks, mark] : this.marks.filter((m) => !(m.kind === mark.kind && m.id === mark.id));
    writeJson(this.storageKey, this.marks);
    this.marksChanged[1]((n) => n + 1);
    if (before) void this.release(before).catch((e) => console.warn("Content not released:", e));
    this.schedule(true);
  }

  // Forgets a channel on this device: its content stops being wanted (so nothing is fetched and, unless your
  // own uploads, freed) and the readable folder gives up its channel. A mark ON never frees anything else; the
  // forgotten kind does, once, here.
  forgetChannel(channelId: number): void {
    if (this.closed) return;
    const before = this.wanted();
    this.marks = this.marks.filter((m) => !(m.kind === "channel" && m.id === channelId) && !(m.kind === "forgotten" && m.id === channelId));
    this.marks = [...this.marks, { kind: "forgotten", id: channelId }];
    writeJson(this.storageKey, this.marks);
    this.marksChanged[1]((n) => n + 1);
    void this.release(before).catch((e) => console.warn("Content not released:", e));
    this.schedule(true);
  }

  restoreChannel(channelId: number): void {
    if (this.closed) return;
    this.marks = this.marks.filter((m) => !(m.kind === "forgotten" && m.id === channelId));
    writeJson(this.storageKey, this.marks);
    this.marksChanged[1]((n) => n + 1);
    this.schedule(true);
  }

  status(hash: string): "fetching" | "unavailable" | undefined {
    if (this.transferring.has(hash)) return "fetching";
    if (this.unavailable.has(hash)) return "unavailable";
    return undefined;
  }

  // Asked for by hash (a snapshot's state, which no row points at until it is applied): never pruned while asked for.
  // A joiner's snapshot download was stopped as soon as its first commits came in, as content nothing wants
  // (prunePartials), and it waited for a retry (mesh-test s12).
  ensureContent(hash: string): Promise<boolean> {
    this.unavailable.set(hash, false);
    this.asked.set(hash, (this.asked.get(hash) ?? 0) + 1);
    return this.fetch(hash).finally(() => {
      const count = (this.asked.get(hash) ?? 1) - 1;
      if (count > 0) this.asked.set(hash, count);
      else this.asked.delete(hash);
    });
  }

  progress(hash: string): number | undefined {
    return this.streams?.progress(hash);
  }

  sending(hash: string): number | undefined {
    return this.streams?.sendingProgress(hash);
  }

  async cancelDownload(hash: string, mark: SyncMark): Promise<void> {
    this.skipped.set(hash, markKey(mark));
    this.streams?.cancel(hash);
    this.setMark(mark, false);
    if (!wantedEverywhere().has(hash)) await deleteContent(hash);
  }

  // The user cancelled content going out from here. Its item and this device's copy stay (removing is the user's own
  // act, Delete). A send to a member just ends; the member's app asks again when they open it. An upload to a node, or
  // one waiting for a node, is held back: the node keeps what it got, so sending it on later goes on from there.
  cancelSend(hash: string): void {
    const peer = this.streams?.sendingTo(hash);
    if (peer !== undefined && !nodeLinkOf(this.workspaceId)?.isNode(peer)) return this.streams?.stopSending(hash);
    this.changeHeld((held) => held.add(hash));
    this.streams?.stopSending(hash, false);
  }

  // Sends one of this device's files on to the nodes: a held back upload, the same bytes uploaded again (this device may
  // have them only because their upload was cancelled), or any own file the user asks for. Counted as on its way, and
  // the nodes are asked about it at once: one that has it already says so ("On the node"). Else a node takes it at its
  // next pass (within about a minute: it asks again for what it lacks, and nothing tells it sooner).
  uploadToNode(hash: string, size: number): void {
    // Only when held: changing the list reads every file row (wanted).
    if (this.held[0][hash]) this.changeHeld((held) => held.delete(hash));
    if (this.follow(hash, size)) this.confirmSoon();
  }

  // Whether "Upload to the node" makes sense for this file: the workspace has nodes that keep it whole, it isn't on
  // its way or held back, and no node reached is known to have it. Nothing is asked: what is unknown counts as missing,
  // and `uploadToNode` asks.
  canUploadToNode(hash: string, size: number): boolean {
    const nodes = nodeLinkOf(this.workspaceId);
    if (size <= 0 || !nodes?.hasNodes() || !nodes.keptWhole(size)) return false;
    return !this.held[0][hash] && !this.waiting[0][hash] && !nodes.holdsWhole(hash);
  }

  // Asks the nodes about everything on its way shortly, in one request: a folder sent on at once asks once.
  private confirmSoon() {
    this.confirmTimer ??= setTimeout(() => {
      this.confirmTimer = undefined;
      void this.confirmDeliveries().catch(() => {});
    }, confirmSoonMs);
  }

  // The shared list, taken into this window's view.
  private readHeld(): Set<string> {
    const stored = readJson<unknown>(this.heldKey, []);
    return this.showHeld(Array.isArray(stored) ? stored.filter((hash): hash is string => typeof hash === "string") : []);
  }

  private showHeld(hashes: string[]): Set<string> {
    this.held[1](reconcile(Object.fromEntries(hashes.map((hash) => [hash, true as const]))));
    return new Set(hashes);
  }

  // Changes the shared list, without what nothing here wants any more (its item was deleted).
  private changeHeld(change: (held: Set<string>) => void) {
    const held = this.readHeld();
    change(held);
    const wanted = this.wanted();
    const kept = [...held].filter((hash) => wanted.has(hash));
    writeJson(this.heldKey, kept);
    this.showHeld(kept);
  }

  // A new upload from this device, counted until a node received all of it. Only where the workspace has nodes; not an
  // empty file (nothing to lose, and the nodes surely have those bytes already), nor one the nodes keep in pieces (they
  // take those as ranges, which never count as a whole send).
  expectDelivery(hash: string, size: number): void {
    this.follow(hash, size);
  }

  // Counts the upload as on its way to the nodes, where that applies (see `expectDelivery`); says whether it does.
  private follow(hash: string, size: number): boolean {
    const nodes = nodeLinkOf(this.workspaceId);
    if (size <= 0 || !nodes?.hasNodes() || !nodes.keptWhole(size)) return false;
    this.deliveries.expect(hash);
    this.waiting[1](hash, true);
    return true;
  }

  // Where a new upload from here stands while no node has all of it (reactive): "uploading" while a node is reached
  // (it pulls the upload from here, so quitting would cut it off: the test `undelivered` uses), "waiting" while none is.
  // "held": the user cancelled it on its way, and no node gets it from here until they send it on.
  delivery(hash: string): "uploading" | "waiting" | "held" | undefined {
    if (this.held[0][hash]) return "held";
    if (!this.waiting[0][hash]) return undefined;
    return nodePeers(this.workspaceId).length > 0 ? "uploading" : "waiting";
  }

  // How much of a new upload from here a node took in so far, 0 to 1 (reactive): kept while the pull pauses, undefined
  // before a node started and for anything else.
  deliveryProgress(hash: string): number | undefined {
    return this.reached[0][hash];
  }

  // Whether the content is going to a node now, not to a member. Read after `sending` (see `ContentStreams.sendingTo`).
  sendingToNode(hash: string): boolean {
    const peer = this.streams?.sendingTo(hash);
    return peer !== undefined && !!nodeLinkOf(this.workspaceId)?.isNode(peer);
  }

  // A node has all of this new upload now: it no longer counts, and says so for a moment ("On the node").
  private delivered(hash: string) {
    this.deliveries.delivered(hash);
    this.waiting[1](hash, undefined);
    this.reached[1](hash, undefined);
    if (this.held[0][hash]) this.changeHeld((held) => held.delete(hash));
    markFinished(hash, "delivered");
  }

  // Held back ones are asked about too: one a node got another way (from another member) is no longer held.
  private async confirmDeliveries() {
    if (this.closed) return;
    const held = [...this.readHeld()];
    const nodes = nodeLinkOf(this.workspaceId);
    if (!nodes?.onlineNodes().size || (!held.length && !this.deliveries.hasAny())) return;
    for (const hash of await nodes.askHoldings([...this.deliveries.pending(() => true), ...held])) this.delivered(hash);
  }

  // New uploads from this device that no node has all of yet, while a node is reached: quitting now stops them on their
  // way (the node pulls them from here). With no node reached, quitting changes nothing, so none count. Only content an
  // item still points at (an upload whose item was removed doesn't count), and none another member uploaded too: the
  // nodes have it or get it from them, and never ask this device for it. Nor ones held back: the user stopped those.
  undelivered(): number {
    if (!this.deliveries.hasAny() || !nodeLinkOf(this.workspaceId)?.onlineNodes().size) return 0;
    const wanted = this.wanted();
    const held = this.readHeld();
    const pending = new Set(this.deliveries.pending((hash) => wanted.has(hash) && !held.has(hash)));
    if (!pending.size) return 0;
    const others = this.uploadedByOthers(pending);
    return [...pending].filter((hash) => !others.has(hash)).length;
  }

  // Of `hashes`, those an item by another member points at too (files, attachments, design layers, code files).
  private uploadedByOthers(hashes: Set<string>): Set<string> {
    const found = new Set<string>();
    const check = (url: unknown, author: unknown) => {
      const hash = refHash(typeof url === "string" ? url : null);
      if (hash && hashes.has(hash) && Number(author) !== this.userId) found.add(hash);
    };
    for (const entry of this.rows("files", "files_entries")) if (entry.deleted !== true) check(entry.url, entry.author_id);
    const authors = new Map(this.rows("chat", "chat_messages").map((m) => [m.id, m.author_id]));
    for (const a of this.rows("chat", "chat_attachments")) check(a.url, authors.get(Number(a.message_id)));
    for (const node of this.rows("design", "design_nodes")) if (node.deleted !== true) check(node.url, node.author_id);
    for (const file of this.rows("code", "code_files")) if (file.deleted !== true) check(file.hash, file.author_id);
    return found;
  }

  retain(hashes: Iterable<string>): () => void {
    const kept = [...new Set(hashes)];
    kept.forEach((hash) => this.retained.set(hash, (this.retained.get(hash) ?? 0) + 1));
    this.schedule();
    return () => {
      kept.forEach((hash) => {
        const count = this.retained.get(hash) ?? 0;
        if (count <= 1) this.retained.delete(hash);
        else this.retained.set(hash, count - 1);
      });
      this.schedule();
    };
  }

  openFolder(channelId?: number): void {
    const source = channelId === undefined ? null : this.diskSource(new Set());
    const inner = source ? diskChannels(source).find((v) => v.channel.id === channelId)?.base : undefined;
    void desktop?.mirror?.open(this.workspaceId, this.workspaceName(), inner);
  }

  // Everything this device should keep for the workspace.
  wanted(): Set<string> {
    const marks = new Set(this.marks.map(markKey));
    const marked = (kind: SyncMark["kind"], id: number) => marks.has(`${kind}:${id}`);
    const forgotten = new Set<number>();
    for (const m of this.marks) if (m.kind === "forgotten") forgotten.add(m.id);
    const hashes = new Set(this.retained.keys());
    const add = (url: unknown) => {
      const hash = refHash(typeof url === "string" ? url : null);
      if (hash) hashes.add(hash);
    };
    for (const snapshot of this.rows("members", "members_snapshots")) {
      add(snapshot.content);
      if (marked("archive", Number(snapshot.id))) add(snapshot.archive_content);
    }

    // Custom emoji are small and used anywhere: every image is kept, including removed ones (old messages and
    // reactions still show them). This is why `deleted` doesn't filter here.
    for (const row of this.rows("emoji", "emoji_emojis")) add(row.url);

    // Larger content stays a pointer unless synced by itself.
    const fits = (size: unknown) => Number(size) <= ghostThresholdBytes();

    const entries = this.rows("files", "files_entries");
    const byId = new Map(entries.map((e) => [e.id, e]));
    // Every file's content, hidden ones too, for `letGo`.
    const fileRefs = new Map<number, string>();
    for (const entry of entries) {
      const hash = refHash(typeof entry.url === "string" ? entry.url : null);
      if (hash) fileRefs.set(entry.id, hash);
    }
    this.fileRefs = fileRefs;
    // Remembered per entry: big folder trees would otherwise be walked again for every file in them.
    const synced = new Map<number, boolean>();
    const inSynced = (entry: JsonRow): boolean => {
      let result = synced.get(entry.id);
      if (result === undefined) {
        const parent = entry.parent_id === null ? undefined : byId.get(Number(entry.parent_id));
        result = parent ? marked("folder", parent.id) || inSynced(parent) : marked("channel", Number(entry.channel_id));
        synced.set(entry.id, result);
      }
      return result;
    };
    const living = new Map<number, boolean>();
    const alive = (entry: JsonRow): boolean => {
      let result = living.get(entry.id);
      if (result === undefined) {
        const parent = entry.parent_id === null ? undefined : byId.get(Number(entry.parent_id));
        result = entry.deleted !== true && (entry.parent_id === null || (!!parent && alive(parent)));
        living.set(entry.id, result);
      }
      return result;
    };
    // Own uploads stay on this device; otherwise a forgotten channel keeps nothing, and an un-forgotten one keeps
    // what `when` says (a mark, or a small enough file in a synced place).
    const kept = (channelId: number, authorId: unknown, when: () => boolean): boolean =>
      Number(authorId) === this.userId || (!forgotten.has(channelId) && when());
    for (const entry of entries) {
      if (entry.kind !== "file" || !alive(entry)) continue;
      const channelId = Number(entry.channel_id);
      if (kept(channelId, entry.author_id, () => marked("file", entry.id) || (fits(entry.size) && inSynced(entry)))) add(entry.url);
    }

    const messages = new Map(this.rows("chat", "chat_messages").map((m) => [m.id, m]));
    for (const a of this.rows("chat", "chat_attachments")) {
      const message = messages.get(Number(a.message_id));
      if (!message) continue;
      const image = String(a.mime ?? "").startsWith("image/");
      const channelId = Number(message.channel_id);
      if (kept(channelId, message.author_id, () => marked("attachment", a.id) ||
        (fits(a.size) && (image || marked("channel", channelId))))) add(a.url);
    }

    for (const node of this.rows("design", "design_nodes")) {
      if (!node.url || node.deleted === true) continue;
      const channelId = Number(node.channel_id);
      if (kept(channelId, node.author_id, () => marked("channel", channelId))) add(node.url);
    }
    // Code files are small text: kept unless the channel was forgotten (their plain copy feeds the readable folder).
    for (const file of this.rows("code", "code_files")) {
      if (file.kind !== "file" || file.deleted === true || !file.hash) continue;
      const channelId = Number(file.channel_id);
      if (kept(channelId, file.author_id, () => fits(file.size))) add(file.hash);
    }
    // Images in docs pages are mwc: refs inside the markdown.
    for (const page of this.rows("docs", "docs_pages")) {
      const channelId = Number(page.channel_id);
      if (page.deleted === true || forgotten.has(channelId) || !marked("channel", channelId)) continue;
      for (const match of String(page.body ?? "").matchAll(/mwc:[a-f0-9]{64}/g)) add(match[0]);
    }
    // A big file's piece list goes with the file (its uploader's, or wherever the whole file is kept), so nodes can
    // check the pieces they take from here.
    for (const list of this.rows("nodes", "nodes_pieces")) {
      const file = refHash(typeof list.content === "string" ? list.content : null);
      if (Number(list.author_id) === this.userId || (file && hashes.has(file))) add(list.manifest);
    }
    for (const hash of this.skipped.keys()) hashes.delete(hash);
    // A workspace's installed plugins' packages and file references: everyone can install the plugin and open
    // its declared content without putting file bytes into the signed data.
    for (const plugin of this.rows("channels", "channels_plugins")) {
      add(plugin.package);
      let manifest: DeclaredManifest;
      try {
        manifest = parseDeclared(String(plugin.manifest ?? ""));
      } catch {
        continue;
      }
      for (const table of manifest.tables) {
        for (const row of this.rows(manifest.name, table.name)) {
          const channelId = Number(row.channel_id);
          const inScope = !table.channel || marked("channel", channelId) ||
            (table.authored !== undefined && Number(row[table.authored]) === this.userId);
          if (!inScope || row.deleted === true) continue;
          for (const value of Object.values(row)) {
            if (typeof value !== "string") continue;
            for (const match of value.matchAll(/mwc:[a-f0-9]{64}/g)) add(match[0]);
          }
        }
      }
    }
    return hashes;
  }

  private refreshDeclaredPlugins(): void {
    this.declaredPlugins.clear();
    for (const row of this.rows("channels", "channels_plugins")) {
      try {
        this.declaredPlugins.add(parseDeclared(String(row.manifest ?? "")).name);
      } catch {
        continue;
      }
    }
  }

  private rows(plugin: string, table: string): JsonRow[] {
    try {
      return this.backend.data(plugin).select(table);
    } catch {
      return [];
    }
  }

  private schedule(retry = false) {
    if (retry) {
      this.unavailable.clear();
      this.busyUntil.clear();
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.prunePartials().catch((e) => console.warn("Partial downloads not pruned:", e));
      void this.refresh().catch(reportFolderError);
    }, 300);
  }

  // Unfinished downloads of content nothing wants any more (its item was removed or its upload cancelled):
  // stops them and deletes what arrived. Runs even while a long download keeps refresh busy.
  private async prunePartials() {
    if (!this.partials.size) return;
    const wanted = wantedEverywhere();
    for (const hash of [...this.partials]) {
      if (wanted.has(hash) || this.asked.has(hash)) continue;
      this.partials.delete(hash);
      this.streams?.cancel(hash);
      if (!(await hasContent(hash))) await deleteContent(hash);
    }
  }

  // Fetches what is missing one download at a time; changes during a long download are picked up after it.
  private async refresh() {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        await this.mirror(this.wanted());
        let fetched = false;
        for (const hash of this.wanted()) {
          if (this.closed || this.refreshAgain) break;
          if (!(await hasContent(hash)) && !this.unavailable.has(hash) && !this.backingOff(hash)) fetched = (await this.fetch(hash)) || fetched;
        }
        if (fetched) await this.mirror(this.wanted());
      } while (this.refreshAgain && !this.closed);
    } finally {
      this.refreshing = false;
      this.retryBusyLater(this.wanted());
    }
  }

  // Tries each online member in turn, including ones who joined meanwhile (a member who restarts comes back
  // under a new peer id); true once the content is here.
  private async fetch(hash: string): Promise<boolean> {
    const existing = this.fetches.get(hash);
    if (existing) return existing;
    if (this.fetching.has(hash) || !this.room || !this.streams) return false;
    const task = this.fetchFromPeers(hash);
    this.fetches.set(hash, task);
    try {
      return await task;
    } finally {
      if (this.fetches.get(hash) === task) this.fetches.delete(hash);
    }
  }

  private async fetchFromPeers(hash: string): Promise<boolean> {
    const room = this.room;
    const streams = this.streams;
    if (!room || !streams) return false;
    this.fetching.add(hash);
    this.partials.add(hash);
    this.transferring.set(hash, true);
    let busy = false;
    const tried = new Set<string>();
    try {
      for (let peer; (peer = this.order(Object.keys(room.getPeers()), hash).find((p) => !tried.has(p)));) {
        tried.add(peer);
        const result = await streams.download(hash, peer);
        if (result === "done") {
          markFinished(hash, "downloaded");
          this.partials.delete(hash);
          this.unavailable.set(hash, false);
          this.busyUntil.delete(hash);
          return true;
        }
        if (result === "cancelled" || this.closed) return false;
        if (result === "busy") busy = true;
        else if (result === "failed") console.warn(`Content ${hash.slice(0, 8)} not received from a member.`);
      }
      if (busy) this.busyUntil.set(hash, performance.now() + busyRetryMs);
      else {
        this.busyUntil.delete(hash);
        this.unavailable.set(hash, true);
        this.retryLater();
      }
      return false;
    } finally {
      this.fetching.delete(hash);
      this.transferring.set(hash, false);
    }
  }

  private retryLater() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.schedule(true);
    }, retryMs);
  }

  // Content answered "busy" is asked for again once its own `busyRetryMs` passed, once the running pass is over: a retry
  // that restarted the pass made it ask the busy one first each time, and the files after it waited. Its "Nobody online
  // has it" flags and those of other content stay as they are.
  private retryBusyLater(wanted: Set<string>) {
    for (const hash of [...this.busyUntil.keys()]) if (!wanted.has(hash)) this.busyUntil.delete(hash);
    clearTimeout(this.busyTimer);
    if (this.closed || !this.busyUntil.size) return;
    const next = Math.min(...this.busyUntil.values());
    this.busyTimer = setTimeout(() => {
      this.busyTimer = undefined;
      void this.retryBusy().catch(reportFolderError);
    }, Math.max(0, next - performance.now()));
  }

  // Only the content whose "busy" wait is over: a whole pass (the folder mirrored, every wanted file looked up) every
  // 5 s while a node loaded a big upload was a lot of work in a big workspace. A pass asked for meanwhile runs after it.
  private async retryBusy() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      const wanted = this.wanted();
      let fetched = false;
      for (const hash of [...this.busyUntil.keys()]) {
        if (this.closed || this.refreshAgain) break;
        if (!wanted.has(hash) || this.backingOff(hash)) continue;
        if (await hasContent(hash)) this.busyUntil.delete(hash);
        else fetched = (await this.fetch(hash)) || fetched;
      }
      if (fetched) await this.mirror(this.wanted());
    } finally {
      this.refreshing = false;
      if (this.refreshAgain && !this.closed) void this.refresh().catch(reportFolderError);
      else this.retryBusyLater(this.wanted());
    }
  }

  private backingOff(hash: string): boolean {
    return (this.busyUntil.get(hash) ?? 0) > performance.now();
  }

  // Files were removed from the data, not hidden ("Delete from network", system/files.ts `purge`): this device lets
  // their content go too, where nothing else points at it, and stops moving it. A plain Delete keeps the content (undo
  // restores the file); kept after a permanent one, the same file uploaded again was found here and on the nodes and
  // said "On the node" at once. What the rows pointed at is from the last `wanted` pass, before the change.
  private letGo(ids: number[]) {
    const hashes = new Set<string>();
    for (const id of ids) {
      const hash = this.fileRefs.get(id);
      if (hash) hashes.add(hash);
      this.fileRefs.delete(id);
    }
    if (!hashes.size || this.closed) return;
    const wanted = wantedEverywhere();
    let held = false;
    for (const hash of hashes) {
      if (wanted.has(hash)) continue;
      for (const link of links) link.streams?.cancel(hash);
      this.streams?.stopSending(hash);
      this.deliveries.delivered(hash);
      this.waiting[1](hash, undefined);
      this.reached[1](hash, undefined);
      this.partials.delete(hash);
      this.skipped.delete(hash);
      this.busyUntil.delete(hash);
      held ||= !!this.held[0][hash];
      void deleteContent(hash).catch((e) => console.warn("Content not released:", e));
    }
    // Writes the list again without what nothing wants any more.
    if (held) this.changeHeld(() => {});
  }

  // Frees content no longer kept here or for any other workspace, and stops downloading it.
  private async release(before: Set<string>) {
    const now = wantedEverywhere();
    for (const hash of before) {
      if (now.has(hash)) continue;
      for (const link of links) link.streams?.cancel(hash);
      await deleteContent(hash);
    }
  }

  private workspaceName(): string {
    return String(this.rows("channels", "channels_workspace")[0]?.name ?? this.workspaceId);
  }

  // What the readable folder is made from; null until the channel lists and roles are read.
  private diskSource(wanted = this.wanted()): DiskSource | null {
    const server = workspaces.byId[this.workspaceId];
    if (server?.status !== "ready") return null;
    return {
      categories: server.categories, channels: server.channels, layoutFor: diskLayoutFor,
      rows: (plugin, table) => this.rows(plugin, table), kept: (hash) => wanted.has(hash),
      fileExtension: (hash) => sniffed.get(hash) ?? "",
      exportFile: async (url, format) => {
        const ref = parseLink(url);
        const channel = ref && findChannel(ref.workspaceId, ref.channelId);
        if (ref?.target?.kind !== "export" || !channel) return null;
        const provider = exportProviderFor(channel.type);
        if (!provider?.file) return null;
        return provider.file(ref.target.id, format, linkContext(ref.workspaceId, channel));
      },
      forgotten: (channelId) => this.isMarked({ kind: "forgotten", id: channelId }),
    };
  }

  // The workspace's readable folder (desktop only): every channel the member sees, written by its type's layout.
  // Nothing until the channel lists and roles are read, or it would remove what is there.
  private async mirror(wanted: Set<string>) {
    if (!desktop?.mirror) return;
    // Changes made on disk go into the data first, or this pass would write the old version over them.
    const source = this.diskSource(wanted);
    if (!source) return;
    await this.folder?.process();
    const unknown = new Set<string>();
    const sniffing = { ...source, fileExtension: (hash: string) => {
      const known = sniffed.get(hash);
      if (known === undefined) unknown.add(hash);
      return known ?? "";
    } };
    let entries: DiskEntry[];
    try {
      entries = await diskEntries(sniffing);
    } catch (e) {
      reportFolderError(e);
      return;
    }
    // Content stored without a type (docs images, design images) is named by its first bytes, read once.
    if (unknown.size) {
      for (const hash of unknown) {
        const head = await readRange(hash, 0, 64).catch(() => null);
        if (head) sniffed.set(hash, sniffExtension(head));
      }
      try {
        entries = await diskEntries(source);
      } catch (e) {
        reportFolderError(e);
        return;
      }
    }
    console.info(`Folder copy: ${entries.length} files for ${this.workspaceId}`);
    try {
      const held = this.folder?.held;
      await desktop.mirror.apply(this.workspaceId, this.workspaceName(), held?.size ? entries.filter((e) => !held.has(e.path.join("/"))) : entries);
    } catch (e) {
      reportFolderError(e);
    }
  }
}

// The readable folder stays as it was when a pass fails; the member is told once per distinct problem.
const reportedFolderErrors = new Set<string>();
function reportFolderError(error: unknown) {
  console.warn("Folder copy not updated:", error);
  const text = error instanceof Error ? error.message : String(error);
  if (reportedFolderErrors.has(text)) return;
  reportedFolderErrors.add(text);
  showNotice("Folder copy not updated", text);
}

const markKey = (mark: SyncMark) => `${mark.kind}:${mark.id}`;

// Everything any workspace's content link still keeps. wanted() reads every file row, so build this once per pass
// and look hashes up in it.
export function wantedEverywhere(): Set<string> {
  const all = new Set<string>();
  for (const link of links) for (const hash of link.wanted()) all.add(hash);
  return all;
}

// A reactive set of hashes. Each hash is its own key, so changing one only updates what shows that hash.
function flags() {
  const [get, set] = createStore<Record<string, true | undefined>>({});
  return {
    has: (hash: string) => get[hash] === true,
    set(hash: string, on: boolean) {
      if ((get[hash] === true) !== on) set(hash, on ? true : undefined);
    },
    clear: () => set(reconcile({})),
  };
}
