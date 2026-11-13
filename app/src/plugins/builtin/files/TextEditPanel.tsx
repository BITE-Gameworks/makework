// Edits a text or code file of a files channel in the code editor; saving gives the file new content.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { userMessage } from "../../../api/client";
import { contentBlob } from "../../../core/content";
import { prepareUpload } from "../../../core/files";
import { codeExtensions } from "../../../viewers";
import { Icon } from "../../../theme/icons";
import Skeleton from "../../../ui/Skeleton";
import type { ChannelContext } from "../../types";
import { createEditor, type CodeEditor } from "../code/editor";
import type { Entry } from "./data";
import "../code/code.css";

export const editLimit = 1024 * 1024;
export const isEditable = (entry: Entry) =>
  entry.kind === "file" && !!entry.url && entry.size <= editLimit && codeExtensions.includes(entry.name.split(".").pop()?.toLowerCase() ?? "");

export default function TextEditPanel(props: { context: ChannelContext; entry: Entry; onClose: () => void }) {
  const ctx = props.context;
  const { id, name } = props.entry;
  let url = props.entry.url!;
  let size = props.entry.size;
  const mime = props.entry.mime;
  let host!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  let stop: (() => void) | undefined;
  const [ready, setReady] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  const setContent = (next: { url: string; size: number }) => ctx.api.call("set-content", { entry_id: id, url: next.url, size: next.size, mime });
  const save = async () => {
    if (!editor || saving() || !dirty() || !ctx.can("edit_content")) return;
    setSaving(true);
    setError("");
    try {
      const blob = new Blob([editor.value()], { type: "text/plain" });
      const upload = await prepareUpload(new File([blob], name, { type: mime }), { workspaceId: ctx.workspace.id });
      const old = { url, size };
      const next = { url: upload.url, size: blob.size };
      await setContent(next);
      url = next.url;
      size = next.size;
      setDirty(false);
      ctx.history.push({ label: `Edit "${name}"`, icon: "rename", undo: () => setContent(old), redo: () => setContent(next) });
    } catch (e) { setError(userMessage(e)); } finally { setSaving(false); }
  };
  // Closed while it was still loading: whatever arrives after that is thrown away, never left running.
  let closed = false;
  onMount(() => {
    void (async () => {
      try {
        const text = await (await contentBlob(url, "text/plain")).text();
        if (closed) return;
        const made = await createEditor(host);
        if (closed) return made.dispose();
        editor = made;
        editor.openPlain(name, text, !ctx.can("edit_content"));
        stop = editor.onChange(() => setDirty(true));
        editor.onSave(() => void save());
        setReady(true);
        requestAnimationFrame(() => { editor?.layout(); editor?.focus(); });
      } catch (e) { setError(userMessage(e)); }
    })();
  });
  onCleanup(() => {
    closed = true;
    stop?.();
    if (dirty()) void save().finally(() => editor?.dispose());
    else editor?.dispose();
  });

  return <div class="code-plain" role="presentation" onKeyDown={(event) => event.key === "Escape" && !event.defaultPrevented && props.onClose()}>
    <div class="code-plain-bar">
      <span class="code-plain-name">{name}</span>
      <Show when={error()}><span class="code-error" title={error()}>{error()}</span></Show>
      <button class="mw-button primary mw-box" disabled={!dirty() || saving() || !ctx.can("edit_content")} onClick={() => void save()}>{saving() ? "Saving…" : dirty() ? "Save" : "Saved"}</button>
      <button class="icon-button accent" title="Close editor" aria-label="Close editor" onClick={props.onClose}><Icon name="close" size={22} /></button>
    </div>
    <div class="code-editor-host">
      <div class="code-monaco" ref={host} />
      <Show when={!ready()}><div class="code-overlay"><Skeleton kind="document" header={false} /></div></Show>
    </div>
  </div>;
}
