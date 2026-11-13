// The app's IndexedDB database. Holds what localStorage can't: CryptoKey objects (stored non-extractable) and,
// in the browser, file content (`content`, one Blob per hash) and content still arriving (`content-parts`, one
// Blob per chunk under "<upload or hash>:<index>"), signed commits (`commits`), private messages (`messages`,
// "<account>:<peer>:<time>:<id>"), which workspaces each account joined (`servers`), installed plugins (`plugins`)
// and ledger checkpoints (`checkpoints`).

const name = "makework";
// 6: `messages` and `servers` were both added as version 5 in parallel; 6 makes sure every copy gets both.
// 7: `plugins` (installed .mwp packages, one per plugin id). 8: durable ledger checkpoints.
const version = 8;
export type StoreName = "accounts" | "sessions" | "content" | "content-parts" | "commits" | "messages" | "servers" | "plugins" | "checkpoints";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions");
      if (!db.objectStoreNames.contains("content")) db.createObjectStore("content");
      if (!db.objectStoreNames.contains("content-parts")) db.createObjectStore("content-parts");
      if (!db.objectStoreNames.contains("commits")) db.createObjectStore("commits");
      if (!db.objectStoreNames.contains("messages")) db.createObjectStore("messages");
      if (!db.objectStoreNames.contains("servers")) db.createObjectStore("servers");
      if (!db.objectStoreNames.contains("plugins")) db.createObjectStore("plugins", { keyPath: "id" });
      if (!db.objectStoreNames.contains("checkpoints")) db.createObjectStore("checkpoints");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("The database couldn't be opened."));
    };
  });
  return opening;
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = action(db.transaction(store, mode).objectStore(store));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("The database request failed."));
  });
}

export const dbGet = <T>(store: StoreName, key: string) => run<T | undefined>(store, "readonly", (s) => s.get(key));
export const dbHas = (store: StoreName, key: string) => run<number>(store, "readonly", (s) => s.count(key)).then((n) => n > 0);
export const dbAll = <T>(store: StoreName) => run<T[]>(store, "readonly", (s) => s.getAll());
export const dbPut = (store: StoreName, value: unknown, key?: string) =>
  run<void>(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export async function dbPutMany(store: StoreName, entries: readonly (readonly [string, unknown])[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    for (const [key, value] of entries) transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The database write failed."));
  });
}
export const dbDelete = (store: StoreName, key: string) => run<void>(store, "readwrite", (s) => s.delete(key));
export async function dbDeleteMany(store: StoreName, keys: readonly string[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    for (const key of keys) transaction.objectStore(store).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The database write failed."));
  });
}

// Every key starting with "<prefix>:".
export const prefixRange = (prefix: string) => IDBKeyRange.bound(`${prefix}:`, `${prefix}:\uffff`);
export const dbGetRange = <T>(store: StoreName, range: IDBKeyRange) => run<T[]>(store, "readonly", (s) => s.getAll(range));
export const dbDeleteRange = (store: StoreName, range: IDBKeyRange) => run<void>(store, "readwrite", (s) => s.delete(range));
