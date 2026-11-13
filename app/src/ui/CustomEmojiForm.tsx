// Uploads one custom emoji: choose a small image, give it a shortcode, then copy it in with progress and a cancel
// button. Used by the emoji picker and Workspace settings > Emoji.
import { Show, createSignal, onCleanup } from "solid-js";
import { addCustomEmoji, customEmojiByName, type CustomEmoji } from "../core/customEmoji";
import { formatBytes } from "../core/time";
import { emojiNameProblem } from "../markdown/emoji";
import { emojiMimes, maxEmojiBytes } from "../system/emoji";
import { Icon } from "../theme/icons";
import UploadList from "./UploadList";
import { trimChars } from "../core/text";

const accept = "image/png,image/jpeg,image/webp,image/gif";
const extensions: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

function mimeOf(file: File): string {
  if (file.type === "image/jpg") return "image/jpeg";
  if (emojiMimes.includes(file.type)) return file.type;
  return extensions[file.name.toLowerCase().split(".").pop() ?? ""] ?? "";
}

function fileProblem(file: File): string | null {
  if (!mimeOf(file)) return "Choose a PNG, JPEG, WebP or GIF image.";
  if (file.size > maxEmojiBytes) return "Emoji images can be at most 512 KB.";
  return null;
}

function nameFromFile(file: File): string {
  const base = trimChars(file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_"), "_").slice(0, 32);
  return (base.length >= 2 ? base : `${base || "emoji"}emoji`).slice(0, 32);
}

export default function CustomEmojiForm(props: {
  workspaceId: string;
  place?: string;
  onDone: (emoji: CustomEmoji) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = createSignal<File | null>(null);
  const [name, setName] = createSignal("");
  const [preview, setPreview] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const place = () => props.place ?? `${props.workspaceId}:emoji`;
  const choose = (next: File | null) => {
    if (preview()) URL.revokeObjectURL(preview()!);
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : null);
    setError("");
    if (next) setName(nameFromFile(next));
  };
  onCleanup(() => {
    if (preview()) URL.revokeObjectURL(preview()!);
  });
  const problem = () => {
    if (!file()) return "Choose an image.";
    const bad = fileProblem(file()!);
    if (bad) return bad;
    const badName = emojiNameProblem(name());
    if (badName) return badName;
    if (customEmojiByName(props.workspaceId, name())) return `An emoji named :${name()}: already exists, or its name is still reserved.`;
    return null;
  };
  const valid = () => !!file() && !problem() && !busy();
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid()) return;
    setBusy(true);
    setError("");
    try {
      const added = await addCustomEmoji(props.workspaceId, file()!, name(), place());
      if (added) props.onDone(added);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="mw-emoji-form mw-fade-in" onSubmit={(event) => void submit(event)}>
      <div class="mw-emoji-form-file">
        <Show when={preview()} fallback={<span class="mw-emoji-form-preview mw-box"><Icon name="image" /></span>}>
          <img class="mw-emoji-form-preview mw-box" src={preview()!} alt="" />
        </Show>
        <label class="mw-button mw-box mw-emoji-form-pick">
          <span>{file()?.name ?? "Choose image"}</span>
          <small>{file() ? formatBytes(file()!.size) : "PNG, JPEG, WebP or GIF, up to 512 KB"}</small>
          <input type="file" accept={accept} hidden onChange={(e) => {
            choose(e.currentTarget.files?.[0] ?? null);
            e.currentTarget.value = "";
          }} />
        </label>
      </div>
      <label class="mw-emoji-form-name">
        <span>:</span>
        <input class="mw-input mw-box" placeholder="emoji_name" value={name()} aria-label="Emoji name"
          onInput={(e) => setName(e.currentTarget.value)}
          onBlur={(e) => setName(e.currentTarget.value.trim().toLowerCase())} />
        <span>:</span>
      </label>
      <Show when={problem() && (file() || name())}><p class="warning mw-emoji-form-error">{problem()}</p></Show>
      <Show when={error()}><p class="warning mw-emoji-form-error">{error()}</p></Show>
      <UploadList place={place()} class="mw-emoji-form-upload" />
      <div class="mw-emoji-form-actions">
        <button type="button" class="mw-button mw-box" onClick={() => props.onCancel()} disabled={busy()}>Cancel</button>
        <button type="submit" class="mw-button primary mw-box" disabled={!valid()}>Add emoji</button>
      </div>
    </form>
  );
}
