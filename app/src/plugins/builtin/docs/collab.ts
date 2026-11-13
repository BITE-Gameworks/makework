// A docs page's text as a Yjs document, so members can type at once and no edit is lost: every change is saved as a
// small update row (in the signed log like any other change), and every copy merges all rows to the same text.
import { createSignal } from "solid-js";
import * as Y from "yjs";
import type { PluginClient } from "../../../api/client";
import type { ApiValue } from "../../../api/types";
import { liveTextLocal, liveTextRemote, openLiveText } from "../../../core/liveText";
import { encodeEmoji } from "../../../markdown/emoji";

export type PageText = ReturnType<typeof openPageText>;
export type PageEdit = { origin: "local" | "remote"; paragraph: number };

// `seed` is the page's plain text, used when the page has no updates yet (pages written before live editing).
// `caretOf` names the textarea whose caret should stay on the same character when others' edits arrive.
export function openPageText(api: PluginClient, pageId: number, seed: () => Promise<string>, options: {
  caretOf: () => HTMLTextAreaElement | undefined;
  onError: (e: unknown) => void;
}) {
  const [text, setText] = createSignal("");
  let previousText = "";
  const editListeners = new Set<(edit: PageEdit) => void>();

  let live!: ReturnType<typeof openLiveText>;
  const applyRemote = (apply: () => void) => {
    const doc = live.doc;
    const ytext = live.ytext;
    const el = options.caretOf();
    const focused = el && document.activeElement === el;
    const rel = (index: number) => Y.createRelativePositionFromTypeIndex(ytext, index);
    const abs = (pos: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(pos, doc)?.index ?? null;
    const sel = focused ? [rel(el.selectionStart), rel(el.selectionEnd)] : null;
    apply();
    if (el && sel) {
      const [a, b] = sel.map(abs);
      if (a !== null && b !== null) el.setSelectionRange(a, b);
    }
  };
  live = openLiveText({
    list: async () => {
      const { rows } = await api.call<{ rows: Record<string, ApiValue>[] }>("list-updates", { page_id: pageId });
      return rows.map((row) => ({ id: Number(row.id), data: String(row.data) }));
    },
    add: async (data, replaces) => {
      const { id } = await api.call<{ id: number }>("add-update", {
        page_id: pageId, data, body: encodeEmoji(live.ytext.toString()),
        ...(replaces.length ? { replaces: JSON.stringify(replaces) } : {}),
      });
      return id;
    },
    seed,
    subscribe: (refresh) => api.onEvent((event) => event.table === "docs_updates" && refresh()),
    onRemote: async (apply) => {
      applyRemote(apply);
      await refreshBody();
    },
    onError: options.onError,
  });
  const { doc, ytext } = live;
  const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([liveTextLocal]) });

  doc.on("update", (_update: Uint8Array, origin: unknown) => {
    const nextText = ytext.toString();
    if (origin !== "seed") {
      let start = 0;
      while (start < previousText.length && start < nextText.length && previousText[start] === nextText[start]) start++;
      const paragraph = nextText.slice(0, start).split("\n").length - 1;
      editListeners.forEach((listener) => listener({ origin: origin === liveTextRemote ? "remote" : "local", paragraph }));
    }
    previousText = nextText;
    setText(nextText);
  });

  const rel = (index: number) => Y.createRelativePositionFromTypeIndex(ytext, index);
  const abs = (pos: Y.RelativePosition) => Y.createAbsolutePositionFromRelativePosition(pos, doc)?.index ?? null;

  // Each save stores the text as its writer saw it. When others typed at the same time, the plain copy can miss
  // their part, so after merging their rows the copy is saved again if it no longer matches.
  const refreshBody = async () => {
    if (live.saving()) return;
    const { page } = await api.call<{ page: Record<string, ApiValue> }>("get-page", { page_id: pageId });
    // Stored text is trimmed, so compare it that way.
    const body = encodeEmoji(ytext.toString());
    if (String(page.body ?? "").trim() !== body.trim()) await api.call("update-page", { page_id: pageId, body });
  };

  // Turns the textarea's new value into the smallest edit: one changed range between a common start and end.
  const edit = (next: string) => {
    const old = ytext.toString();
    if (next === old) return;
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let end = 0;
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
    doc.transact(() => {
      if (old.length - start - end > 0) ytext.delete(start, old.length - start - end);
      if (next.length - start - end > 0) ytext.insert(start, next.slice(start, next.length - end));
    }, liveTextLocal);
  };

  const replaceRange = (from: number, to: number, insert: string) => doc.transact(() => {
    if (to > from) ytext.delete(from, to - from);
    if (insert) ytext.insert(from, insert);
  }, liveTextLocal);

  return {
    pageId, text, loaded: live.loaded, ready: live.ready, saving: live.saving, edit, replaceRange, flush: live.flush,
    undo: () => undo.undo(),
    redo: () => undo.redo(),
    // Positions that follow their characters through everyone's edits, as JSON for presence.
    position: (index: number) => Y.relativePositionToJSON(rel(index)),
    onEdit: (listener: (edit: PageEdit) => void) => {
      editListeners.add(listener);
      return () => editListeners.delete(listener);
    },
    index: (json: unknown) => {
      try {
        return abs(Y.createRelativePositionFromJSON(json as object));
      } catch {
        return null;
      }
    },
    close: async () => {
      editListeners.clear();
      undo.destroy();
      await live.close();
    },
  };
}
