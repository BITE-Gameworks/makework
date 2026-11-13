import { For, Index, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import * as Y from "yjs";
import { userMessage } from "../../../api/client";
import { contentBlob, refHash } from "../../../core/content";
import { desktop, desktopError } from "../../../core/desktop";
import { safeName } from "../../../core/fileNames";
import { prepareUpload } from "../../../core/files";
import { historyKeys } from "../../../core/history";
import { copyLink } from "../../../core/links";
import { fromBase64, openLiveText, toBase64 } from "../../../core/liveText";
import { ConfirmItem, RenameItem } from "../../../shell/channelMenu";
import { Icon } from "../../../theme/icons";
import Avatar from "../../../ui/Avatar";
import { DropHint, createFileDrop } from "../../../ui/FileDrop";
import HistoryControls from "../../../ui/HistoryControls";
import { PaneButton, createPanes } from "../../../ui/narrowPanes";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import ResizeHandle from "../../../ui/ResizeHandle";
import Select from "../../../ui/Select";
import Skeleton from "../../../ui/Skeleton";
import { solidMount } from "../../solid";
import type { ChannelContext, MenuEntry } from "../../types";
import { entriesOf, expandZips } from "../docs/transfer";
import { codeFileType, dropCodeFile, hasCodeFile, readCodePayload } from "../codeDrag";
import NewFileForm from "../NewFileForm";
import Collapse from "../../../ui/Collapse";
import { fromDrop, fromPicked } from "../files/folders";
import { addFile, addFolder, createFiles, isTextBlob, moveFile, removeFiles, renameFile, restoreFiles, setLanguage, type CodeFile } from "./data";
import { suggest } from "./ai";
import { attachServer, createEditor, languageOf, languages, problemsOf, setInlineSource, setOpener, type CodeEditor, type Problem } from "./editor";
import FindPanel, { type Hit } from "./FindPanel";
import { fileUri, startLsp, type LspDiagnostic, type LspSession } from "./lsp";
import ProblemsPanel from "./ProblemsPanel";
import RunPanel from "./RunPanel";
import { approve, createRuns, fileCommand, isApproved, lastRun, rememberRun, type RunConfig } from "./runs";
import { codeSetting, serverFor, serverLanguages } from "./settings";
import TerminalPanel from "./TerminalPanel";
import { openTerminal, panelShown, showPanel, terminals } from "./terminals";
import { rememberedOpen, rememberOpen, saveTreeWidth, setTreeWidth, treeWidth } from "./panels";
import { importFiles } from "./transfer";
import { createTreeStop, treeKeys, treeRow, treeRowOf } from "../../../ui/treeKeys";
import TabClose from "./TabClose";
import "../views.css";
import "./code.css";

type OpenText = ReturnType<typeof openLiveText>;
type Drop = { id: number | null; inside: boolean };
const textLimit = 1024 * 1024;
// The same file seen from the editor and from a language server: their file:// addresses can differ in encoding and case.
const uriKey = (uri: string) => decodeURIComponent(uri.replace(/^file:\/+/, "")).replaceAll("\\", "/").toLowerCase();
const lspLanguage = (language: string) => (language === "shell" ? "shellscript" : language);
const sortFiles = (a: CodeFile, b: CodeFile) =>
  a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1;

export default function CodeView(props: { context: ChannelContext }) {
  const ctx = props.context;
  const api = ctx.api;
  const files = createFiles(api, ctx.channel.id);
  const place = `${ctx.workspace.id}:${ctx.channel.id}`;
  const [open, setOpen] = createSignal<number[]>(rememberedOpen(place));
  const [active, setActive] = createSignal<number | null>(open().at(-1) ?? null);
  // Narrow: the explorer opens over the editor and closes once a file is opened.
  const panes = createPanes<"explorer">();
  createEffect(on(active, () => panes.close(), { defer: true }));
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [editorReady, setEditorReady] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [unsupported, setUnsupported] = createSignal(false);
  const [position, setPosition] = createSignal({ line: 1, column: 1 });
  const [collapsed, setCollapsed] = createSignal<Set<number>>(new Set());
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [drop, setDrop] = createSignal<Drop | null>(null);
  const [importing, setImporting] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0);
  // Where the new-file form is shown: a folder id, null for the root, undefined while closed.
  const [newFileIn, setNewFileIn] = createSignal<number | null | undefined>(undefined);
  const [dirty, setDirty] = createStore<Record<number, boolean>>({});
  const canEdit = () => ctx.can("edit_content");
  const fail = (e: unknown) => setError(userMessage(e));
  // Desktop only: the channel's run folder, language servers, Run and terminals.
  const tools = !!desktop?.code;
  const runs = createRuns(api, ctx.channel.id);
  const [folder, setFolder] = createSignal<string | null>(null);
  const [lspNote, setLspNote] = createSignal("");
  const [lspInstall, setLspInstall] = createSignal<{ serverId: string; from: string; busy: boolean } | null>(null);
  const [ownProblems, setOwnProblems] = createSignal<Problem[]>([]);
  const [lspProblems, setLspProblems] = createStore<Record<string, Problem[]>>({});
  const [confirming, setConfirming] = createSignal<RunConfig | null>(null);

  const byId = createMemo(() => new Map(files.value.map((file) => [file.id, file])));
  const children = createMemo(() => {
    const map = new Map<number | null, CodeFile[]>();
    for (const file of files.value) (map.get(file.parentId) ?? map.set(file.parentId, []).get(file.parentId)!).push(file);
    for (const list of map.values()) list.sort(sortFiles);
    return map;
  });
  const ancestors = (id: number) => {
    const result: number[] = [];
    for (let at = byId().get(id)?.parentId; at != null && !result.includes(at); at = byId().get(at)?.parentId) result.push(at);
    return result;
  };
  const pathOf = (file: CodeFile) => [...ancestors(file.id).reverse().map((id) => byId().get(id)?.name ?? ""), file.name].join("/");
  // Where a file is in the run folder (electron/codeTools.js writes each name through the same safeName).
  const segmentsOf = (file: CodeFile) => [...ancestors(file.id).reverse().map((id) => byId().get(id)?.name ?? ""), file.name].map(safeName);
  const uriFor = (file: CodeFile) => (folder() ? fileUri(`${folder()}/${segmentsOf(file).join("/")}`) : undefined);
  const fileByUri = createMemo(() => new Map(folder() ? files.value.filter((f) => f.kind === "file").map((f) => [uriKey(uriFor(f)!), f]) : []));
  const rows = createMemo(() => {
    const result: { id: number; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const file of children().get(parent) ?? []) {
        result.push({ id: file.id, depth });
        if (file.kind === "folder" && !collapsed().has(file.id)) walk(file.id, depth + 1);
      }
    };
    walk(null, 0);
    return result;
  }, [], { equals: (a, b) => a.length === b.length && a.every((row, i) => row.id === b[i].id && row.depth === b[i].depth) });
  const selected = () => (active() === null ? undefined : byId().get(active()!));
  const uniqueName = (parentId: number | null, wanted: string) => {
    const taken = new Set((children().get(parentId) ?? []).map((file) => file.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    const dot = wanted.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}${ext}`.toLowerCase())) return `${stem} ${n}${ext}`;
  };

  const select = (id: number) => {
    const current = open().includes(id) ? open() : [...open(), id];
    setOpen(current);
    rememberOpen(place, current);
    setActive(id);
  };
  const close = (id: number, event?: MouseEvent) => {
    event?.stopPropagation();
    const next = open().filter((openId) => openId !== id);
    setOpen(next);
    rememberOpen(place, next);
    if (active() === id) setActive(next.at(-1) ?? null);
  };
  // Files deleted by someone else leave the tabs.
  createEffect(() => {
    if (!files.loaded) return;
    const present = open().filter((id) => byId().get(id)?.kind === "file");
    if (present.length !== open().length) {
      setOpen(present);
      rememberOpen(place, present);
    }
    if (active() !== null && !present.includes(active()!)) setActive(present.at(-1) ?? null);
  });

  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try { await action(); } catch (e) { fail(e); }
  };
  const expand = (id: number | null) => id !== null && setCollapsed(new Set([...collapsed()].filter((c) => c !== id)));

  const add = (kind: "file" | "folder", parentId: number | null) => {
    if (kind === "file") return setNewFileIn(parentId);
    return run(async () => {
      const { id } = await addFolder(api, ctx.channel.id, parentId, uniqueName(parentId, "New folder"));
      ctx.history.push({ label: "Add folder", icon: "add", undo: () => removeFiles(api, [id]), redo: () => restoreFiles(api, [id]) });
      expand(parentId);
      setRenaming(id);
    });
  };
  const createFile = (name: string) => run(async () => {
    const parentId = newFileIn() ?? null;
    const { id } = await addFile(api, ctx.channel.id, parentId, uniqueName(parentId, name));
    ctx.history.push({ label: "Add file", icon: "add", undo: () => removeFiles(api, [id]), redo: () => restoreFiles(api, [id]) });
    setNewFileIn(undefined);
    expand(parentId);
    select(id);
  });
  // A file dragged in from another code channel (or this one in another workspace) is copied here, Shift moves it.
  const takeFrom = (event: DragEvent, parentId: number | null) => {
    const payload = readCodePayload(event.dataTransfer);
    if (!payload || (payload.workspaceId === ctx.workspace.id && payload.channelId === ctx.channel.id)) return false;
    void run(async () => {
      const id = await dropCodeFile(payload, { workspaceId: ctx.workspace.id, channelId: ctx.channel.id, type: "code", parentId }, event.shiftKey);
      ctx.history.push({ label: "Copy file", icon: "add", undo: () => removeFiles(api, [id]), redo: () => restoreFiles(api, [id]) });
      expand(parentId);
    });
    return true;
  };
  const rename = async (file: CodeFile, name: string) => {
    const old = file.name;
    if (!name || name === old) return;
    await renameFile(api, file.id, name);
    ctx.history.push({ label: "Rename", icon: "rename", undo: () => renameFile(api, file.id, old), redo: () => renameFile(api, file.id, name) });
  };
  const remove = async (file: CodeFile) => {
    const id = file.id;
    await removeFiles(api, [id]);
    ctx.history.push({ label: file.kind === "folder" ? "Delete folder" : "Delete file", icon: "delete", undo: () => restoreFiles(api, [id]), redo: () => removeFiles(api, [id]) });
  };
  const move = (id: number, parentId: number | null) => run(async () => {
    const file = byId().get(id);
    if (!file || file.parentId === parentId || id === parentId || (parentId !== null && ancestors(parentId).includes(id))) return;
    const old = file.parentId;
    await moveFile(api, id, parentId);
    ctx.history.push({ label: "Move", icon: "forward", undo: () => moveFile(api, id, old), redo: () => moveFile(api, id, parentId) });
    expand(parentId);
  });

  let filePicker!: HTMLInputElement;
  let folderPicker!: HTMLInputElement;
  let importParent: number | null = null;
  const pickImport = (parent: number | null, folder: boolean) => {
    importParent = parent;
    (folder ? folderPicker : filePicker).click();
  };
  const runImport = (tree: ReturnType<typeof fromPicked>, parent: number | null) => run(async () => {
    setNotice("");
    const entries = await expandZips(entriesOf(tree));
    if (!entries.length) return setNotice("Nothing to import.");
    setImporting(`Importing 0 of ${entries.length} files...`);
    try {
      const result = await importFiles(api, ctx.workspace.id, ctx.channel.id, parent, entries, files.value, (done, total) => setImporting(`Importing ${done} of ${total} files...`));
      const ids = result.ids;
      if (ids.length) ctx.history.push({ label: `Import ${ids.length} items`, icon: "upload", undo: () => removeFiles(api, ids), redo: () => restoreFiles(api, ids) });
      expand(parent);
      setNotice(result.failed ? `Imported ${ids.length} items; ${result.failed} skipped (name already used or failed).` : `Imported ${ids.length} items.`);
    } finally { setImporting(null); }
  });
  const fileDrop = createFileDrop((data) => {
    if (!canEdit()) return;
    void fromDrop(data).then((tree) => runImport(tree, null), fail);
  });
  createEffect(() => { if (notice()) { const timer = setTimeout(() => setNotice(""), 6000); onCleanup(() => clearTimeout(timer)); } });

  const menu = (event: MouseEvent, file: CodeFile) => ctx.openContextMenu(event, [
    ...(file.kind === "folder" ? [
      { label: "New file", icon: "add", disabled: !canEdit(), action: () => void add("file", file.id) },
      { label: "New folder", icon: "folder-add", disabled: !canEdit(), action: () => void add("folder", file.id) },
      { label: "Import into this folder", icon: "upload", disabled: !canEdit(), items: [
        { label: "Import files...", icon: "upload", action: () => pickImport(file.id, false) },
        { label: "Import a folder...", icon: "folder-upload", action: () => pickImport(file.id, true) },
      ] },
      "separator",
    ] : []),
    ...(canEdit() ? [{ render: () => <RenameItem label="Rename" value={file.name} clean={(name) => name.trim()} onSave={(name) => rename(file, name)} /> }] : []),
    ...(file.kind === "file" ? [{ label: "Copy link", icon: "link", action: () => copyLink(ctx.linkTo({ kind: "file", id: file.id })) }] : []),
    ...(canEdit() ? ["separator" as const, { render: () => <ConfirmItem label={file.kind === "folder" ? "Delete with contents" : "Delete"} question={`Delete ${file.name}?`} onConfirm={() => remove(file)} /> }] : []),
  ] as MenuEntry[]);

  // The open file's text, saved as a plain copy shortly after typing stops (and at once when the file is left).
  let host!: HTMLDivElement;
  let editor: CodeEditor | undefined;
  let current: { file: CodeFile; live: OpenText } | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let stopSelection: (() => void) | undefined;
  let reveal: { id: number; offset: number; length: number } | null = null;
  let revealLine: { id: number; line: number; column: number } | null = null;
  let lspClose: (() => void) | undefined;
  let seq = 0;
  const persist = async (file: CodeFile, live: OpenText) => {
    clearTimeout(persistTimer);
    if (!canEdit() || !dirty[file.id]) return;
    const text = live.ytext.toString();
    setDirty(file.id, false);
    try {
      const blob = new Blob([text], { type: "text/plain" });
      const upload = await prepareUpload(new File([blob], file.name, { type: "text/plain" }), { workspaceId: ctx.workspace.id });
      await api.call("set-content", { file_id: file.id, hash: upload.url, size: blob.size });
    } catch (e) {
      setDirty(file.id, true);
      fail(e);
    }
  };
  const closeText = async () => {
    stopSelection?.();
    stopSelection = undefined;
    lspClose?.();
    lspClose = undefined;
    const last = current;
    current = undefined;
    editor?.closeModel();
    if (!last) return;
    await last.live.flush();
    await persist(last.file, last.live);
    await last.live.close();
  };
  const share = () => {
    const at = editor?.selection();
    const live = current;
    if (!at || !live) return ctx.presence.set(null);
    const encode = (index: number) => toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(live.live.ytext, index)));
    ctx.presence.set({ file: live.file.id, a: encode(at.anchor), h: encode(at.head) });
  };
  const openText = async (file: CodeFile) => {
    const mine = ++seq;
    await closeText();
    setUnsupported(false);
    setLoading(true);
    try {
      if (tools && folder() === null) await syncFolder().catch(() => null);
      let seed = "";
      if (file.size > textLimit) return setUnsupported(true);
      if (file.hash) {
        const blob = await contentBlob(file.hash, "text/plain");
        if (blob.size > textLimit || !(await isTextBlob(blob))) return setUnsupported(true);
        seed = await blob.text();
      }
      const live = openLiveText({
        list: async () => (await api.call<{ rows: { id: number; data: string }[] }>("list-updates", { file_id: file.id })).rows,
        add: async (data, replaces) => (await api.call<{ id: number }>("add-update", { file_id: file.id, data, ...(replaces.length ? { replaces: JSON.stringify(replaces) } : {}) })).id,
        seed: async () => seed,
        subscribe: (refresh) => ctx.api.onEvent((event) => event.table === "code_updates" && refresh()),
        onError: fail,
      });
      await live.ready;
      if (mine !== seq) return void (await live.close());
      current = { file, live };
      editor?.openModel(file, live.ytext, !canEdit(), uriFor(file));
      connectServer(file, live, mine);
      live.doc.on("update", (_update: Uint8Array, origin: unknown) => {
        setTick((n) => n + 1);
        if (origin === "seed" || origin === "remote") return;
        setDirty(file.id, true);
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => void persist(file, live), 3000);
      });
      stopSelection = editor?.onSelection(() => {
        setPosition(editor!.position());
        share();
      });
      setPosition(editor?.position() ?? { line: 1, column: 1 });
      if (reveal?.id === file.id) { editor?.reveal(reveal.offset, reveal.length); reveal = null; }
      if (revealLine?.id === file.id) { editor?.revealLine(revealLine.line, revealLine.column); revealLine = null; }
    } catch (e) { fail(e); } finally { if (mine === seq) setLoading(false); }
  };

  // The run folder: a copy of the channel's files on this computer (the open file with its newest text), written
  // again shortly after the file list changes, and right before a Run.
  const syncFolder = async () => {
    const entries = files.value.filter((file) => file.kind === "file").map((file) => {
      const path = segmentsOf(file);
      if (current?.file.id === file.id) return { path, text: current.live.ytext.toString() };
      const hash = refHash(file.hash);
      return hash ? { path, hash } : { path, text: "" };
    });
    const result = await desktop!.code!.sync(ctx.workspace.id, ctx.channel.id, entries);
    setFolder(result.folder);
    return result;
  };
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(() => files.value, () => {
    if (!tools || !files.loaded) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => void syncFolder().catch(fail), 1500);
  }));

  // Language servers, one per kind started when a file of its language opens; they stop when the view closes.
  const sessions = new Map<string, Promise<LspSession | null>>();
  const diagnostics = new Map<string, { uri: string; list: LspDiagnostic[] }>();
  const sessionFor = (language: string) => {
    const serverId = serverFor(language);
    if (!serverId || !tools || codeSetting("lsp") === false || !folder()) return null;
    let session = sessions.get(serverId);
    if (!session) {
      const label = serverLanguages[serverId].label;
      session = startLsp({
        serverId, workspaceId: ctx.workspace.id, channelId: ctx.channel.id, folder: folder()!,
        override: (codeSetting(`lsp.${serverId}`) as string | undefined) || undefined,
        onDiagnostics(uri, list) {
          const key = uriKey(uri);
          diagnostics.set(key, { uri, list });
          setLspProblems(key, problemsOf(uri, list));
          const open = editor?.uri();
          if (open && uriKey(open) === key) editor!.setDiagnostics(open, list);
        },
        onExit(message) {
          sessions.delete(serverId);
          setLspNote(`${label}: ${message}`);
        },
      }).then((started) => {
        if (!("missing" in started)) return started;
        setLspNote(`No ${label} language server was found (${started.missing.join(", ")}). Install one, or set its path in Settings > Plugins > Code.`);
        if (started.install) setLspInstall({ serverId, from: started.install, busy: false });
        return null;
      }, (e) => {
        setLspNote(`${label} language server: ${userMessage(desktopError(e))}`);
        return null;
      });
      sessions.set(serverId, session);
    }
    return session;
  };
  const installServer = async () => {
    const install = lspInstall();
    if (!install || install.busy) return;
    setLspInstall({ ...install, busy: true });
    try {
      await desktop!.code!.installServer(install.serverId);
      sessions.delete(install.serverId);
      setLspInstall(null);
      setLspNote("");
      if (current) connectServer(current.file, current.live, seq);
    } catch (e) {
      setLspInstall({ ...install, busy: false });
      setLspNote(`Installing ${install.from} failed: ${userMessage(desktopError(e))}`);
    }
  };
  const connectServer = (file: CodeFile, live: OpenText, mine: number) => {
    const uri = editor?.uri();
    if (!uri) return;
    const known = diagnostics.get(uriKey(uri));
    if (known) editor!.setDiagnostics(uri, known.list);
    const language = languageOf(file.name, file.language);
    void sessionFor(language)?.then((session) => {
      if (!session || mine !== seq || current?.file.id !== file.id) return;
      session.open(uri, lspLanguage(language), live.ytext.toString());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        session.change(uri, live.ytext.toString());
      };
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(flush, 200);
      };
      // The server gets the newest text before every question, or it answers for what was there before the last key.
      attachServer(uri, { request: (method, params) => { flush(); return session.request(method, params); }, running: session.running });
      live.ytext.observe(changed);
      lspClose = () => {
        clearTimeout(timer);
        live.ytext.unobserve(changed);
        attachServer(uri, null);
        session.close(uri);
      };
    });
  };
  const stopServers = () => {
    for (const session of sessions.values()) void session.then((s) => s?.stop());
    sessions.clear();
  };
  // "Use language servers" applies to the open file at once.
  createEffect(on(() => codeSetting("lsp") !== false, (on) => {
    lspClose?.();
    lspClose = undefined;
    if (!on) {
      stopServers();
      setLspNote("");
      setLspInstall(null);
    } else if (current) connectServer(current.file, current.live, seq);
  }, { defer: true }));
  onCleanup(() => {
    clearTimeout(syncTimer);
    stopServers();
  });

  // Problems: the open file's from every source, and what language servers said about the others.
  const openAt = (file: CodeFile, line: number, column: number) => {
    if (active() === file.id && current) return editor?.revealLine(line, column);
    revealLine = { id: file.id, line, column };
    select(file.id);
  };
  const problemGroups = createMemo(() => {
    const groups: { file: CodeFile | undefined; path: string; problems: Problem[] }[] = [];
    const open = selected();
    if (open && ownProblems().length) groups.push({ file: open, path: pathOf(open), problems: ownProblems() });
    for (const [key, problems] of Object.entries(lspProblems)) {
      if (!problems?.length) continue;
      const file = fileByUri().get(key);
      const same = groups.find((group) => group.file && group.file === file);
      if (same) same.problems = [...same.problems, ...problems];
      else groups.push({ file, path: file ? pathOf(file) : decodeURIComponent(key.split("/").pop() ?? key), problems });
    }
    return groups;
  });
  const count = (severity: Problem["severity"]) => problemGroups().reduce((sum, group) => sum + group.problems.filter((p) => p.severity === severity).length, 0);
  const problemsOpen = () => ctx.isSidePanelOpen("problems");
  const toggleProblems = () => ctx.toggleSidePanel("problems", "Problems", solidMount(() => (
    <ProblemsPanel problems={problemGroups} onOpen={openAt} note={lspNote} install={lspInstall} onInstall={() => void installServer()} />
  )));
  setOpener((uri, line, column) => {
    const file = fileByUri().get(uriKey(uri));
    if (!file) return false;
    openAt(file, line, column);
    return true;
  });

  // AI suggestions, when turned on in the plugin's settings.
  setInlineSource(async (model, before, after, signal) => {
    if (codeSetting("ai") !== true) return "";
    try {
      return await suggest(selected()?.name ?? model.name, model.language, before, after, signal);
    } catch (e) {
      if (!signal.aborted) setError(`AI suggestion: ${userMessage(e)}`);
      return "";
    }
  });
  createEffect(() => editorReady() && editor?.setInline(codeSetting("ai") === true));
  onCleanup(() => {
    setInlineSource(null);
    setOpener(null);
  });

  // Run: this file with its language's usual command, or one of the channel's run configurations, in a terminal.
  const shell = () => (codeSetting("terminal.shell") as string | undefined) || undefined;
  const hasRoot = (name: string) => (children().get(null) ?? []).some((file) => file.name.toLowerCase() === name.toLowerCase());
  const fileRun = () => {
    const file = selected();
    if (file?.kind !== "file") return null;
    const command = fileCommand(languageOf(file.name, file.language), segmentsOf(file).join("/"), hasRoot);
    return command ? { file, command } : null;
  };
  const startRun = (title: string, command: string | null) => run(async () => {
    await syncFolder();
    await openTerminal(place, { workspaceId: ctx.workspace.id, channelId: ctx.channel.id, shell: shell() }, title, command);
  });
  const runFile = () => {
    const found = fileRun();
    rememberRun(place, "file");
    if (!found) return setError("There is no usual command for this file. Add a run configuration instead.");
    void startRun(found.file.name, found.command);
  };
  const runConfig = (config: RunConfig) => {
    rememberRun(place, config.id);
    if (!isApproved(place, config, ctx.users.me())) return setConfirming(config);
    void startRun(config.name, config.command);
  };
  const runDefault = () => {
    const last = lastRun(place);
    const config = typeof last === "number" ? runs.value.find((r) => r.id === last) : undefined;
    if (config) runConfig(config);
    else runFile();
  };
  const newTerminal = () => void startRun("Terminal", null);
  const toggleTerminal = () => ((terminals[place]?.length ?? 0) ? showPanel(place, !panelShown(place)) : newTerminal());
  const runsOpen = () => ctx.isSidePanelOpen("runs");
  const toggleRuns = () => ctx.toggleSidePanel("runs", "Run configurations", solidMount(() => (
    <RunPanel runs={() => runs.value} canEdit={canEdit} who={(id) => ctx.users.get(id).displayName}
      approved={(config) => isApproved(place, config, ctx.users.me())}
      onAdd={async (name, command) => {
        const { id } = await api.call<{ id: number }>("add-run", { channel_id: ctx.channel.id, name, command });
        approve(place, id, command);
      }}
      onSave={async (config, name, command) => {
        await api.call("update-run", { run_id: config.id, name, command });
        approve(place, config.id, command);
      }}
      onRemove={async (config) => void (await api.call("remove-run", { run_id: config.id }))}
      onRun={runConfig} />
  )));
  const runMenu = (event: MouseEvent) => {
    const found = fileRun();
    ctx.openContextMenu(event, [
      ...(found ? [{ label: `Run ${found.file.name}`, icon: "play", action: runFile }] : []),
      ...runs.value.map((config) => ({ label: config.name, icon: "play", action: () => runConfig(config) })),
      ...(found || runs.value.length ? ["separator" as const] : []),
      { label: "New terminal", icon: "terminal", action: newTerminal },
      { label: "Run configurations", icon: "settings", action: () => !runsOpen() && toggleRuns() },
      { label: "Open the run folder", icon: "folder", action: () => void desktop!.code!.openFolder(ctx.workspace.id, ctx.channel.id).catch(fail) },
    ] as MenuEntry[]);
  };

  // Other members' carets and selections in the open file.
  createEffect(() => {
    tick();
    const live = current;
    const others = ctx.presence.others();
    if (!editor || !live) return;
    const index = (value: unknown) => {
      try {
        const rel = Y.decodeRelativePosition(fromBase64(String(value)));
        return Y.createAbsolutePositionFromRelativePosition(rel, live.live.doc)?.index ?? null;
      } catch { return null; }
    };
    editor.setRemote(others.flatMap((other) => {
      const state = other.state as { file?: number; a?: unknown; h?: unknown } | null;
      if (state?.file !== live.file.id) return [];
      const anchor = index(state.a), head = index(state.h);
      if (anchor === null || head === null) return [];
      const who = ctx.users.get(other.userId);
      return [{ id: other.userId, name: who.displayName, color: who.color, anchor, head }];
    }));
  });
  const viewers = createMemo(() => {
    const map = new Map<number, number[]>();
    for (const other of ctx.presence.others()) {
      const file = (other.state as { file?: number } | null)?.file;
      if (typeof file === "number") (map.get(file) ?? map.set(file, []).get(file)!).push(other.userId);
    }
    return map;
  });

  onMount(() => {
    void createEditor(host).then((value) => {
      editor = value;
      editor.onProblems(() => setOwnProblems(editor!.ownProblems()));
      setEditorReady(true);
      const file = selected();
      if (file?.kind === "file") void openText(file);
    }, fail);
  });
  createEffect(on(active, (id) => {
    const file = id === null ? undefined : byId().get(id);
    if (!editor) return;
    if (file?.kind === "file") void openText(file);
    else void closeText();
  }, { defer: true }));
  // The file list arrives after the editor on a first open.
  createEffect(on(() => files.loaded, (loaded) => {
    const file = selected();
    if (loaded && editor && !current && file?.kind === "file") void openText(file);
  }));
  onCleanup(() => {
    ctx.presence.set(null);
    void closeText().finally(() => editor?.dispose());
  });

  // A followed link opens its file.
  createEffect(() => {
    const target = ctx.target();
    if (target?.kind !== "file" || !files.loaded) return;
    if (byId().get(Number(target.id))?.kind === "file") select(Number(target.id));
    else setError("That file is no longer here.");
  });

  const openHit = (hit: Hit) => {
    if (active() === hit.file.id && current) return editor?.reveal(hit.offset, hit.length);
    reveal = { id: hit.file.id, offset: hit.offset, length: hit.length };
    select(hit.file.id);
  };
  const findOpen = () => ctx.isSidePanelOpen("find");
  const toggleFind = () => ctx.toggleSidePanel("find", "Find in files", solidMount(() => (
    <FindPanel files={() => files.value} pathOf={pathOf} onOpen={openHit}
      liveText={(id) => (current?.file.id === id ? current.live.ytext.toString() : null)} />
  )));
  const undoKeys = historyKeys(ctx.history, fail);
  const keys = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      toggleFind();
    } else undoKeys(event);
  };

  const dropAt = (event: DragEvent, file: CodeFile | null) => {
    if (dragged === null) {
      if (!hasCodeFile(event.dataTransfer) || !canEdit()) return;
      event.preventDefault();
      event.stopPropagation();
      return setDrop({ id: file === null ? null : file.kind === "folder" ? file.id : file.parentId, inside: file?.kind === "folder" });
    }
    const target = file === null ? null : file.kind === "folder" ? file.id : file.parentId;
    if (target === dragged || (target !== null && ancestors(target).includes(dragged))) return setDrop(null);
    event.preventDefault();
    event.stopPropagation();
    setDrop({ id: target, inside: file?.kind === "folder" });
  };
  let dragged: number | null = null;

  const toggleFolder = (id: number) => setCollapsed(new Set(collapsed().has(id) ? [...collapsed()].filter((c) => c !== id) : [...collapsed(), id]));
  // A click on a row, or Enter on it: a file opens, a folder folds.
  const press = (file: CodeFile) => (file.kind === "file" ? select(file.id) : toggleFolder(file.id));
  const treeStop = createTreeStop(() => rows().map((row) => row.id), active);

  const Row = (row: { id: number; depth: number }) => {
    const file = () => byId().get(row.id)!;
    return (
      <Show when={byId().get(row.id)}>
        <div classList={{ "code-tree-item": true, selected: active() === row.id, "drop-inside": drop()?.inside === true && drop()?.id === row.id, "drop-sibling": drop()?.inside === false && drop()?.id === file().parentId && file().kind === "file" }}
          role="treeitem" aria-level={row.depth + 1} aria-selected={active() === row.id}
          aria-expanded={file().kind === "folder" ? !collapsed().has(row.id) : undefined}
          tabIndex={treeStop.tabIndex(row.id)} ref={treeRow} onFocus={() => treeStop.focused(row.id)}
          onKeyDown={treeKeys({ activate: () => press(file()), toggle: () => toggleFolder(row.id), rename: () => canEdit() && setRenaming(row.id) })}
          style={{ "--depth": row.depth }} draggable={canEdit() && renaming() !== row.id}
          onClick={() => press(file())}
          onDblClick={() => canEdit() && setRenaming(row.id)}
          onContextMenu={(event) => menu(event, file())}
          onDragStart={(event) => { dragged = row.id; event.dataTransfer!.effectAllowed = "move"; event.dataTransfer!.setData("application/x-makework-code", String(row.id));
            if (file().kind === "file") event.dataTransfer!.setData(codeFileType, JSON.stringify({ workspaceId: ctx.workspace.id, channelId: ctx.channel.id, id: row.id })); }}
          onDragEnd={() => { dragged = null; setDrop(null); }}
          onDragOver={(event) => dropAt(event, file())}
          onDrop={(event) => {
            const at = drop();
            setDrop(null);
            if (!at) return;
            event.preventDefault();
            event.stopPropagation();
            if (dragged !== null) void move(dragged, at.id);
            else takeFrom(event, at.id);
          }}>
          <Show when={file().kind === "folder"} fallback={<span class="code-tree-spacer" />}>
            <span classList={{ "code-chevron": true, open: !collapsed().has(row.id) }}><Icon name="collapsed" size={12} /></span>
          </Show>
          <Icon name={file().kind === "folder" ? "code-folder" : "code-file"} size={14} />
          <Show when={renaming() === row.id} fallback={<span class="code-tree-name">{file().name}</span>}>
            <input class="code-rename" value={file().name} ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => { const name = event.currentTarget.value.trim(); setRenaming(null); void run(() => rename(file(), name)); }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key !== "Enter" && event.key !== "Escape") return;
                // Back to the row once the field is gone, so the keys go on in the tree.
                const treeItem = treeRowOf(event.currentTarget);
                if (event.key === "Escape") event.currentTarget.value = file().name;
                event.currentTarget.blur();
                treeItem?.focus();
              }} />
          </Show>
          <span class="code-viewers"><For each={(viewers().get(row.id) ?? []).slice(0, 3)}>{(id) => <Avatar user={ctx.users.get(id)} size={16} />}</For></span>
        </div>
      </Show>
    );
  };

  return <div class="code-view" role="presentation" tabIndex={-1} onKeyDown={keys} {...fileDrop.on}>
    <aside class="code-explorer" classList={panes.classes("explorer", "left")} style={{ width: treeWidth() === null ? undefined : `${treeWidth()}px` }}>
      <div class="code-explorer-head">
        <span>Explorer</span>
        <button class="icon-button" title="New file" aria-label="New file" disabled={!canEdit()} onClick={() => void add("file", null)}><Icon name="add" /></button>
        <button class="icon-button" title="New folder" aria-label="New folder" disabled={!canEdit()} onClick={() => void add("folder", null)}><Icon name="folder-add" /></button>
        <button class="icon-button" title="Import files or a folder" aria-label="Import" disabled={!canEdit() || importing() !== null} onClick={(event) => ctx.openContextMenu(event, [
          { label: "Import files...", icon: "upload", action: () => pickImport(null, false) },
          { label: "Import a folder...", icon: "folder-upload", action: () => pickImport(null, true) },
        ] as MenuEntry[])}><Icon name="upload" /></button>
        <button class="icon-button" classList={{ on: findOpen() }} title="Find in files (Ctrl+Shift+F)" aria-label="Find in files" onClick={toggleFind}><Icon name="search" /></button>
        <HistoryControls history={ctx.history} onError={fail} />
      </div>
      <input ref={filePicker} type="file" multiple hidden onChange={(event) => { const picked = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (picked.length) void runImport(fromPicked(picked), importParent); }} />
      <input ref={folderPicker} type="file" hidden {...{ webkitdirectory: "" }} onChange={(event) => { const picked = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (picked.length) void runImport(fromPicked(picked), importParent); }} />
      <Collapse open={newFileIn() !== undefined}>
        <Show when={newFileIn() !== undefined}><NewFileForm class="code-new-file" onSave={createFile} onCancel={() => setNewFileIn(undefined)} /></Show>
      </Collapse>
      <div classList={{ "code-tree": true, "mw-scroll-fade": true, "drop-root": drop()?.id === null && drop() !== null }}
        role="tree" aria-label="Files" tabIndex={-1}
        onDragOver={(event) => dropAt(event, null)}
        onDrop={(event) => {
          const at = drop();
          setDrop(null);
          if (!at) return;
          event.preventDefault();
          if (dragged !== null) void move(dragged, at.id);
          else takeFrom(event, at.id);
        }}>
        <Show when={files.loaded} fallback={<Skeleton kind="list" header={false} />}>
          <Index each={rows()}>{(row) => <Row id={row().id} depth={row().depth} />}</Index>
          <Show when={!rows().length}><p class="code-hint">No files yet. Add one or drop files here.</p></Show>
        </Show>
      </div>
      <Show when={importing() ?? notice()}>{(text) => <p class="code-note mw-fade-in">{text()}</p>}</Show>
      <ResizeHandle edge="right" label="Resize explorer" setWidth={setTreeWidth} save={saveTreeWidth} />
    </aside>
    <main class="code-main">
      <div class="code-tabs-row">
      <PaneButton panes={panes} pane="explorer" icon="folder" label="Explorer" />
      <div class="code-tabs mw-scroll-fade">
        <For each={open()}>{(id) => <Show when={byId().get(id)}>{(file) =>
          <button classList={{ "code-tab": true, active: active() === id }} onClick={() => setActive(id)} onAuxClick={(event) => event.button === 1 && close(id, event)}>
            <Icon name="code-file" size={14} /><span>{file().name}</span>
            <TabClose onClose={() => close(id)}>
              <Show when={dirty[id]} fallback={<Icon name="close" size={12} />}><span class="code-dirty" /></Show>
            </TabClose>
          </button>}</Show>}</For>
      </div>
      <Show when={tools}>
        <div class="code-run-buttons">
          <button class="icon-button" title="Run (the last run, or this file)" aria-label="Run" onClick={runDefault}><Icon name="play" /></button>
          <button class="icon-button" title="Run something else" aria-label="Run menu" onClick={runMenu}><Icon name="expanded" size={14} /></button>
          <button class="icon-button" classList={{ on: panelShown(place) }} title="Terminal" aria-label="Terminal" onClick={toggleTerminal}><Icon name="terminal" /></button>
        </div>
      </Show>
      </div>
      <ConfirmPrompt open={confirming() !== null} confirmLabel="Run"
        question={confirming() ? `${ctx.users.get(confirming()!.updatedBy).displayName} set "${confirming()!.name}" to run: ${confirming()!.command}  Run it on this computer?` : ""}
        onConfirm={() => {
          const config = confirming();
          setConfirming(null);
          if (!config) return;
          approve(place, config.id, config.command);
          void startRun(config.name, config.command);
        }}
        onCancel={() => setConfirming(null)} />
      <div class="code-editor-host">
        <div class="code-monaco" ref={host} />
        <Show when={!editorReady() || loading()}><div class="code-overlay"><Skeleton kind="document" header={false} /></div></Show>
        <Show when={editorReady() && !loading() && (!selected() || unsupported())}>
          <div class="code-overlay code-empty">{unsupported() ? "This file is binary or too large to edit here." : "Open a file to start editing."}</div>
        </Show>
      </div>
      <Show when={tools && panelShown(place) && (terminals[place]?.length ?? 0) > 0}>
        <TerminalPanel place={place} onNew={newTerminal} />
      </Show>
      <div class="code-status">
        <button class="code-problems-button" classList={{ on: problemsOpen() }} title="Problems" aria-label="Problems" onClick={toggleProblems}>
          <Icon name="error" size={14} /><span>{count("error")}</span><Icon name="warning" size={14} /><span>{count("warning")}</span>
        </button>
        <Show when={selected()} fallback={<span />}>{(file) =>
          <Select value={languageOf(file().name, file().language)} label="Language" disabled={!canEdit() || unsupported()}
            options={languages.map(([value, label]) => ({ value, label }))}
            onChange={(language) => { editor?.setLanguage(language); void run(() => setLanguage(api, file().id, language)); }} />}
        </Show>
        <Show when={!canEdit()}><span>Read only</span></Show>
        <Show when={selected() && !unsupported()}><span>Ln {position().line}, Col {position().column}</span></Show>
        <Show when={selected() && dirty[selected()!.id]}><span>Saving…</span></Show>
        <Show when={error()}><span class="code-error" title={error()}>{error()}</span></Show>
      </div>
    </main>
    <DropHint show={fileDrop.over() && canEdit()} label="Drop files, folders or a .zip to add them" />
  </div>;
}
