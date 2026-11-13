import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { uploadAndPost } from "../../../core/files";
import LinkPicker, { type Pick } from "../../../editor/LinkPicker";
import type { ChannelContext } from "../../types";
import { caretPoint } from "./caret";
import type { PageText } from "./collab";

type Presence = { page?: number; a?: unknown; h?: unknown } | null;
const conflictWindowMs = 5_000;
const conflictNoticeMs = 10_000;

// The markdown box of a docs page: everyone types into the same text, other members' carets show in their colors,
// # (or Ctrl+K) inserts a link, pasted or dropped images are uploaded and inserted.
export default function LiveEditor(props: {
  context: ChannelContext;
  page: PageText;
  disabled: boolean;
  onError: (e: unknown) => void;
  ref?: (el: HTMLTextAreaElement) => void;
}) {
  const ctx = props.context;
  let el!: HTMLTextAreaElement;
  const [scroll, setScroll] = createSignal(0);
  const [size, setSize] = createSignal(0);
  const [picker, setPicker] = createSignal<{ at: { x: number; top: number; bottom: number }; query?: string; from: number } | null>(null);
  const [conflicts, setConflicts] = createSignal<number[]>([]);
  const recentEdits = new Map<number, number>();
  const conflictTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let pickerKeys: ((e: KeyboardEvent) => boolean) | null = null;

  // Shares where our caret is, as positions that survive everyone's edits.
  const share = () => {
    if (document.activeElement !== el) return;
    const paragraph = el.value.slice(0, el.selectionStart).split("\n").length - 1;
    ctx.presence.set({
      page: props.page.pageId, a: props.page.position(el.selectionStart), h: props.page.position(el.selectionEnd),
      editingParagraph: paragraph,
    });
  };
  const stopEdits = props.page.onEdit(({ origin, paragraph }) => {
    const now = Date.now();
    for (const [line, at] of recentEdits) if (now - at > conflictWindowMs) recentEdits.delete(line);
    if (origin === "local") {
      recentEdits.set(paragraph, now);
      return;
    }
    if (now - (recentEdits.get(paragraph) ?? 0) > conflictWindowMs) return;
    setConflicts((current) => current.includes(paragraph) ? current : [...current, paragraph]);
    clearTimeout(conflictTimers.get(paragraph));
    conflictTimers.set(paragraph, setTimeout(() => {
      conflictTimers.delete(paragraph);
      setConflicts((current) => current.filter((line) => line !== paragraph));
    }, conflictNoticeMs));
  });
  onCleanup(() => {
    stopEdits();
    for (const timer of conflictTimers.values()) clearTimeout(timer);
    conflictTimers.clear();
  });
  onMount(() => {
    const onSelection = () => document.activeElement === el && share();
    document.addEventListener("selectionchange", onSelection);
    const observer = new ResizeObserver(() => setSize(el.offsetWidth * 10000 + el.offsetHeight));
    observer.observe(el);
    onCleanup(() => {
      document.removeEventListener("selectionchange", onSelection);
      observer.disconnect();
      ctx.presence.set(null);
    });
  });

  const others = createMemo(() => ctx.presence.others().flatMap((o) => {
    const state = o.state as Presence;
    if (state?.page !== props.page.pageId) return [];
    props.page.text();
    const at = props.page.index(state.h);
    return at === null ? [] : [{ userId: o.userId, at }];
  }));
  const carets = createMemo(() => {
    props.page.text();
    scroll();
    size();
    if (!el?.isConnected) return [];
    return others().map((o) => ({ ...o, point: caretPoint(el, o.at), who: ctx.users.get(o.userId) }));
  });

  // # starts a link when it begins a word: the text after it searches channels and objects.
  const checkHash = () => {
    const before = el.value.slice(0, el.selectionStart);
    const match = /(^|\s)#([^\s#]*)$/.exec(before);
    if (!match) return setPicker(null);
    const from = el.selectionStart - match[2].length - 1;
    setPicker({ at: pointAt(from), query: match[2], from });
  };
  const pointAt = (index: number) => {
    const p = caretPoint(el, index);
    const r = el.getBoundingClientRect();
    return { x: r.left + p.left, top: r.top + p.top, bottom: r.top + p.top + p.height };
  };
  const pick = (choice: Pick) => {
    const p = picker();
    setPicker(null);
    if (!p) return;
    const link = `${choice.embed ? "!" : ""}[${choice.title.replace(/[[\]]/g, "")}](${choice.url})`;
    const from = p.query !== undefined ? p.from : el.selectionStart;
    props.page.replaceRange(from, el.selectionEnd, link);
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(from + link.length, from + link.length);
    });
  };

  const insertImages = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return false;
    const place = `${ctx.workspace.id}:${ctx.channel.id}`;
    void (async () => {
      for (const file of images) {
        try {
          await uploadAndPost(place, file, async (upload) => {
            const at = el.selectionStart;
            // Images go on a line of their own, so they never join a table row or a heading.
            const before = at > 0 && el.value[at - 1] !== "\n" ? "\n\n" : "";
            const after = el.value[el.selectionEnd] && el.value[el.selectionEnd] !== "\n" ? "\n\n" : "\n";
            const text = `${before}![${file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "")}](${upload.url})${after}`;
            props.page.replaceRange(at, el.selectionEnd, text);
            el.setSelectionRange(at + text.length, at + text.length);
          });
        } catch (e) {
          props.onError(e);
        }
      }
    })();
    return true;
  };

  createEffect(() => {
    // Keeps the textarea's caret where it is when the text is set from outside (own undo, others' edits).
    const value = props.page.text();
    if (el && el.value !== value) {
      const [a, b] = [el.selectionStart, el.selectionEnd];
      el.value = value;
      if (document.activeElement === el) el.setSelectionRange(Math.min(a, value.length), Math.min(b, value.length));
    }
  });

  return (
    <div class="docs-live">
      <textarea ref={(e) => { el = e; props.ref?.(e); }} class="docs-editor mw-input" spellcheck={true} disabled={props.disabled}
        placeholder="Write markdown: # Heading, **bold**, - lists, | tables |, ```code```. Type # to link, paste or drop images."
        onInput={() => {
          props.page.edit(el.value);
          share();
          checkHash();
        }}
        onScroll={() => setScroll(el.scrollTop)}
        onFocus={share}
        onBlur={() => {
          void props.page.flush();
          // The picker's own search box (Ctrl+K) takes the focus; that isn't leaving the editor.
          setTimeout(() => !document.activeElement?.closest(".mw-link-picker") && setPicker(null), 150);
        }}
        onPaste={(e) => {
          if (insertImages([...(e.clipboardData?.files ?? [])])) e.preventDefault();
        }}
        onDragOver={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (insertImages([...(e.dataTransfer?.files ?? [])])) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (picker() && pickerKeys?.(e)) return;
          const mod = e.ctrlKey || e.metaKey;
          const k = e.key.toLowerCase();
          if (mod && k === "z") {
            e.preventDefault();
            e.shiftKey ? props.page.redo() : props.page.undo();
          } else if (mod && k === "y") {
            e.preventDefault();
            props.page.redo();
          } else if (mod && k === "k") {
            e.preventDefault();
            setPicker({ at: pointAt(el.selectionStart), from: el.selectionStart });
          } else if (e.key === "Tab") {
            e.preventDefault();
            props.page.replaceRange(el.selectionStart, el.selectionEnd, "  ");
            const at = el.selectionStart + 2;
            queueMicrotask(() => el.setSelectionRange(at, at));
          }
          e.stopPropagation();
        }} />
      <div class="docs-carets" aria-hidden="true">
        <For each={carets()}>
          {(c) => (
            <div class="docs-caret" style={{
              "--who": c.who.color || "var(--mw-text-muted)",
              transform: `translate(${c.point.left}px, ${c.point.top}px)`,
              height: `${c.point.height}px`,
            }}>
              <span class="docs-caret-name">{c.who.displayName}</span>
            </div>
          )}
        </For>
      </div>
      <div class="docs-conflicts" aria-live="polite">
        <For each={conflicts()}>
          {(paragraph) => <div class="docs-conflict mw-box">Concurrent edit in paragraph {paragraph + 1}</div>}
        </For>
      </div>
      <Show when={picker()}>
        {(p) => (
          <LinkPicker workspaceId={ctx.workspace.id} at={p().at} query={p().query} onPick={pick}
            onClose={() => { setPicker(null); el.focus(); }} keys={(handler) => (pickerKeys = handler)} />
        )}
      </Show>
    </div>
  );
}
