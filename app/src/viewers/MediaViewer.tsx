import { Show } from "solid-js";
import type { FileContext } from "../plugins/types";
import { Icon } from "../theme/icons";
import { saveBlob } from "../ui/download";
import VideoPlayer from "../ui/VideoPlayer";
import { createMediaUrl } from "./content";

export function VideoViewer(props: { file: FileContext }) {
  const url = createMediaUrl(props.file);
  return (
    <div class="media-viewer">
      <Show when={url()}>
        {(src) => (
          <VideoPlayer src={src()} autoplay preload="auto" fallback={
            <button class="mw-button mw-box" onClick={() => void props.file.read().then((blob) => saveBlob(blob, props.file.name))}>
              <Icon name="download" /> Save to computer
            </button>
          } />
        )}
      </Show>
    </div>
  );
}

export function AudioViewer(props: { file: FileContext }) {
  const url = createMediaUrl(props.file);
  return (
    <div class="media-viewer audio">
      <Show when={url()}>{(src) => <audio src={src()} controls autoplay />}</Show>
      <p class="muted">{props.file.name}</p>
    </div>
  );
}
