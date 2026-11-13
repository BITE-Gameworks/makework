// The message box under chats and private conversations: rich text, emoji, files (picked, pasted or dropped on the
// view through `ref`), each copied in with progress and a cancel button before the message is sent.
import { For, Show, createSignal, type JSX } from "solid-js";
import { userMessage } from "../api/client";
import { uploadAndPost, type Upload } from "../core/files";
import { formatBytes } from "../core/time";
import { cancelUpload, uploadsIn } from "../core/uploads";
import RichEditor, { type EditorApi } from "../editor/RichEditor";
import { namedEmoji } from "../markdown/emoji";
import { playSound } from "../theme/sounds";
import { Icon } from "../theme/icons";
import Popover from "../ui/Popover";
import { EmojiGrid } from "../ui/Reactions";
import { ProgressBar } from "../ui/UploadList";
import { requestEdit } from "./editing";

// Unsent text per place, for this session.
const drafts = new Map<string, string>();

export interface ComposerApi {
  addFiles(files: File[]): void;
}

export default function MessageComposer(props: {
  // Where uploads are listed and the draft is kept, "<server>:<channel>:<thread>" or "dm:<peer>".
  place: string;
  // For mentions in the editor; "" outside servers.
  workspaceId: string;
  placeholder: string;
  send: (markdown: string, uploads: Upload[]) => Promise<void>;
  ref?: (api: ComposerApi) => void;
  onInput?: (markdown: string) => void;
  // Your last message here that can be edited; Up in the empty box edits it.
  lastOwn?: () => string | number | undefined;
  // Called after a send (also a failed one), e.g. to stop "is typing".
  onSent?: () => void;
  // Extra buttons before the emoji button, something above the editor (a poll form) and below it (typing line).
  actions?: JSX.Element;
  above?: JSX.Element;
  below?: JSX.Element;
  // Why sending isn't possible right now, shown instead of the editor.
  unavailable?: string | null;
  // Text only: no attach button, pasted files are ignored.
  noFiles?: boolean;
}) {
  const [files, setFiles] = createSignal<File[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [emojiOpen, setEmojiOpen] = createSignal(false);
  let editor!: EditorApi;
  let picker!: HTMLInputElement;
  props.ref?.({ addFiles: (added) => !props.noFiles && setFiles([...files(), ...added]) });

  const send = async (markdown: string) => {
    if (busy() || (!markdown.trim() && files().length === 0)) return;
    setBusy(true);
    // What goes now; the box stays editable while files copy in, and anything typed or added meanwhile stays for the
    // next message.
    const sending = files();
    try {
      // A file cancelled while it is copied in is left out; the rest of the message still goes.
      const copied = await Promise.all(sending.map((f) => uploadAndPost(props.place, f, async (upload) => upload)));
      const uploads = copied.filter((u): u is Upload => u !== null);
      if (markdown.trim() || uploads.length) await props.send(markdown, uploads);
      props.onSent?.();
      // What was typed after sending stays (the text that went is taken out); a box changed elsewhere is left as it is.
      const now = editor.markdown();
      if (now === markdown) {
        editor.clear();
        drafts.delete(props.place);
      } else if (now.startsWith(markdown)) editor.setMarkdown(now.slice(markdown.length).replace(/^\s+/, ""));
      setFiles(files().filter((f) => !sending.includes(f)));
      setError("");
    } catch (e) {
      setError(userMessage(e));
      playSound("error");
    } finally {
      setBusy(false);
      editor.focus();
    }
  };

  const actions = (
    <>
      <Show when={!props.noFiles}>
        <button type="button" class="icon-button" title="Attach files" aria-label="Attach files" onClick={() => picker.click()}>
          <Icon name="attach" />
        </button>
      </Show>
      {props.actions}
      <div class="mw-popover-anchor">
        <button type="button" class="icon-button" title="Emoji" aria-label="Emoji" aria-expanded={emojiOpen()}
          onMouseDown={(e) => e.preventDefault()} onClick={() => setEmojiOpen(!emojiOpen())}>
          <Icon name="emoji" />
        </button>
        <Popover open={emojiOpen()} onClose={() => setEmojiOpen(false)} label="Emoji" align="end">
          <EmojiGrid workspaceId={props.workspaceId} onPick={(code) => {
            setEmojiOpen(false);
            editor.insertText(namedEmoji[code] ?? `:${code}:`);
          }} />
        </Popover>
      </div>
      <button type="button" class="icon-button accent" title="Send (Enter)" aria-label="Send" disabled={busy()}
        onClick={() => void send(editor.markdown())}>
        <Icon name="send" />
      </button>
    </>
  );

  return (
    <div class="chat-composer">
      {props.above}
      <Show when={files().length > 0}>
        <div class="chat-uploads">
          <For each={files()}>
            {(file) => {
              // While sending: its copy in progress, and the X cancels it.
              const running = () => uploadsIn(props.place).find((u) => u.file === file);
              return (
                <span class="chat-upload mw-box mw-fade-in">
                  <Icon name={file.type.startsWith("image/") ? "image" : "file"} />
                  {file.name} <span class="muted">{running() ? `${Math.floor(running()!.progress * 100)}%` : formatBytes(file.size)}</span>
                  <button class="icon-button" aria-label={running() ? `Cancel uploading ${file.name}` : `Remove ${file.name}`}
                    title={running() ? "Cancel upload" : undefined}
                    onClick={() => {
                      const upload = running();
                      if (upload) cancelUpload(upload.id);
                      setFiles(files().filter((f) => f !== file));
                    }}>
                    <Icon name="close" />
                  </button>
                  <Show when={running()}>{(u) => <ProgressBar value={u().progress} label={`Uploading ${file.name}`} />}</Show>
                </span>
              );
            }}
          </For>
        </div>
      </Show>
      <input ref={picker} type="file" multiple hidden
        onChange={(e) => {
          setFiles([...files(), ...Array.from(e.currentTarget.files ?? [])]);
          e.currentTarget.value = "";
        }} />
      <Show when={!props.unavailable} fallback={<p class="warning chat-composer-error">{props.unavailable}</p>}>
        <RichEditor workspaceId={props.workspaceId} value={drafts.get(props.place)} placeholder={props.placeholder}
          class="chat-editor" minRows={1} ref={(api) => (editor = api)} actions={actions}
          onSubmit={(md) => void send(md)} onKeyDown={(e) => {
            if (e.key !== "ArrowUp" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || editor.markdown().trim() || files().length) return;
            const id = props.lastOwn?.();
            if (id === undefined) return;
            e.preventDefault();
            requestEdit(props.place, id);
          }}
          onInput={(md) => {
            drafts.set(props.place, md);
            props.onInput?.(md);
          }}
          onPasteFiles={(pasted) => !props.noFiles && setFiles([...files(), ...pasted])} />
      </Show>
      {props.below}
      <Show when={error()}><p class="warning chat-composer-error">{error()}</p></Show>
    </div>
  );
}
