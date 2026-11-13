// The full-window file viewer: picks the best viewer plugin for the file, with a choice when several fit.
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { closeFile, openedFile } from "../core/files";
import { activeTabId, current } from "../core/navigation";
import { formatBytes } from "../core/time";
import MountPoint from "../plugins/MountPoint";
import { viewersFor } from "../plugins/registry";
import type { FileContext } from "../plugins/types";
import { Icon } from "../theme/icons";
import { createPresence } from "../ui/presence";
import Select from "../ui/Select";
import Skeleton from "../ui/Skeleton";
import { dialogOpen } from "../ui/Dialog";
import { saveBlob } from "../ui/download";
import { userMessage } from "../api/client";

export default function ViewerOverlay() {
  const presence = createPresence(() => openedFile() !== null);
  // Keeps the last file while the overlay fades out.
  const [shown, setShown] = createSignal<FileContext | null>(null);
  createEffect(() => {
    const file = openedFile();
    if (file) setShown(file);
  });

  // Like overlays, an open file closes when the user goes to another channel or tab.
  const place = createMemo(() => {
    const here = current();
    return `${activeTabId()}:${here?.workspaceId}:${here?.channelId}:${here?.peer ?? ""}`;
  });
  createEffect(on(place, () => closeFile(), { defer: true }));

  createEffect(() => {
    if (!openedFile()) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && !dialogOpen() && closeFile();
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={presence.mounted() && shown()} keyed>
      {(file) => (
        <div class="viewer-overlay" classList={{ visible: presence.visible() }} role="dialog" aria-modal="true" aria-label={file.name}>
          <Viewer file={file} />
        </div>
      )}
    </Show>
  );
}

function Viewer(props: { file: FileContext }) {
  const matches = viewersFor(props.file.name, props.file.mimeType);
  const [choice, setChoice] = createSignal(0);
  const [content] = createResource(() => props.file.read());

  // The content the viewer already has; the button waits for it.
  const download = () => {
    const blob = content();
    if (blob) saveBlob(blob, props.file.name);
  };

  return (
    <>
      <header class="viewer-header">
        <Icon name={props.file.mimeType.startsWith("image/") ? "image" : "file"} size={20} />
        <div class="viewer-title">
          <span class="viewer-name">{props.file.name}</span>
          <span class="muted">{formatBytes(props.file.size)} {props.file.mimeType}</span>
        </div>
        <Show when={matches.length > 1}>
          <label class="viewer-with">
            <span class="muted">Open with</span>
            <Select label="Open with" value={choice()} options={matches.map((m, i) => ({ value: i, label: m.info.label }))} onChange={setChoice} />
          </label>
        </Show>
        <For each={props.file.actions ?? []}>
          {(a) => <button class="mw-button mw-box" onClick={a.run}><Icon name={a.icon} /> {a.label}</button>}
        </For>
        <Show when={props.file.edit}>
          <button class="mw-button mw-box" onClick={() => { closeFile(); props.file.edit!(); }}><Icon name="rename" /> Edit</button>
        </Show>
        <button class="mw-button mw-box" onClick={download} disabled={!content()}>
          <Icon name="download" /> Download
        </button>
        <button class="icon-button accent" title="Close (Esc)" aria-label="Close viewer" onClick={closeFile}>
          <Icon name="close" size={22} />
        </button>
      </header>
      <div class="viewer-body">
        <Switch>
          <Match when={content.error}>
            <p class="viewer-note warning">Could not load this file: {userMessage(content.error)}</p>
          </Match>
          <Match when={content.loading}>
            <Skeleton kind="document" header={false} />
          </Match>
          <Match when={matches.length === 0}>
            <div class="viewer-note">
              <p>There is no viewer for this kind of file yet.</p>
              <p class="muted">Plugins can add viewers; see Settings, Plugins.</p>
            </div>
          </Match>
          <Match when={content()}>
            <ViewerMount file={props.file} choice={choice()} matches={matches} />
          </Match>
        </Switch>
      </div>
    </>
  );
}

// Keyed on the match, so choosing another viewer remounts.
function ViewerMount(props: { file: FileContext; choice: number; matches: ReturnType<typeof viewersFor> }) {
  return (
    <Show when={props.matches[props.choice]} keyed>
      {(match) => <MountPoint class="viewer-mount" mount={(element) => match.viewer(element, props.file)} />}
    </Show>
  );
}
