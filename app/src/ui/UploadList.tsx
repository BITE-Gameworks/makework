import { For, Show } from "solid-js";
import type { TransferBar } from "../core/content";
import { cancelUpload, uploadsIn } from "../core/uploads";
import { Icon } from "../theme/icons";
import { createPresence } from "./presence";
import "./UploadList.css";

// A thin bar filled to `value` (0 to 1).
export function ProgressBar(props: { value: number; label?: string }) {
  return (
    <span class="mw-progress" role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.floor(props.value * 100)}>
      <span class="mw-progress-fill" style={{ transform: `scaleX(${props.value})` }} />
    </span>
  );
}

// A file's transfer bar (core/content.ts transferBar): fades in when content starts moving and out a moment
// after it is done, keeping its last value while it fades.
export function TransferProgress(props: { bar: TransferBar | undefined }) {
  const presence = createPresence(() => !!props.bar);
  let last: TransferBar = { value: 0, label: "", done: false };
  const bar = () => (last = props.bar ?? last);
  return (
    <Show when={presence.mounted()}>
      <span class="mw-transfer" classList={{ visible: presence.visible(), done: bar().done }}>
        <ProgressBar value={bar().value} label={bar().label} />
      </span>
    </Show>
  );
}

// Files being copied in for `place` (core/uploads.ts), each with its progress and a cancel button.
export default function UploadList(props: { place: string; class?: string }) {
  const list = () => uploadsIn(props.place);
  return (
    <Show when={list().length > 0}>
      <ul class={`mw-uploads mw-box mw-fade-in ${props.class ?? ""}`} aria-label="Uploads">
        <For each={list()}>
          {(u) => (
            <li class="mw-upload mw-fade-in">
              <Icon name="upload" />
              <span class="mw-upload-name">{u.name}</span>
              <span class="muted">{Math.floor(u.progress * 100)}%</span>
              <button class="icon-button" title="Cancel upload" aria-label={`Cancel uploading ${u.name}`} onClick={() => cancelUpload(u.id)}>
                <Icon name="close" />
              </button>
              <ProgressBar value={u.progress} label={`Uploading ${u.name}`} />
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
