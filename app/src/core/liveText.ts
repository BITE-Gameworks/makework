// Shared Yjs row lifecycle for live text stored in a plugin table.
import { createSignal } from "solid-js";
import * as Y from "yjs";

const saveDelay = 300;
const compactAfter = 100;
export const liveTextLocal = "local";
export const liveTextRemote = "remote";

export const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export interface LiveTextRow {
  id: number;
  data: string;
}

export interface OpenLiveTextOptions {
  list(): Promise<LiveTextRow[]>;
  add(data: string, replaces: number[]): Promise<number>;
  seed(): Promise<string>;
  subscribe?(refresh: () => void): () => void;
  // Lets a textarea retain its selection while the generic lifecycle merges remote updates.
  onRemote?(apply: () => void): void | Promise<void>;
  onError?(error: unknown): void;
}

export function openLiveText(options: OpenLiveTextOptions) {
  const doc = new Y.Doc();
  const ytext = doc.getText("body");
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const applied = new Set<number>();
  let pending: Uint8Array[] = [];
  let seedUpdate: Uint8Array | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = async () => {
    clearTimeout(timer);
    if (!pending.length) return;
    const batch = seedUpdate ? [seedUpdate, ...pending] : pending;
    pending = [];
    seedUpdate = null;
    const compact = applied.size >= compactAfter;
    const replaces = compact ? [...applied] : [];
    try {
      const id = await options.add(toBase64(compact ? Y.encodeStateAsUpdate(doc) : Y.mergeUpdates(batch)), replaces);
      replaces.forEach((old) => applied.delete(old));
      applied.add(id);
    } catch (error) {
      pending = [...batch, ...pending];
      options.onError?.(error);
    } finally {
      if (!pending.length) setSaving(false);
    }
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === liveTextRemote || origin === "seed") return;
    pending.push(update);
    setSaving(true);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), saveDelay);
  });

  const load = async () => {
    try {
      const rows = await options.list();
      if (closed) return;
      const fresh = rows.filter((row) => !applied.has(row.id));
      fresh.forEach((row) => applied.add(row.id));
      if (fresh.length) {
        const apply = () => doc.transact(
          () => fresh.forEach((row) => Y.applyUpdate(doc, fromBase64(row.data), liveTextRemote)),
          liveTextRemote,
        );
        if (options.onRemote) await options.onRemote(apply);
        else apply();
      }
      if (!loaded() && rows.length === 0) {
        const seed = await options.seed();
        if (closed) return;
        const seedDoc = new Y.Doc();
        seedDoc.clientID = 1;
        seedDoc.getText("body").insert(0, seed);
        seedUpdate = Y.encodeStateAsUpdate(seedDoc);
        Y.applyUpdate(doc, seedUpdate, "seed");
      }
      setLoaded(true);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const unsubscribe = options.subscribe?.(() => void load());
  const ready = load();
  return {
    doc,
    ytext,
    loaded,
    saving,
    ready,
    flush,
    close: async () => {
      await flush();
      closed = true;
      clearTimeout(timer);
      unsubscribe?.();
      doc.destroy();
    },
  };
}
