// New uploads from this device that no node has taken in yet, so quitting can ask first (electron/background.js, and a
// browser tab's leave prompt in core/farewell.ts). A node pulls a new upload from its uploader after the post
// (node/host.ts): "Uploaded" only means this device's copy is stored, and quitting before a node had all of it left
// large files missing or incomplete there. One counts as delivered once a node
// received all of it from here (ContentStreams `onSent` to a node peer, p2p/content.ts). One no node ever asks for
// (its content already reached the nodes another way) drops out after `forgetAfterMs`.
//
// Kept per workspace in localStorage, one key for every window of the app (a tab popped out is an app of its own, ADR
// 0009, and so is a browser tab): each saves only its own changes over what is stored, and reads it all fresh when
// asked, so the window that is asked at quit counts uploads made in the others. Saved at most once per `saveAfterMs`:
// a folder of 14k files is one upload after the other, and writing the whole list each time was quadratic.

export const forgetAfterMs = 3 * 24 * 60 * 60 * 1000;
const defaultSaveAfterMs = 1_000;

// Hash -> when it was uploaded.
export type DeliveryStore = { read(): Record<string, number>; write(entries: Record<string, number>): void };

const hashPattern = /^[0-9a-f]{64}$/;

export class Deliveries {
  // Changes not saved yet.
  private readonly added = new Map<string, number>();
  private readonly removed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly saveAfterMs: number;

  constructor(private readonly store: DeliveryStore, options: { now?: () => number; saveAfterMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.saveAfterMs = options.saveAfterMs ?? defaultSaveAfterMs;
  }

  // A new upload, to be counted until a node has all of it.
  expect(hash: string): void {
    this.added.set(hash, this.now());
    this.removed.delete(hash);
    this.saveSoon();
  }

  // A node received all of it.
  delivered(hash: string): void {
    this.added.delete(hash);
    this.removed.add(hash);
    this.saveSoon();
  }

  // Whether any upload may still be on its way (cheap: no rows looked at).
  hasAny(): boolean {
    return this.added.size > 0 || this.stored().size > 0;
  }

  // The uploads still to reach a node, in every window, among those still `kept` here (an item removed since doesn't
  // count).
  pending(kept: (hash: string) => boolean): string[] {
    this.flush();
    return [...this.stored().keys()].filter(kept);
  }

  // Saves the changes now (a window closing).
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.added.size && !this.removed.size) return;
    const entries = this.stored();
    for (const hash of this.removed) entries.delete(hash);
    for (const [hash, at] of this.added) entries.set(hash, at);
    this.added.clear();
    this.removed.clear();
    this.store.write(Object.fromEntries(entries));
  }

  // What is stored, without what is stale or isn't a content hash.
  private stored(): Map<string, number> {
    const saved = this.store.read();
    return new Map(Object.entries(saved && typeof saved === "object" ? saved : {})
      .filter(([hash, at]) => hashPattern.test(hash) && Number.isFinite(at) && this.now() - at <= forgetAfterMs));
  }

  private saveSoon() {
    this.timer ??= setTimeout(() => this.flush(), this.saveAfterMs);
  }
}
