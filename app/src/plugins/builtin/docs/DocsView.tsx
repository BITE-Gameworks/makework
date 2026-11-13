import { For, Index, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { userMessage } from "../../../api/client";
import { historyKeys } from "../../../core/history";
import { copyLink } from "../../../core/links";
import { relativeTime } from "../../../core/time";
import Markdown from "../../../markdown/Markdown";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import { DropHint, createFileDrop } from "../../../ui/FileDrop";
import HistoryControls from "../../../ui/HistoryControls";
import { PaneButton, createPanes } from "../../../ui/narrowPanes";
import ResizeHandle from "../../../ui/ResizeHandle";
import { solidMount } from "../../solid";
import type { ChannelContext, MenuEntry } from "../../types";
import { fromDrop, fromPicked, type UploadTree } from "../files/folders";
import ExportPanel from "./ExportPanel";
import { entriesOf, expandZips, importPages, importTree, pageCount, saveExport } from "./transfer";
import {
  addPage, allBodies, createPages, movePage, removePages, restorePages, updatePage, type DocPage,
} from "./data";
import { openPageText, type PageText } from "./collab";
import LiveEditor from "./LiveEditor";
import { decodeEmoji } from "../../../markdown/emoji";
import { setSynced } from "../../../core/content";
import { editorWidth, lastOpen, mode, rememberOpen, saveEditorWidth, saveTreeWidth, setEditorWidth, setMode, setTreeWidth, treeWidth, type DocsMode } from "./panels";
import { createTreeStop, treeKeys, treeRow, treeRowOf } from "../../../ui/treeKeys";
import "../views.css";
import "./docs.css";

type Drop = { id: number; where: "above" | "below" | "inside" };
const modes: { id: DocsMode; icon: string; label: string }[] = [
  { id: "preview", icon: "docs-preview", label: "Preview" },
  { id: "edit", icon: "docs-edit", label: "Edit" },
  { id: "split", icon: "docs-split", label: "Edit and preview side by side" },
];

// A tree of markdown pages: the tree on the left, the open page on the right in preview, edit or both.
export default function DocsView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const api = ctx.api;
  // Pages show their images, so opening a docs channel keeps its content on this device.
  setSynced(ctx.workspace.id, { kind: "channel", id: ctx.channel.id }, true);
  const place = `${ctx.workspace.id}:${ctx.channel.id}`;
  const pages = createPages(api, ctx.channel.id);
  const [openId, setOpenId] = createSignal<number | null>(lastOpen(place));
  // Narrow: the page tree opens over the page and closes once a page is picked.
  const panes = createPanes<"pages">();
  createEffect(on(openId, () => panes.close(), { defer: true }));
  const [collapsed, setCollapsed] = createSignal<Set<number>>(new Set());
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [drop, setDrop] = createSignal<Drop | null>(null);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const canEdit = () => ctx.can("edit_content");

  const byId = createMemo(() => new Map(pages.value.map((p) => [p.id, p])));
  const children = createMemo(() => {
    const map = new Map<number | null, DocPage[]>();
    for (const p of pages.value) {
      const parent = p.parentId !== null && byId().has(p.parentId) ? p.parentId : p.parentId === null ? null : undefined;
      if (parent === undefined) continue;
      map.set(parent, [...(map.get(parent) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.z - b.z || a.id - b.id);
    return map;
  });
  const kids = (id: number | null) => children().get(id) ?? [];
  const descendants = (id: number): number[] => kids(id).flatMap((c) => [c.id, ...descendants(c.id)]);
  const ancestors = (id: number): number[] => {
    const list: number[] = [];
    for (let p = byId().get(id)?.parentId ?? null; p !== null; p = byId().get(p)?.parentId ?? null) list.push(p);
    return list;
  };
  const rows = createMemo(() => {
    const out: { page: DocPage; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const p of kids(parent)) {
        out.push({ page: p, depth });
        if (!collapsed().has(p.id)) walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  });
  const open = () => (openId() !== null ? byId().get(openId()!) : undefined);
  const toggleCollapsed = (id: number) => {
    const next = new Set(collapsed());
    next.has(id) ? next.delete(id) : next.add(id);
    setCollapsed(next);
  };
  const treeStop = createTreeStop(() => rows().map((row) => row.page.id), openId);

  // Opens the first page when nothing (or a deleted page) was open. A page made here counts as there until the
  // list catches up with it.
  const made = new Set<number>();
  createEffect(() => {
    if (!pages.loaded) return;
    const id = openId();
    if (id !== null && byId().has(id)) made.delete(id);
    else if (id === null || !made.has(id)) select(kids(null)[0]?.id ?? null);
  });

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError("");
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : userMessage(e));
    }
  };

  // The open page's text, shared live with everyone who has it open.
  const [page, setPage] = createSignal<PageText | null>(null);
  let editorEl: HTMLTextAreaElement | undefined;
  createEffect(on(openId, (id) => {
    const previous = page();
    if (previous) void previous.close();
    setPage(id === null ? null : openPageText(api, id, async () => {
      const { page: row } = await api.call<{ page: Record<string, unknown> }>("get-page", { page_id: id });
      return decodeEmoji(String(row.body ?? ""));
    }, { caretOf: () => editorEl, onError: (e) => setError(userMessage(e)) }));
  }));
  onCleanup(() => void page()?.close());
  const shownText = () => page()?.text() ?? "";

  const select = (id: number | null) => {
    if (id === openId()) return;
    setOpenId(id);
    rememberOpen(place, id);
    if (id !== null && ancestors(id).some((a) => collapsed().has(a)))
      setCollapsed(new Set([...collapsed()].filter((c) => !ancestors(id).includes(c))));
  };

  // A followed link opens its page.
  let handled: unknown = null;
  createEffect(() => {
    const target = ctx.target();
    if (target?.kind !== "page" || target === handled || !pages.loaded) return;
    handled = target;
    if (byId().has(Number(target.id))) select(Number(target.id));
    else setError("That page is no longer here.");
  });

  const add = (parentId: number | null) => run(async () => {
    const id = await addPage(api, ctx.channel.id, parentId, "Untitled");
    made.add(id);
    ctx.history.push({ label: "Add page", icon: "add", undo: () => removePages(api, [id]), redo: () => restorePages(api, [id]) });
    if (parentId !== null) setCollapsed(new Set([...collapsed()].filter((c) => c !== parentId)));
    select(id);
    setRenaming(id);
  });

  const rename = (id: number, title: string) => {
    setRenaming(null);
    const old = byId().get(id)?.title;
    const next = title.trim();
    if (!next || next === old || old === undefined) return;
    void run(() => updatePage(api, id, { title: next }));
    ctx.history.push({ label: "Rename page", icon: "rename", undo: () => updatePage(api, id, { title: old }), redo: () => updatePage(api, id, { title: next }) });
  };

  const remove = (id: number) => {
    const all = [id, ...descendants(id)];
    if (all.includes(openId() ?? -1)) select(null);
    void run(() => removePages(api, all));
    ctx.history.push({ label: all.length > 1 ? `Delete ${all.length} pages` : "Delete page", icon: "delete",
      undo: () => restorePages(api, all), redo: () => removePages(api, all) });
  };

  const move = (d: Drop, id: number) => {
    const target = byId().get(d.id)!;
    const parentId = d.where === "inside" ? d.id : target.parentId;
    const siblings = kids(parentId).filter((p) => p.id !== id);
    let z: number;
    if (d.where === "inside") z = (siblings.at(-1)?.z ?? 0) + 1;
    else {
      const i = siblings.findIndex((p) => p.id === d.id);
      const [below, above] = d.where === "above" ? [siblings[i - 1]?.z, target.z] : [target.z, siblings[i + 1]?.z];
      z = below === undefined ? above! - 1 : above === undefined ? below + 1 : (below + above) / 2;
    }
    const page = byId().get(id)!;
    const old = { parentId: page.parentId, z: page.z };
    void run(() => movePage(api, id, parentId, z));
    ctx.history.push({ label: "Move page", icon: "forward", undo: () => movePage(api, id, old.parentId, old.z), redo: () => movePage(api, id, parentId, z) });
    if (d.where === "inside") setCollapsed(new Set([...collapsed()].filter((c) => c !== d.id)));
  };

  // Exports (transfer.ts): the chosen pages as .md files, sub-pages in folders, images in _assets/.
  const exportPages = async (ids: Set<number>) => {
    const missing = await saveExport(pages.value, await allBodies(api, ctx.channel.id), ids, ctx.channel.name);
    return missing ? `${missing === 1 ? "1 image wasn't" : `${missing} images weren't`} on this device yet, so ${missing === 1 ? "it was" : "they were"} left out.` : "";
  };
  const exportPage = (id: number) => run(async () => {
    const note = await exportPages(new Set([id]));
    if (note) setNotice(note);
  });
  // Every page in tree order, whatever is collapsed, for the export list.
  const allRows = createMemo(() => {
    const out: { page: DocPage; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => kids(parent).forEach((p) => { out.push({ page: p, depth }); walk(p.id, depth + 1); });
    walk(null, 0);
    return out;
  });
  const exportPanel = "docs-export";
  const toggleExport = () => {
    const id = openId();
    const initial = id !== null && byId().has(id) ? [id, ...descendants(id)] : pages.value.map((p) => p.id);
    ctx.toggleSidePanel(exportPanel, "Export pages", solidMount(() => (
      <ExportPanel rows={allRows} descendants={descendants} initial={initial} onExport={exportPages} />
    )));
  };

  // Notes like "Imported 12 pages." go away after a while.
  createEffect(on(notice, (text) => {
    if (!text) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    onCleanup(() => clearTimeout(timer));
  }));

  // Imports (transfer.ts): every .md file in what was picked or dropped becomes a page, under `parent`.
  const [importing, setImporting] = createSignal<string | null>(null);
  const importFiles = (tree: UploadTree, parent: number | null) => run(async () => {
    setNotice("");
    const entries = await expandZips(entriesOf(tree));
    const plan = importTree(entries);
    const total = pageCount(plan);
    if (!total) return setNotice("No .md files found there.");
    setImporting(`Importing 0 of ${total} pages...`);
    try {
      const ids = await importPages(api, ctx.channel.id, parent, entries, plan, (n) => setImporting(`Importing ${n} of ${total} pages...`));
      ids.forEach((id) => made.add(id));
      ctx.history.push({ label: total === 1 ? "Import page" : `Import ${total} pages`, icon: "upload",
        undo: () => removePages(api, ids), redo: () => restorePages(api, ids) });
      if (parent !== null) setCollapsed(new Set([...collapsed()].filter((c) => c !== parent)));
      select(ids[0]);
      setNotice(total === 1 ? "Imported 1 page." : `Imported ${total} pages.`);
    } finally {
      setImporting(null);
    }
  });
  let filePicker!: HTMLInputElement;
  let folderPicker!: HTMLInputElement;
  let importParent: number | null = null;
  const pickImport = (parent: number | null, folder: boolean) => {
    importParent = parent;
    (folder ? folderPicker : filePicker).click();
  };
  const importItems = (parent: number | null): MenuEntry[] => [
    { label: "Import files...", icon: "upload", action: () => pickImport(parent, false) },
    { label: "Import a folder...", icon: "folder-upload", action: () => pickImport(parent, true) },
  ];
  const fileDrop = createFileDrop((data) => {
    if (!canEdit()) return;
    void fromDrop(data).then((tree) => importFiles(tree, null), (err) => setError(userMessage(err)));
  });

  const pageMenu = (e: MouseEvent, p: DocPage) => {
    select(p.id);
    ctx.openContextMenu(e, [
      { label: "Add sub-page", icon: "add", disabled: !canEdit(), action: () => void add(p.id) },
      { label: "Rename", icon: "rename", disabled: !canEdit(), action: () => setRenaming(p.id) },
      { label: "Copy link", icon: "link", action: () => copyLink(ctx.linkTo({ kind: "page", id: p.id })) },
      { label: "Export as .md", icon: "download", action: () => void exportPage(p.id) },
      { label: "Import into this page", icon: "upload", disabled: !canEdit(), items: importItems(p.id) },
      "separator",
      { label: kids(p.id).length ? "Delete with sub-pages" : "Delete", icon: "delete", danger: true, disabled: !canEdit(), action: () => remove(p.id) },
    ] as MenuEntry[]);
  };

  const dropAt = (e: DragEvent, id: number, dragged: number): Drop | null => {
    if (id === dragged || ancestors(id).includes(dragged)) return null;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    return { id, where: f < 0.3 ? "above" : f > 0.7 ? "below" : "inside" };
  };
  let dragged: number | null = null;

  const undoKeys = historyKeys(ctx.history, (e) => setError(userMessage(e)));
  return (
    <div class="view docs" role="presentation" onKeyDown={(e) => !(e.target as HTMLElement).closest("textarea, input") && undoKeys(e)}>
      <header class="view-header">
        <div class="docs-heading">
          {/* Narrow: the page list opens from beside the page's name. */}
          <PaneButton panes={panes} pane="pages" icon="view-list" label="Pages" />
          <Show when={open()}>
            {(p) => (
              <>
                <input class="docs-title" value={p().title} aria-label="Page title" disabled={!canEdit()}
                  onChange={(e) => rename(p().id, e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
                <span class="docs-meta">
                  {page()?.saving() ? "Saving..." : `Edited ${relativeTime(p().updatedAt)} by ${ctx.users.get(p().updatedBy).displayName}`}
                </span>
              </>
            )}
          </Show>
        </div>
        <div class="view-tools mw-box" role="group" aria-label="Mode">
          <For each={modes}>
            {(m) => (
              <button class="icon-button" classList={{ on: mode() === m.id }} title={m.label} aria-label={m.label}
                aria-pressed={mode() === m.id} disabled={m.id !== "preview" && !canEdit()} onClick={() => setMode(m.id)}>
                <Icon name={m.icon} />
              </button>
            )}
          </For>
        </div>
        <div class="view-tools view-history mw-box">
          <HistoryControls history={ctx.history} onError={(e) => setError(userMessage(e))} />
        </div>
        <div class="view-tools mw-box">
          <button class="icon-button" title="Add page" aria-label="Add page" disabled={!canEdit()} onClick={() => void add(null)}>
            <Icon name="add" />
          </button>
          <button class="icon-button" title="Import .md files, folders or a .zip" aria-label="Import" disabled={!canEdit() || importing() !== null}
            onClick={(e) => ctx.openContextMenu(e, importItems(null))}>
            <Icon name="upload" />
          </button>
          <button class="icon-button" classList={{ on: ctx.isSidePanelOpen(exportPanel) }} title="Export pages" aria-label="Export pages"
            aria-pressed={ctx.isSidePanelOpen(exportPanel)} disabled={pages.value.length === 0} onClick={toggleExport}>
            <Icon name="download" />
          </button>
        </div>
        <input ref={filePicker} type="file" multiple hidden accept=".md,.markdown,.zip,image/*" onChange={(e) => {
          void importFiles(fromPicked(e.currentTarget.files ?? []), importParent);
          e.currentTarget.value = "";
        }} />
        <input ref={(el) => { folderPicker = el; el.webkitdirectory = true; }} type="file" multiple hidden onChange={(e) => {
          void importFiles(fromPicked(e.currentTarget.files ?? []), importParent);
          e.currentTarget.value = "";
        }} />
      </header>
      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <Collapse open={!!(importing() ?? notice())}><p class="view-note">{importing() ?? notice()}</p></Collapse>
      <div class="docs-body" {...fileDrop.on}>
        <DropHint show={fileDrop.over() && canEdit()} label="Drop .md files, folders or a .zip to import them" />
        <div class="docs-side" classList={panes.classes("pages", "left")} style={{ width: treeWidth() ? `${treeWidth()}px` : undefined }}>
          <div class="docs-tree mw-scroll-fade" role="tree" aria-label="Pages">
            {/* By place, not by row object: the rows are built anew on every change, and a row drawn again would
                lose the keyboard's focus. */}
            <Index each={rows()} fallback={<p class="docs-hint">{pages.loaded ? "No pages yet." : ""}</p>}>
              {(row) => {
                const p = () => row().page;
                const has = () => kids(p().id).length > 0;
                return (
                  <div class="docs-row" classList={{
                    open: openId() === p().id,
                    "drop-above": drop()?.id === p().id && drop()?.where === "above",
                    "drop-below": drop()?.id === p().id && drop()?.where === "below",
                    "drop-inside": drop()?.id === p().id && drop()?.where === "inside",
                  }}
                    role="treeitem" aria-level={row().depth + 1} aria-selected={openId() === p().id}
                    aria-expanded={has() ? !collapsed().has(p().id) : undefined}
                    tabIndex={treeStop.tabIndex(p().id)} ref={treeRow} onFocus={() => treeStop.focused(p().id)}
                    onKeyDown={treeKeys({
                      activate: () => select(p().id), toggle: () => toggleCollapsed(p().id),
                      rename: () => canEdit() && setRenaming(p().id),
                    })}
                    style={{ "--depth": row().depth }} draggable={canEdit() && renaming() !== p().id}
                    onClick={() => select(p().id)} onDblClick={() => canEdit() && setRenaming(p().id)}
                    onContextMenu={(e) => pageMenu(e, p())}
                    onDragStart={(e) => {
                      dragged = p().id;
                      e.dataTransfer!.effectAllowed = "move";
                      e.dataTransfer!.setData("application/x-makework-page", String(p().id));
                    }}
                    onDragEnd={() => { dragged = null; setDrop(null); }}
                    onDragOver={(e) => {
                      if (dragged === null) return;
                      const d = dropAt(e, p().id, dragged);
                      setDrop(d);
                      if (d) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const d = drop();
                      setDrop(null);
                      if (d && dragged !== null) move(d, dragged);
                    }}>
                    <button class="docs-toggle" classList={{ empty: !has(), expanded: !collapsed().has(p().id) }} tabIndex={-1}
                      aria-label={collapsed().has(p().id) ? "Expand" : "Collapse"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(p().id);
                      }}>
                      <Icon name="collapsed" size={12} />
                    </button>
                    <Icon name="docs-page" size={14} />
                    <Show when={renaming() === p().id} fallback={<span class="docs-row-title">{p().title}</span>}>
                      <input class="docs-rename" value={p().title} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
                        onClick={(e) => e.stopPropagation()} onBlur={(e) => rename(p().id, e.currentTarget.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key !== "Enter" && e.key !== "Escape") return;
                          // Back to the row once the field is gone, so the keys go on in the tree.
                          const treeItem = treeRowOf(e.currentTarget);
                          if (e.key === "Enter") e.currentTarget.blur();
                          else setRenaming(null);
                          treeItem?.focus();
                        }} />
                    </Show>
                    <Show when={canEdit()}>
                      <button class="icon-button docs-row-add" title="Add sub-page" aria-label="Add sub-page"
                        onClick={(e) => { e.stopPropagation(); void add(p().id); }}>
                        <Icon name="add" size={14} />
                      </button>
                    </Show>
                  </div>
                );
              }}
            </Index>
          </div>
          <ResizeHandle edge="right" label="Resize pages" setWidth={setTreeWidth} save={saveTreeWidth} />
        </div>

        <main class="docs-page">
          <Show when={open()} fallback={
            <div class="docs-empty mw-fade-in">
              <p>{pages.loaded && pages.value.length === 0 ? "No pages yet." : "Pick a page."}</p>
              <Show when={pages.loaded && pages.value.length === 0 && canEdit()}>
                <button class="mw-button primary mw-box" onClick={() => void add(null)}><Icon name="add" /> Add the first page</button>
              </Show>
            </div>
          }>
            <div class="docs-content" classList={{ split: mode() === "split" && canEdit() }}>
              <Show when={mode() !== "preview" && canEdit() && page()} keyed>
                {(p) => (
                  <div class="docs-editor-pane" style={mode() === "split" && canEdit() && editorWidth() ? { width: `${editorWidth()}px` } : undefined}>
                    <LiveEditor context={ctx} page={p} disabled={!canEdit()} onError={(e) => setError(userMessage(e))} ref={(el) => (editorEl = el)} />
                    <Show when={mode() === "split" && canEdit()}>
                      <ResizeHandle edge="right" label="Resize editor" setWidth={setEditorWidth} save={saveEditorWidth} />
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={mode() !== "edit" || !canEdit()}>
                <div class="docs-preview mw-scroll-fade">
                  <Show when={shownText().trim()} fallback={<p class="docs-hint">{page()?.loaded() ? `This page is empty.${canEdit() ? " Switch to Edit to write it." : ""}` : ""}</p>}>
                    <Markdown source={shownText()} workspaceId={ctx.workspace.id} />
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </main>
      </div>
    </div>
  );
}
