// Notes: a conversation with yourself under private messages, for writing things down quickly. Kept on this computer
// and, for accounts with a user server, in the account's vault (core/vault.ts: encrypted so only this account can
// read it), split into pages under the vault's size limit, so every computer signed in to the account has them.
import { createSignal } from "solid-js";
import { account, accountAgreementKey } from "../core/account";
import { base64url } from "../core/identity";
import { readJson, writeJson } from "../core/storage";
import { readVaultDoc, updateVault } from "../core/vault";

export const notesPeer = "@notes";

export interface Note {
  id: string;
  at: number;
  text: string;
  editedAt?: number;
  // Written here but not in the vault yet (offline, or the write failed); sent again on the next sync.
  pending?: boolean;
}

interface Index {
  pages: number;
}

const indexName = "notes";
const pageName = (page: number) => `notes-${page}`;
// The vault takes 128 KB of sealed text; sealing adds about a third.
const pageLimit = 80_000;

const [notes, setNotes] = createSignal<Note[]>([]);
const [syncError, setSyncError] = createSignal("");
const pageOf = new Map<string, number>();
let syncing: Promise<void> | null = null;

export { notes, syncError as notesError };

const cacheKey = () => `mw.notes.${account()?.id ?? ""}`;
// Accounts without a user server, in offline mode or without their agreement key keep notes on this computer only.
const synced = () => !!account() && !account()!.offline && !account()!.offlineMode && !!accountAgreementKey();
const sorted = (list: Note[]) => list.slice().sort((a, b) => a.at - b.at);

function show(list: Note[]) {
  const next = sorted(list);
  setNotes(next);
  writeJson(cacheKey(), next);
}

// The notes kept on this computer at once, then the vault's.
export function loadNotes(): void {
  show(readJson<Note[]>(cacheKey(), []));
  void syncNotes();
}

// Reads every page, keeps what this computer hasn't sent yet and sends it. One sync at a time.
export function syncNotes(): Promise<void> {
  if (!synced()) return Promise.resolve();
  syncing ??= (async () => {
    try {
      const index = await readVaultDoc<Index>(indexName);
      const remote: Note[] = [];
      pageOf.clear();
      for (let page = 1; page <= (index?.pages ?? 0); page++) {
        for (const note of (await readVaultDoc<Note[]>(pageName(page))) ?? []) {
          remote.push(note);
          pageOf.set(note.id, page);
        }
      }
      const waiting = notes().filter((n) => n.pending && !pageOf.has(n.id));
      show([...remote, ...waiting]);
      for (const note of waiting) await push(note);
      setSyncError("");
    } catch (e) {
      setSyncError(`Notes aren't synced with your other computers right now: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// Adds a note to the last page, or a new page when it is full.
async function push(note: Note) {
  const saved = { id: note.id, at: note.at, text: note.text };
  const index = await updateVault<Index>(indexName, (current) => (current ? null : { pages: 1 }));
  let page = index?.pages ?? 1;
  let full = false;
  await updateVault<Note[]>(pageName(page), (current) => {
    const list = current ?? [];
    if (list.some((n) => n.id === note.id)) return null;
    full = list.length > 0 && JSON.stringify(list).length + note.text.length > pageLimit;
    return full ? null : [...list, saved];
  });
  if (full) {
    const grown = await updateVault<Index>(indexName, (current) => ({ pages: Math.max(current?.pages ?? 1, page) + 1 }));
    page = grown?.pages ?? page + 1;
    await updateVault<Note[]>(pageName(page), (current) => [...(current ?? []), saved]);
  }
  pageOf.set(note.id, page);
  show(notes().map((n) => (n.id === note.id ? { ...n, pending: undefined } : n)));
}

export async function addNote(text: string): Promise<void> {
  const note: Note = { id: base64url(crypto.getRandomValues(new Uint8Array(12))), at: Date.now(), text, pending: synced() || undefined };
  show([...notes(), note]);
  if (!synced()) return;
  try {
    await push(note);
  } catch (e) {
    throw new Error(`Saved on this computer; it goes to your other computers on the next sync (${e instanceof Error ? e.message : String(e)}).`);
  }
}

// Changes a note where it is kept; the vault's copy wins over one another computer changed meanwhile only for this note.
async function change(id: string, apply: (list: Note[]) => Note[]) {
  show(apply(notes()));
  const page = pageOf.get(id);
  if (!synced() || page === undefined) return;
  await updateVault<Note[]>(pageName(page), (current) => (current ? apply(current) : null));
}

export const editNote = (id: string, text: string) =>
  change(id, (list) => list.map((n) => (n.id === id ? { ...n, text, editedAt: Date.now() } : n)));

export const deleteNote = (id: string) => change(id, (list) => list.filter((n) => n.id !== id));
