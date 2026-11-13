import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import Skeleton from "../../../ui/Skeleton";
import { userMessage } from "../../../api/client";
import { fileFromUrl } from "../../../core/files";
import { formatBytes, relativeTime } from "../../../core/time";
import {
  canUploadToNode, cancelDownload, cancelSend, contentSync, contentUrl, downloadProgress, getAndOpen, isLocal, isSynced, setSynced,
  transferBar, transferKind, transferLabel, transferStatus, uploadAction, uploadToNode, type SyncMark,
} from "../../../core/content";
import { cancelUpload, uploadsIn, type RunningUpload } from "../../../core/uploads";
import { Icon } from "../../../theme/icons";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import { ConfirmItem } from "../../../shell/channelMenu";
import Collapse from "../../../ui/Collapse";
import { createProgressive, watchNear } from "../../../ui/progressive";
import { viewersFor } from "../../registry";
import type { ChannelContext, MenuEntry } from "../../types";
import { copyLink } from "../../../core/links";
import { createListing, getEntry, freeName, lastFolder, rememberFolder, savedLayout, saveLayout, uploadTree, type Entry, type Layout } from "./data";
import { fromDrop, fromPicked, itemCount, type UploadTree } from "./folders";
import { cancelSave, savesIn, startSave, type SaveJob, type SaveMode } from "./save";
import { historyKeys } from "../../../core/history";
import HistoryControls from "../../../ui/HistoryControls";
import { DropHint, createFileDrop } from "../../../ui/FileDrop";
import TextEditPanel, { isEditable } from "./TextEditPanel";
import NewFileForm from "../NewFileForm";
import { dropCodeFile, hasCodeFile, readCodePayload } from "../codeDrag";
import { mimeOfName } from "../../../core/fileNames";
import { ProgressBar, TransferProgress } from "../../../ui/UploadList";
import type { HostingNode } from "../../../p2p/nodes";
import StartPartyDialog from "../../../watch/StartPartyDialog";
import type { NewPartyItem } from "../../../watch/data";
import "../views.css";
import "./files.css";

const entryType = "application/x-makework-entry";

export default function FilesView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const key = `${ctx.workspace.id}:${ctx.channel.id}`;
  const [folder, setFolder] = createSignal(lastFolder(key));
  const listing = createListing(ctx.api, ctx.channel.id, folder);
  // A big folder shows in pieces (ui/progressive.ts): a screenful at once, more in the background, the rest as the
  // reader scrolls down. Started again for each folder (its path comes with its entries).
  const entries = createProgressive(() => listing.value.entries, {
    from: "start", first: 60, limit: 300, key: () => listing.value.path.at(-1)?.id ?? null,
  });
  let scroller!: HTMLDivElement;
  let bottom!: HTMLDivElement;
  onMount(() => onCleanup(watchNear(bottom, scroller, () => entries.more()).stop));
  const [layout, setLayout] = createSignal<Layout>(savedLayout());
  const [showHosting, setShowHosting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [naming, setNaming] = createSignal(false);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [namingFile, setNamingFile] = createSignal(false);
  let picker!: HTMLInputElement;
  // A path wider than the screen scrolls; the folder you are in stays in view.
  let crumbs!: HTMLElement;
  createEffect(on(() => listing.value.path.length, () => queueMicrotask(() => (crumbs.scrollLeft = crumbs.scrollWidth))));
  let folderPicker!: HTMLInputElement;

  createEffect(() => rememberFolder(key, folder()));
  // The open folder was deleted, maybe by someone else.
  createEffect(on(() => listing.error, (e) => e && folder() !== null && setFolder(null)));

  const names = () => new Set(listing.value.entries.map((e) => e.name));
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError("");
    } catch (e) {
      setError(userMessage(e));
      ctx.playSound("error");
    }
  };

  // Each change is recorded for undo; deleted entries come back with restore.
  const call = (action: string, args: Record<string, string | number | null>) => ctx.api.call(action, args);
  const removeAll = (ids: number[]) => Promise.all(ids.map((id) => call("remove", { entry_id: id })));
  const restoreAll = (ids: number[]) => Promise.all(ids.map((id) => call("restore", { entry_id: id })));
  const record = (label: string, icon: string, undo: () => Promise<unknown>, redo: () => Promise<unknown>) =>
    ctx.history.push({ label, icon, undo, redo });
  const quote = (name: string) => `"${name}"`;

  // Uploads run beside other actions, each shown as a card in its folder until it is posted or cancelled.
  const uploadPlace = () => `${key}:${folder() ?? ""}`;
  const upload = async (tree: UploadTree) => {
    if (!itemCount(tree)) return;
    try {
      const ids = await uploadTree(ctx.api, uploadPlace(), ctx.channel.id, folder(), tree, names());
      if (!ids.length) return;
      setError("");
      ctx.playSound("upload-done");
      const only = itemCount(tree) === 1 ? (tree.files[0] ?? tree.folders[0]).name : null;
      record(only ? `Upload ${quote(only)}` : `Upload ${ids.length} items`, "upload", () => removeAll(ids), () => restoreAll(ids));
    } catch (e) {
      setError(userMessage(e));
      ctx.playSound("error");
    }
  };
  const addFolder = (name: string) => run(async () => {
    const free = freeName(name, names());
    const { id } = await ctx.api.call<{ id: number }>("add-folder", { channel_id: ctx.channel.id, parent_id: folder(), name: free });
    record(`New folder ${quote(free)}`, "folder-add", () => removeAll([id]), () => restoreAll([id]));
    setNaming(false);
  });
  // The editor over this view; the entry is copied, as the listing's objects change in place.
  const [editing, setEditing] = createSignal<Entry | null>(null);
  const edit = (entry: Entry) => {
    if (!entry.url) return;
    const snapshot = { ...entry };
    void getAndOpen(workspaceId, markOf(entry), entry.url, () => setEditing(snapshot));
  };
  // An empty file of a type the editor handles (.txt, .md, .json, code...), opened for typing at once.
  const addFile = (name: string) => run(async () => {
    const free = freeName(name, names());
    const file = new File([""], free, { type: mimeOfName(free) });
    const [id] = await uploadTree(ctx.api, uploadPlace(), ctx.channel.id, folder(), fromPicked([file]), names());
    setNamingFile(false);
    if (id === undefined) return;
    record(`New file ${quote(free)}`, "add", () => removeAll([id]), () => restoreAll([id]));
    edit(await getEntry(ctx.api, id));
  });
  const rename = (entry: Entry, name: string) => run(async () => {
    // Copied now: the entry is a live object that will already carry the new name.
    const { id, name: old } = entry;
    if (name && name !== old) {
      const to = () => call("rename", { entry_id: id, name });
      await to();
      record(`Rename ${quote(old)}`, "rename", () => call("rename", { entry_id: id, name: old }), to);
    }
    setRenaming(null);
  });
  const move = (id: number, parentId: number | null) => run(async () => {
    const entry = listing.value.entries.find((e) => e.id === id);
    const from = entry?.parentId ?? folder();
    const to = () => call("move", { entry_id: id, parent_id: parentId });
    await to();
    record(`Move ${quote(entry?.name ?? "item")}`, "forward", () => call("move", { entry_id: id, parent_id: from }), to);
  });
  const remove = (entry: Entry) => run(async () => {
    await removeAll([entry.id]);
    record(`Delete ${quote(entry.name)}`, "delete", () => restoreAll([entry.id]), () => removeAll([entry.id]));
  });

  let root!: HTMLDivElement;
  const undoKeys = historyKeys(ctx.history, (e) => setError(userMessage(e)));
  const onKey = (e: KeyboardEvent) => (e.target === document.body || root.contains(e.target as Node)) && undoKeys(e);
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const workspaceId = ctx.workspace.id;
  const markOf = (entry: Entry): SyncMark => ({ kind: entry.kind === "folder" ? "folder" : "file", id: entry.id });
  // A ghost is fetched (and synced from then on) first.
  const open = (entry: Entry) => {
    if (entry.kind === "folder") return setFolder(entry.id);
    const url = entry.url;
    if (!url) return;
    const viewable = viewersFor(entry.name, entry.mime).length > 0;
    void getAndOpen(workspaceId, markOf(entry), url, () => {
      if (!viewable) return;
      const file = fileFromUrl(entry.name, entry.mime, entry.size, url);
      const actions = isVideo(entry) ? [{ label: "Start a watch party", icon: "watch-party", run: () => planParty(entry) }] : undefined;
      ctx.openFile(isEditable(entry) && ctx.can("edit_content") ? { ...file, edit: () => edit(entry), actions } : { ...file, actions });
    });
  };
  // A watch party of this folder's videos, starting with the one viewed; the list is copied, as entries change in place.
  const isVideo = (entry: Entry) => entry.kind === "file" && !!entry.url && (entry.mime || mimeOfName(entry.name)).startsWith("video/");
  const [party, setParty] = createSignal<{ from: number; videos: NewPartyItem[] } | null>(null);
  const [partyOpen, setPartyOpen] = createSignal(false);
  const planParty = (entry: Entry) => {
    setPartyOpen(true);
    setParty({
      from: entry.id,
      videos: listing.value.entries.filter((e) => e.parentId === entry.parentId && isVideo(e))
        .map((e) => ({ fileId: e.id, name: e.name, url: e.url!, mime: e.mime || mimeOfName(e.name), size: e.size })),
    });
  };
  // To a place the user picks on their computer; pointers are downloaded first. A move lets the app's copy go.
  const save = (entry: Entry, mode: SaveMode) =>
    run(() => startSave(ctx.api, workspaceId, ctx.channel.id, uploadPlace(), entry, mode));

  // A followed link: show the entry in its folder, and open it if it is a viewable file.
  const [focus, setFocus] = createSignal<number | null>(null);
  createEffect(() => {
    const id = focus();
    const entry = id === null ? undefined : listing.value.entries.find((e) => e.id === id);
    if (entry) entries.reveal(entry);
  });
  // The highlight of a followed link; a newer one restarts it.
  let focusEnd: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(focusEnd));
  createEffect(on(ctx.target, (target) => {
    if (target?.kind !== "file") return;
    void getEntry(ctx.api, Number(target.id)).then((entry) => {
      setFolder(entry.kind === "folder" ? entry.id : entry.parentId);
      setFocus(entry.id);
      clearTimeout(focusEnd);
      focusEnd = setTimeout(() => setFocus(null), 1600);
      if (entry.kind === "file") open(entry);
    }, () => setError("That file no longer exists."));
  }));

  // Own files going out: cancelling keeps the file (an upload to a node is held back until it is sent on again). Any
  // other own file no node is known to have can be sent on too (the nodes are asked then; one that has it says so).
  const uploadMenu = (entry: Entry): MenuEntry[] => {
    if (entry.kind !== "file" || entry.authorId !== ctx.users.me()) return [];
    const action = uploadAction(workspaceId, entry.url);
    if (action === "cancel") return [{ label: "Cancel upload", icon: "close", action: () => cancelSend(workspaceId, entry.url) }];
    if (action !== "resume" && !canUploadToNode(workspaceId, entry.url, entry.size)) return [];
    return [{ label: "Upload to the node", icon: "upload", action: () => uploadToNode(workspaceId, entry.url, entry.size) }];
  };
  // "Delete locally" hides
  // an entry, for every member (undo brings it back, and the nodes and this device keep its content). "Delete from
  // network" removes it: no undo step, and the nodes and every member's device let the content go, so the same
  // file uploaded again is a new upload. For your own uploads, or anyone's with "Manage workspace" (the workspace's
  // policy decides; a folder holding other members' files is refused with its reason, shown in the menu).
  const purgeMenu = (entry: Entry): MenuEntry[] => {
    if (entry.authorId !== ctx.users.me() && !ctx.can("manage_workspace")) return [];
    // Copied now: the entry is a live object.
    const { id, name, kind } = entry;
    const what = kind === "folder" ? `the folder "${name}" and everything in it` : `"${name}"`;
    return [{
      render: () => (
        <ConfirmItem label="Delete from network" confirmLabel="Delete from network"
          question={`Delete ${what} from the network? It is removed for everyone, from the nodes too, and can't be brought back.`}
          onConfirm={async () => {
            await call("purge", { entry_id: id });
            setError("");
          }} />
      ),
    }];
  };
  const entryMenu = (entry: Entry): MenuEntry[] => [
    { label: "Open", icon: entry.kind === "folder" ? "folder" : "file", disabled: entry.kind === "file" && !entry.url, action: () => open(entry) },
    ...(entry.kind === "folder" || entry.url ? [
      { label: "Save copy to computer...", icon: "download", action: () => void save(entry, "copy") },
      { label: "Move to computer...", icon: "folder-upload", action: () => void save(entry, "move") },
    ] : []),
    ...(contentSync(workspaceId) && (entry.kind === "folder" || entry.url) ? [
      isSynced(workspaceId, markOf(entry))
        ? { label: "Stop syncing", icon: "close", action: () => setSynced(workspaceId, markOf(entry), false) }
        : { label: entry.kind === "folder" ? "Sync folder" : "Keep on this device", icon: "download", action: () => setSynced(workspaceId, markOf(entry), true) },
    ] : []),
    ...uploadMenu(entry),
    ...(isEditable(entry) ? [{ label: "Edit", icon: "rename", disabled: !ctx.can("edit_content"), action: () => edit(entry) }] : []),
    { label: "Copy link", icon: "link", action: () => copyLink(ctx.linkTo({ kind: "file", id: entry.id })) },
    "separator",
    { label: "Rename", icon: "rename", action: () => setRenaming(entry.id) },
    { label: "Delete locally", icon: "delete", danger: true, action: () => void remove(entry) },
    ...purgeMenu(entry),
  ];

  // A folder or a breadcrumb accepts entries dragged onto it.
  const dropTarget = (parentId: () => number | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(entryType) && !(hasCodeFile(e.dataTransfer) && ctx.can("edit_content"))) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).classList.add("drop-target");
    },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-target"),
    onDrop: (e: DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove("drop-target");
      const code = readCodePayload(e.dataTransfer);
      if (code) {
        e.preventDefault();
        e.stopPropagation();
        void run(async () => {
          const id = await dropCodeFile(code, { workspaceId, channelId: ctx.channel.id, type: "files", parentId: parentId() }, e.shiftKey);
          record("Copy file", "add", () => removeAll([id]), () => restoreAll([id]));
        });
        return;
      }
      const id = Number(e.dataTransfer?.getData(entryType));
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      if (id !== parentId()) void move(id, parentId());
    },
  });

  // Read during the drop event: the browser forgets dropped folders after it.
  const drop = createFileDrop((data) => void fromDrop(data).then(upload, (err) => setError(userMessage(err))));

  return (
    <div class="view files" ref={root} {...drop.on}>
      <header class="view-header">
        <nav class="view-title files-path mw-scroll-fade-x" aria-label="Folder path" ref={crumbs}>
          <button class="files-crumb" classList={{ current: folder() === null }} onClick={() => setFolder(null)} {...dropTarget(() => null)}>
            <Icon name="channel-files" /> {ctx.channel.name}
          </button>
          <For each={listing.value.path}>
            {(p) => (
              <>
                <span class="files-crumb-sep">/</span>
                <button class="files-crumb mw-fade-in" classList={{ current: p.id === folder() }} onClick={() => setFolder(p.id)}
                  {...dropTarget(() => p.id)}>
                  {p.name}
                </button>
              </>
            )}
          </For>
        </nav>
        <div class="view-tools mw-box">
          <button class="icon-button" title="Up one folder" aria-label="Up one folder" disabled={folder() === null}
            onClick={() => setFolder(listing.value.path.at(-2)?.id ?? null)}>
            <Icon name="folder-up" />
          </button>
          <button class="mw-button" onClick={(e) => ctx.openContextMenu(e, [
            { label: "New folder", icon: "folder-add", action: () => setNaming(true) },
            { label: "New file", icon: "add", disabled: !ctx.can("edit_content"), action: () => setNamingFile(true) },
          ])}><Icon name="add" /> New</button>
          <button class="mw-button" onClick={(e) => ctx.openContextMenu(e, [
            { label: "Upload files", icon: "upload", action: () => picker.click() },
            { label: "Upload a folder", icon: "folder-upload", action: () => folderPicker.click() },
          ])}><Icon name="upload" /> Upload</button>
        </div>
        <div class="view-tools view-history mw-box">
          <HistoryControls history={ctx.history} onError={(e) => setError(userMessage(e))} />
        </div>
        <div class="view-tools mw-box" role="group" aria-label="Layout">
          <For each={["grid", "list"] as Layout[]}>
            {(l) => (
              <button class="icon-button" classList={{ on: layout() === l }} title={l === "grid" ? "Grid" : "List"} aria-pressed={layout() === l}
                onClick={() => { setLayout(l); saveLayout(l); }}>
                <Icon name={l === "grid" ? "view-grid" : "view-list"} />
              </button>
            )}
          </For>
        </div>
        <Show when={ctx.can("manage_nodes")}>
          <div class="view-tools mw-box">
            <button class="icon-button" classList={{ on: showHosting() }} title="Show hosting" aria-label="Show hosting" onClick={() => setShowHosting(!showHosting())}>
              <Icon name="server" />
            </button>
          </div>
        </Show>
                <input ref={picker} type="file" multiple hidden onChange={(e) => {
          void upload(fromPicked(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }} />
        <input ref={(el) => { folderPicker = el; el.webkitdirectory = true; }} type="file" multiple hidden onChange={(e) => {
          void upload(fromPicked(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }} />
      </header>

      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <Collapse open={naming()}>
        <NameForm active={naming()} initial="new-folder" label="Folder name" onSave={addFolder} onCancel={() => setNaming(false)} class="files-new-folder" />
      </Collapse>

      <Collapse open={namingFile()}>
        <Show when={namingFile()}><NewFileForm onSave={addFile} onCancel={() => setNamingFile(false)} class="files-new-folder" /></Show>
      </Collapse>

      <div class="files-scroll mw-scroll-fade" ref={scroller} {...dropTarget(() => folder())}>
        <Switch>
          <Match when={!listing.loaded}><Skeleton kind="grid" header={false} /></Match>
          <Match when={listing.value.entries.length === 0 && uploadsIn(uploadPlace()).length === 0 && savesIn(uploadPlace()).length === 0}>
            <p class="view-note files-empty mw-fade-in">This folder is empty. Drop files here or use upload.</p>
          </Match>
          <Match when={true}>
            <ul class="files-items" classList={{ grid: layout() === "grid", list: layout() === "list" }}>
              <For each={savesIn(uploadPlace())}>{(job) => <SaveItem job={job} workspaceId={workspaceId} />}</For>
              <For each={uploadsIn(uploadPlace())}>{(u) => <UploadItem upload={u} />}</For>
              <For each={entries.shown()}>
                {(entry) => (
                  <EntryItem context={ctx} entry={entry} renaming={renaming() === entry.id} focused={focus() === entry.id} showHosting={showHosting()}
                    onMenu={(ev) => ctx.openContextMenu(ev, entryMenu(entry))}
                    onOpen={() => open(entry)} onRename={() => setRenaming(entry.id)} onRenamed={(name) => rename(entry, name)}
                    onCancelRename={() => setRenaming(null)} onRemove={() => remove(entry)}
                    onSave={() => void save(entry, "copy")}
                    drop={entry.kind === "folder" ? dropTarget(() => entry.id) : undefined} />
                )}
              </For>
            </ul>
          </Match>
        </Switch>
        <div class="files-more" ref={bottom} aria-hidden="true" />
      </div>
      <Show when={editing()} keyed>{(entry) =>
        <div class="files-editor mw-fade-in"><TextEditPanel context={ctx} entry={entry} onClose={() => setEditing(null)} /></div>}</Show>
      <DropHint show={drop.over()} label="Drop to upload" />
      <Show when={party()} keyed>
        {(p) => <StartPartyDialog open={partyOpen()} workspaceId={workspaceId} videos={p.videos} from={p.from} onClose={() => setPartyOpen(false)} />}
      </Show>
    </div>
  );
}

// A card's status ("Uploading to the node 42%", "3 of 12: nobody online has it"), in its full-width meta line: in the
// size slot, which is made for "1.2 MB", it made a grid card's content wider than the card, so the name, the text and
// the bar ran out of it. A percentage at the end stays whole: a narrow card cuts the text before it.
function StatusLine(props: { label: string; done?: boolean }) {
  const cut = () => (props.label.endsWith("%") ? props.label.lastIndexOf(" ") : -1);
  return (
    <span class="files-meta files-status" title={props.label}>
      <Show when={props.done}><Icon name="check" /></Show>
      <span class="files-status-text">{cut() > 0 ? props.label.slice(0, cut()) : props.label}</span>
      <Show when={cut() > 0}><span>{props.label.slice(cut() + 1)}</span></Show>
    </span>
  );
}

// A file still being copied in: its progress, and cancel, which deletes what was copied.
function UploadItem(props: { upload: RunningUpload }) {
  const u = () => props.upload;
  return (
    <li class="files-item uploading mw-box mw-fade-in">
      <div class="files-open">
        <span class="files-thumb mw-box"><Icon name="upload" /></span>
        <span class="files-name">{u().name}</span>
        <span class="files-size">{formatBytes(u().size)}</span>
        <StatusLine label={`Uploading ${Math.floor(u().progress * 100)}%`} />
        <ProgressBar value={u().progress} label={`Uploading ${u().name}`} />
      </div>
      <div class="files-actions">
        <button class="icon-button" title="Cancel upload" aria-label={`Cancel uploading ${u().name}`} onClick={() => cancelUpload(u().id)}>
          <Icon name="close" />
        </button>
      </div>
    </li>
  );
}

// A file or folder being saved to the computer: files done, a bar by bytes (following the download of the file it
// is on), and cancel; then where it went.
function SaveItem(props: { job: SaveJob; workspaceId: string }) {
  const j = () => props.job;
  // How much of the current file is here: all of it once it arrived (being written now, or already on this device),
  // else what its download got so far. The download's own progress is cleared as it finishes, before the save
  // counts the file, so arrived content must count as whole or the bar would drop back for a moment.
  const current = () => {
    const url = j().currentUrl;
    if (!url) return 0;
    return j().currentSize * (isLocal(url) ? 1 : downloadProgress(props.workspaceId, url) ?? 0);
  };
  const value = () => (j().savedTo ? 1 : j().totalBytes ? Math.min(1, (j().bytes + current()) / j().totalBytes) : 0);
  const percent = () => `${Math.floor(value() * 100)}%`;
  // The file it is on is still coming from a member (or nobody online has it).
  const downloading = () => !j().savedTo && !!j().currentUrl && !isLocal(j().currentUrl);
  const status = () => {
    const job = j();
    const one = job.total === 1;
    if (job.savedTo) return "Saved";
    if (downloading()) {
      if (transferStatus(props.workspaceId, job.currentUrl) === "unavailable")
        return one ? "Nobody online has it" : `${job.done + 1} of ${job.total}: nobody online has it`;
      if (!one) return `Downloading ${job.done + 1} of ${job.total}`;
      return downloadProgress(props.workspaceId, job.currentUrl) === undefined ? "Downloading..." : `Downloading ${percent()}`;
    }
    return one ? `Saving ${percent()}` : `Saving ${job.done} of ${job.total || "?"}`;
  };
  const stopLabel = () => (downloading() ? "Cancel download" : "Stop saving");
  return (
    <li class="files-item uploading mw-box mw-fade-in">
      <div class="files-open">
        <span class="files-thumb mw-box"><Icon name={j().savedTo ? "check" : "download"} /></span>
        <span class="files-name">{j().name}</span>
        <span class="files-size">{j().savedTo ? "Saved" : formatBytes(j().totalBytes)}</span>
        <Show when={j().savedTo} fallback={<StatusLine label={status()} />}>
          <span class="files-meta" title={j().savedTo ?? undefined}>{j().savedTo}</span>
        </Show>
        <ProgressBar value={value()} label={`${downloading() ? "Downloading" : "Saving"} ${j().name}`} />
      </div>
      <Show when={!j().savedTo}>
        <div class="files-actions">
          <button class="icon-button" title={stopLabel()} aria-label={`${stopLabel()}: ${j().name}`} onClick={() => cancelSave(j().id)}>
            <Icon name="close" />
          </button>
        </div>
      </Show>
    </li>
  );
}

function EntryItem(props: {
  context: ChannelContext;
  entry: Entry;
  renaming: boolean;
  onOpen: () => void;
  onRename: () => void;
  onRenamed: (name: string) => unknown;
  onCancelRename: () => void;
  onRemove: () => void;
  onSave: () => void;
  onMenu: (e: MouseEvent) => void;
  focused: boolean;
  showHosting: boolean;
  drop?: Record<string, (e: DragEvent) => void>;
}) {
  const e = () => props.entry;
  const [confirming, setConfirming] = createSignal(false);
  const isImage = () => e().mime.startsWith("image/");
  const workspaceId = props.context.workspace.id;
  // A ghost: the content isn't on this device, only its details (and a preview for images).
  const ghost = () => e().kind === "file" && !isLocal(e().url);
  const preview = () => contentUrl(e().url) ?? e().thumb;
  const openable = () => e().kind === "folder" || !!e().url;
  // Synced, and for a file all of it is here: opening or saving a ghost turns its mark on before anything arrived, and
  // the mark stays while a download fails or nobody online has it.
  const synced = () => isSynced(workspaceId, { kind: e().kind === "folder" ? "folder" : "file", id: e().id }) && !ghost();
  const transfer = () => transferLabel(workspaceId, e().url);
  const bar = () => (e().kind === "file" ? transferBar(workspaceId, e().url) : undefined);
  // A running download can be cancelled, and so can what goes out of the user's own files: a send to a member, or the
  // upload to a node (running or waiting its turn), which is then held back until they send it on. Cancelling removes
  // nothing: the file stays, here and in the workspace.
  const mine = () => e().authorId === props.context.users.me();
  const downloading = () => transferKind(workspaceId, e().url) === "downloading";
  const going = () => (e().kind === "file" && mine() && !downloading() ? uploadAction(workspaceId, e().url) : undefined);
  // Content is moving now: the card's buttons stay in view.
  const transferring = () => downloading() || (mine() && transferKind(workspaceId, e().url) === "sending");
  const author = () => props.context.users.get(e().authorId).displayName;

  return (
    <li class="files-item mw-box mw-fade-in"
      classList={{ folder: e().kind === "folder", ghost: ghost(), flash: props.focused, transferring: transferring() }}
      onContextMenu={props.onMenu}
      ref={(el) => createEffect(() => props.focused && requestAnimationFrame(() => el.scrollIntoView({ block: "nearest", behavior: "smooth" })))}
      draggable={!props.renaming} onDragStart={(ev) => {
        ev.dataTransfer?.setData(entryType, String(e().id));
        ev.dataTransfer?.setData("text/plain", props.context.linkTo({ kind: "file", id: e().id }));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      }}
      {...props.drop}>
      <button class="files-open" aria-disabled={!openable()} onClick={() => openable() && props.onOpen()}
        title={!e().url && e().kind === "file" ? `${e().name}: sent without its content`
          : ghost() ? `${e().name}: not on this device, open to download and keep it` : `Open ${e().name}`}>
        <span class="files-thumb mw-box">
          <Show when={isImage() && preview()} fallback={<Icon name={e().kind === "folder" ? "folder" : isImage() ? "image" : "file"} />}>
            {(src) => <img src={src()} alt="" loading="lazy" draggable={false} />}
          </Show>
          <Show when={synced()}><span class="files-synced" title="Synced to this device"><Icon name="check" /></span></Show>
        </span>
        <Show when={!props.renaming}>
          <span class="files-name">{e().name}</span>
        </Show>
        <span class="files-size">{e().kind === "folder" ? "Folder" : formatBytes(e().size)}</span>
        <Show when={transfer()} fallback={
          <span class="files-meta" title={new Date(e().createdAt).toLocaleString()}>{author()}, {relativeTime(e().createdAt)}</span>
        }>
          <StatusLine label={transfer() ?? ""} done={bar()?.done} />
        </Show>
      <Show when={props.context.hosting && props.showHosting && e().url}>
        {(() => {
          const h = props.context.hosting!(e().url!, e().kind === "file" ? e().size : null);
          if (!h) return <></>;
          const nodes = h.nodes.filter((n: HostingNode) => n.shouldHold || h.striped);
          if (nodes.length === 0) return <></>;
          return (
            <div class="files-hosting">
              {nodes.slice(0, 3).map((n: HostingNode) => (
                <span class={`hosting-badge ${n.status}`} title={`${n.name}${n.city ? ", " + n.city : ""} - ${n.status}`}>
                  {n.name.slice(0, 8)}{n.city ? "·" + n.city.slice(0, 4) : ""}
                </span>
              ))}
              {nodes.length > 3 && <span class="hosting-more">+{nodes.length - 3}</span>}
              {h.striped && h.piecesTotal && <span class="hosting-pieces">{h.piecesTotal}{h.parity ? `+${h.parity}` : ""}p</span>}
            </div>
          );
        })()}
      </Show>
        <TransferProgress bar={bar()} />
      </button>
      <Show when={props.renaming}>
        <NameForm active initial={e().name} label="New name" onSave={props.onRenamed} onCancel={props.onCancelRename} class="files-rename" />
      </Show>
      <div class="files-actions">
        <Show when={downloading()}>
          <button class="icon-button" title="Cancel download" aria-label={`Cancel downloading ${e().name}`}
            onClick={() => void cancelDownload(workspaceId, { kind: "file", id: e().id }, e().url)}>
            <Icon name="close" />
          </button>
        </Show>
        <Show when={going() === "cancel"}>
          <button class="icon-button" title="Cancel upload" aria-label={`Cancel uploading ${e().name}`} onClick={() => cancelSend(workspaceId, e().url)}>
            <Icon name="close" />
          </button>
        </Show>
        <Show when={going() === "resume"}>
          <button class="icon-button" title="Upload to the node" aria-label={`Upload ${e().name} to the node`}
            onClick={() => uploadToNode(workspaceId, e().url, e().size)}>
            <Icon name="upload" />
          </button>
        </Show>
        <Show when={e().kind === "folder" || e().url}>
          <button class="icon-button" title="Save copy to computer" aria-label={`Save ${e().name} to computer`} onClick={props.onSave}>
            <Icon name="download" />
          </button>
        </Show>
        <button class="icon-button" title="Rename" aria-label="Rename" onClick={props.onRename}><Icon name="rename" /></button>
        <button class="icon-button" classList={{ confirming: confirming() }} title="Delete locally" aria-label="Delete locally"
          aria-expanded={confirming()} onClick={() => setConfirming(!confirming())}>
          <Icon name="delete" />
        </button>
      </div>
      <div class="files-confirm">
        <ConfirmPrompt open={confirming()}
          question={`Are you sure you want to delete ${e().kind === "folder" ? "the folder " : ""}"${e().name}" locally?`}
          confirmLabel="Delete locally" onConfirm={props.onRemove} onCancel={() => setConfirming(false)} />
      </div>
    </li>
  );
}

// Enter saves; clicking away saves a changed name; Escape cancels.
function NameForm(props: {
  active: boolean; initial: string; label: string; class: string; onSave: (name: string) => unknown; onCancel: () => void;
}) {
  let input!: HTMLInputElement;
  // Closing the form blurs the input, so each opening finishes once.
  let done = false;
  const finish = (save: boolean) => {
    if (done || !props.active) return;
    done = true;
    const name = input.value.trim();
    if (!save || !name) return props.onCancel();
    // If saving fails (a taken name, say) the form stays open for another try.
    void Promise.resolve(props.onSave(name)).finally(() => (done = false));
  };
  createEffect(() => {
    if (!props.active) return;
    done = false;
    input.value = props.initial;
    requestAnimationFrame(() => {
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
  });
  return (
    <form class={props.class} onSubmit={(ev) => { ev.preventDefault(); finish(true); }}>
      <input ref={input} class="mw-input mw-box view-input" aria-label={props.label} required
        onKeyDown={(ev) => ev.key === "Escape" && (ev.stopPropagation(), finish(false))}
        onBlur={() => finish(input.value.trim() !== props.initial)} />
    </form>
  );
}
