// Bridge to the Electron shell (electron/preload.cjs). Undefined in the browser.
import { ShownError } from "../api/client";
import type { StoredCheckpoint } from "../p2p/ledger";
import type { Commit } from "../p2p/log";
import type { DiskEntry } from "../plugins/types";

// This is deliberately data-only so browser channel code can choose its persistent Electron partition without
// depending on Electron. Length-prefixing keeps pairs distinct even when an ID contains separators.
// How a release build runs (electron/release.js): commands run in a folder of the repository ("." for its root),
// and which files of the output folder (relative to that folder) become release files.
export type BuildCollect = { kind: "binaries" | "installers" | "zip" } | { kind: "pattern"; pattern: string };
export interface BuildPlan { project: string; steps: string[]; output: string; collect: BuildCollect }

export function browserPartitionFor(workspaceId: string | number, channelId: string | number): string {
  const part = (value: string | number) => {
    const encoded = encodeURIComponent(String(value));
    return `${encoded.length}-${encoded}`;
  };
  return `persist:mw-browser-${part(workspaceId)}-${part(channelId)}`;
}

// What a window shows: a place in a workspace, in the shape of core/navigation's Location. It is repeated here so
// the bridge stays unrelated to navigation (navigation is built on desktop, not the other way round).
export interface WindowPlace {
  workspaceId: string;
  channelId: number | null;
  peer?: string;
  target?: { kind: string; id: number | string };
}

// A code channel terminal as a page taking it over gets it: where it belongs, its tab, its state, its last output.
export interface TerminalState {
  workspaceId: string;
  channelId: number;
  title: string;
  command: string | null;
  running: boolean;
  exitCode: number | null;
  backlog: string;
}

export interface DesktopBridge {
  platform: string;
  // The version on the download page; null when it can't be told.
  latestVersion?(): Promise<unknown>;
  // How a window's process last ended by a crash, once: the page can't report its own (core/crashReports.ts).
  takeLastCrash?(): Promise<{ reason: string; exitCode: number; version: string; at: string } | null>;
  // The app is about to quit (core/farewell.ts): the main window leaves its call and says bye, then answers
  // `farewellDone`. The main process waits for it a moment at most.
  onFarewell?(handler: () => void): () => void;
  farewellDone?(): void;
  // makework:// links the operating system opened the app with, collected by the main process until taken
  // (core/openLinks.ts). `onOpenLinks` says more are waiting.
  takeOpenLinks?(): Promise<string[]>;
  onOpenLinks?(handler: () => void): () => void;
  // Before a deliberate quit the main process asks how many new uploads no node has all of yet (core/farewell.ts); it
  // asks the user first when there are any.
  onQuitCheck?(count: () => number): () => void;
  // Browser channels: plays keys, pasted text or a copy in this window's copy of a page (a <webview>'s
  // getWebContentsId()).
  browserKeys?(guestId: number, events: unknown[]): Promise<void>;
  // Browser channels: record DOM changes from a webview owned by this window. The listener receives rrweb batches.
  browserDomStart?(guestId: number): Promise<boolean>;
  browserDomStop?(guestId: number): Promise<boolean>;
  browserDomListen?(handler: (guestId: number, events: unknown[]) => void): () => void;
  // "on", "starting" or "off: <why>".
  browserAdblock?(): Promise<string>;
  // Browser channels, the host's side of the resource proxy: a resource its page loaded since it last navigated.
  // Points to the elements under them on a page being recorded ("at"), or back ("point"); null where none.
  browserAnchors?(guestId: number, kind: "at", items: { x: number; y: number }[]): Promise<({ id: number; fx: number; fy: number } | null)[]>;
  browserAnchors?(guestId: number, kind: "point", items: { id: number; fx: number; fy: number }[]): Promise<({ x: number; y: number } | null)[]>;
  // The biggest video showing on a page being recorded (at most one): node id, playing (0/1), its visible part in
  // page px (x, y, w, h; fx0..fy1 as fractions of its box) and the window size (vw, vh).
  browserAnchors?(guestId: number, kind: "media", items: []): Promise<BrowserVideo[]>;
  // Makes the page the next getDisplayMedia source of this window.
  browserCapture?(guestId: number): Promise<boolean>;
  // A video element's own stream from a recorded page (videoShare.ts): start asks the page, which offers it.
  browserElementCapture?: {
    start(guestId: number, nodeId: number): Promise<boolean>;
    answer(guestId: number, sdp: string): Promise<void>;
    stop(guestId: number): Promise<void>;
    onOffer(handler: (guestId: number, nodeId: number, sdp: string | null) => void): () => void;
  };
  browserFetch?(guestId: number, url: string): Promise<ProxiedResource | null>;
  // The viewer's side: mwbrowser://<token>/... resources main can't load itself are asked for here.
  browserProxy?: {
    register(token: string, partition: string): Promise<boolean>;
    unregister(token: string): Promise<void>;
    answer(id: number, answer: ProxiedResource | null): void;
    listen(handler: (id: number, token: string, url: string) => void): () => void;
  };
  // Chrome Web Store extensions are cached locally, then loaded only into the browser channel's own partition.
  browserExtensions?: {
    install(extensionId: string): Promise<BrowserExtension>;
    apply(partition: string, extensionIds: string[]): Promise<BrowserExtension[]>;
  };
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  // Brings the window forward (a clicked notification).
  focus?(): void;
  // The window, taskbar and tray icon (a PNG data URL) and the macOS dock's badge count. On Windows also the icon
  // without its badge and the badge alone, which goes over the taskbar button (electron/main.js).
  setIcon?(pngDataUrl: string, count: number, extra?: { plain?: string; badge?: string }): void;
  isMaximized(): Promise<boolean>;
  // Closing to the tray, starting with the computer (installed builds only: `startupAvailable`) and the graphics card.
  background?: {
    get(): Promise<BackgroundSettings>;
    set(changes: Partial<Pick<BackgroundSettings, "closeToTray" | "launchAtStartup" | "gpu">>): Promise<BackgroundSettings>;
  };
  // Whether the computer runs on battery, from the system's power source (core/power.ts). `noteBattery`: the page saw
  // a battery (below full charge), for the "auto" graphics choice. Undefined in older desktop builds.
  power?: DesktopPower;
  onMaximizedChange(handler: (maximized: boolean) => void): () => void;
  // Tabs in their own window (core/popout.ts). Undefined in the browser and in older desktop builds.
  popout?: {
    // Opens the place in its own window, or brings forward the view window already showing it.
    open(place: WindowPlace, at?: { x: number; y: number }): Promise<void>;
    // Asks the main window to take a place the caller can't show (a link that points at another workspace).
    openInMain(place: WindowPlace): Promise<void>;
    // Hands a tab the window holds back to the main window (the view window closes after). False when the main
    // window is gone, so the tab would have nowhere to go.
    returnTab(place: WindowPlace): Promise<boolean>;
    dragStart(place: WindowPlace): void;
    dragMove(x: number, y: number): void;
    // The cursor was released at this screen position; what happened to the tab.
    dragEnd(place: WindowPlace, x: number, y: number): Promise<"none" | "created" | "returned">;
    dragCancel(): void;
    // What the cursor is over while a tab is dragged: this window, the main window, another view window, or nothing.
    onDragState(handler: (region: "self" | "main" | "popout" | "desktop") => void): () => void;
    // A tab dragged over this window, at this point in it (window coordinates), and that it left again.
    onTabDragOver(handler: (at: { x: number; y: number }) => void): () => void;
    onTabDragLeave(handler: () => void): () => void;
    // A tab handed to this window (from a view window or from a drag): open it, there [index] or after the active tab.
    onTabReceived(handler: (tab: { location: WindowPlace; index?: number | null; activate?: boolean }) => void): () => void;
  };
  // The screen share picker was closed without choosing anything.
  onScreenShareCancelled?(handler: () => void): () => void;
  // Screens and windows to share, for the app's own picker; null where the system shows one (Wayland).
  screenSources?(): Promise<ScreenSource[] | null>;
  // The source the next getDisplayMedia call shares, and whether it takes the system's sound along (Windows).
  chooseScreenSource?(id: string, audio: boolean): Promise<void>;
  // Linux: a virtual source with every other app's playback while sharing the screen; resolves with its label,
  // or null when it can't be made (no PipeWire).
  shareAudio?: { start(): Promise<string | null>; stop(): Promise<void> };
  // Opens content by hash in the system's player for its kind; resolves with an error message, or "" when opened.
  openContent?(hash: string, name: string): Promise<string>;
  // Google sign-in in the system browser with a loopback redirect; resolves with Google's ID and access tokens.
  googleSignIn?(options: { clientId: string; clientSecret: string; nonce: string; scope: string; loginHint?: string }): Promise<{ idToken: string; accessToken: string }>;
  // GitHub sign-in through the user server in the system browser; resolves with the one-time code the user server
  // sent back to a loopback port, for fetching the answer with `session`. `githubCancel` stops waiting.
  githubSignIn?(options: { server: string; session: string }): Promise<string>;
  githubCancel?(): Promise<void>;
  // File content by SHA-256 (hex), kept in the app's data folder or a workspace's own folder; shown through
  // mwc://content/<hash>. Moved one chunk at a time: parts are uploads or downloads being written, finished into
  // the store of `workspaceId` (the shared one without) once complete. `remove` deletes it everywhere,
  // `removeShared` only the shared store's copy.
  content?: {
    has(hash: string): Promise<boolean>;
    size(hash: string): Promise<number | null>;
    readRange(hash: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer> | null>;
    partOpen(resumeHash: string | null, workspaceId?: string): Promise<{ id: string; size: number }>;
    partAppend(id: string, bytes: Uint8Array): Promise<number>;
    partFinish(id: string, expected: string | null): Promise<{ hash: string; existed: boolean }>;
    partClose(id: string, discard: boolean): Promise<void>;
    remove(hash: string): Promise<void>;
    removeShared(hash: string): Promise<void>;
  };
  // Where serverless workspaces are kept: the app's storage, or a folder picked with `pick` (a token for `assign` or
  // `move`; it throws when the folder isn't empty or holds another workspace). A folder holds the workspace's history,
  // file contents, readable files and server.json (id, name, invite secret), enough to import it again.
  storage?: {
    pick(workspaceId?: string): Promise<{ token: string; folder: string } | null>;
    pickExisting(): Promise<{
      token: string; folder: string; id: string; name: string; secret: string | null;
      v?: 2 | 3; generation?: number; recoverySecrets?: string[];
    } | null>;
    assign(token: string, workspaceId: string, fields: {
      name?: string; secret?: string; v?: 2 | 3; generation?: number; recoverySecrets?: string[];
    }): Promise<string>;
    describe(workspaceId: string, fields: {
      name?: string; secret?: string; v?: 2 | 3; generation?: number; recoverySecrets?: string[];
    }): Promise<void>;
    location(workspaceId: string): Promise<string | null>;
    locations(): Promise<Record<string, string>>;
    loadCommits(workspaceId: string): Promise<Commit[]>;
    addCommits(workspaceId: string, commits: Commit[]): Promise<void>;
    compactCommits(workspaceId: string, hashes: string[]): Promise<void>;
    loadCheckpoint(workspaceId: string): Promise<StoredCheckpoint | null>;
    saveCheckpoint(workspaceId: string, checkpoint: StoredCheckpoint): Promise<void>;
    deleteCheckpoint(workspaceId: string): Promise<void>;
    // From the app's storage the commits and used hashes come along; from a folder its data folder is copied.
    move(workspaceId: string, token: string, data: {
      name: string; secret: string; v?: 2 | 3; generation?: number; recoverySecrets?: string[];
      commits?: Commit[]; hashes?: string[];
    }): Promise<string>;
    onMoveProgress(handler: (progress: { workspaceId: string; stage: "copying" | "cleaning"; done: number; total: number }) => void): () => void;
    show(workspaceId: string): Promise<string>;
    forget(workspaceId: string): Promise<void>;
    // Stops using the workspace's folder without deleting anything in it.
    release(workspaceId: string): Promise<void>;
  };
  // Saving to the computer: `choose` opens a folder or save-file dialog and returns a token for the place picked
  // (null if cancelled); content is then written there by hash. Inside a folder nothing is overwritten.
  save?: {
    choose(kind: "folder" | "file", suggestedName: string): Promise<{ id: string; where: string } | null>;
    mkdir(id: string, segments: string[], free: boolean): Promise<string[]>;
    write(id: string, segments: string[], hash: string): Promise<string>;
    done(id: string): Promise<void>;
  };
  // Local git repositories: only folders picked in the dialog can be read.
  git?: {
    pickFolder(): Promise<{ path: string; name: string; origin: string } | null>;
    // Shows a picked working copy in the system's file browser.
    openFolder(folder: string): Promise<string>;
    branches(folder: string): Promise<{ current: string; branches: { name: string; head: string }[] }>;
    log(folder: string, from: string, skip: number, max: number): Promise<{
      sha: string; parents: string[]; author_name: string; author_email: string; authored_at: string; message: string;
    }[]>;
    // The repository's submodules as its last commit lists them, with the repository's own origin link. The ones
    // checked out become folders this app may read, so this comes before anything is asked of such a folder.
    submodules(folder: string): Promise<{ origin: string; submodules: GitSubmodule[] }>;
    // The same, after cloning the ones missing here and putting each on its branch where that changes no file
    // (electron/gitOps.js prepareSubmodules). Talks to their remotes.
    prepareSubmodules(folder: string): Promise<{ origin: string; submodules: GitPreparedSubmodule[] }>;
    // Reading and the app's safe writes (electron/gitOps.js): never forced, checked before acting.
    status(folder: string): Promise<GitRepoState & { files: GitChange[] }>;
    workingDiff(folder: string, file: string): Promise<GitPatch>;
    show(folder: string, sha: string): Promise<GitPatch>;
    files(folder: string, rev: string): Promise<string[]>;
    blame(folder: string, rev: string, file: string): Promise<GitBlameLine[]>;
    branchList(folder: string): Promise<GitBranchList>;
    graph(folder: string, options?: { max?: number; skip?: number }): Promise<GitGraph>;
    remoteHeads(folder: string): Promise<Record<string, string>>;
    createBranch(folder: string, name: string, from: string): Promise<{ name: string; head: string }>;
    deleteBranch(folder: string, name: string, protectedNames: string[]): Promise<void>;
    // `origin/x` checks out the local `x` (made to follow origin's if needed); returns the branch now checked out.
    switchBranch(folder: string, name: string): Promise<string>;
    commit(folder: string, options: { paths: string[]; message: string; allowMassDelete?: boolean }): Promise<GitCommitResult>;
    fetch(folder: string): Promise<GitRemoteChange[]>;
    // `branch`: another local branch than the current one (pushing it, or publishing it when it isn't on the remote).
    pushCheck(folder: string, branch?: string): Promise<GitPushCheck>;
    push(folder: string, options?: { allowMassDelete?: boolean; branch?: string }): Promise<GitPushResult>;
    // Pull: the remote's new commits on the current branch.
    merge(folder: string): Promise<GitMergeResult>;
    // A local branch or origin/x into the current branch; or the current branch into `target` (switching to it).
    mergeBranch(folder: string, source: string): Promise<GitBranchMergeResult>;
    mergeInto(folder: string, target: string): Promise<GitBranchMergeResult>;
    // Resolving a merge that would conflict, before anything is touched: its conflicted files, one file's versions,
    // a cleanly merging file's diff, then the merge made with the member's choices (a fast-forward to it).
    mergeConflicts(folder: string, target: GitMergeTarget): Promise<GitConflicts>;
    mergeFile(folder: string, versions: Pick<GitConflictFile, "base" | "receiving" | "incoming">): Promise<GitFileTexts>;
    mergeDiff(folder: string, receiving: string, tree: string, file: string): Promise<GitPatch>;
    mergeResolved(folder: string, options: {
      target: GitMergeTarget; receiving: string; incoming: string; message: string; files: GitResolution[];
    }): Promise<GitResolvedResult>;
    // Stashes: put changes aside (all, or `paths`), bring one back (then it leaves the list), delete one for good.
    stashList(folder: string): Promise<GitStash[]>;
    stashPush(folder: string, options?: { paths?: string[]; message?: string; includeUntracked?: boolean }): Promise<GitStashResult>;
    stashRestore(folder: string, sha: string): Promise<GitStashResult>;
    stashDelete(folder: string, sha: string): Promise<void>;
    // A new commit on the current branch whose files are as they were at `sha` (one of its earlier commits).
    revertTo(folder: string, sha: string, options?: { allowMassDelete?: boolean }): Promise<GitRevertResult>;
    // The signed-in account, whose own host connections fetch, pull and push use (the tokens stay in main), and the
    // connection each working copy's folder uses: its key, "" for none (plugins/builtin/git/connections.ts).
    useAccount(id: string | null, credentials?: Record<string, string>): Promise<void>;
  };
  // Web lookups for agents: public sites only, as plain text (electron/webLookup.js).
  web?: {
    read(address: string): Promise<{ url: string; text: string; truncated: boolean }>;
    search(query: string): Promise<{ title: string; url: string; snippet: string }[]>;
  };
  // Video the page's player can't decode, converted with the computer's own ffmpeg (electron/videoTools.js): the
  // result's name for mwc://converted/<name>, or "none" for sound when the file has none.
  video?: {
    hasFfmpeg(): Promise<boolean>;
    // Length in seconds (0 when unknown) and which streams the file has; mwc://stream/<hash>?t=<seconds> streams it
    // converted as it plays.
    probe(hash: string): Promise<{ duration: number; picture: boolean; sound: boolean } | null>;
    // The sound's codec, or null when the file has none; mwc://sound/<hash>?t=<seconds> streams it decoded.
    probeSound(hash: string): Promise<string | null>;
    cached(hash: string, kind: "sound" | "video"): Promise<string | null>;
    convert(id: string, hash: string, kind: "sound" | "video"): Promise<string>;
    cancel(id: string): void;
    onProgress(handler: (id: string, value: number) => void): () => void;
  };
  // Media for the media bot: yt-dlp finds the streams of a link; `picture` and `sound` are tokens of
  // mwmedia://stream/<token> (the same token when one stream holds both, null when absent). Release when done.
  media?: {
    resolve(address: string, audioOnly: boolean): Promise<{
      session: string; title: string; duration: number | null; live: boolean; picture: string | null; sound: string | null;
    }>;
    // The entries of a playlist link; a link that is no playlist gives itself.
    list(address: string): Promise<{ url: string; title: string; duration: number | null }[]>;
    release(session: string): Promise<void>;
  };
  // Signing in to GitHub for repositories (device flow): the user enters `userCode` on github.com; `wait` resolves
  // once they approved (the token is then kept for "<account>:github.com"), denied, or the code ran out.
  github?: {
    deviceStart(clientId: string, account: string): Promise<{ handle: string; userCode: string; verificationUri: string; expiresIn: number }>;
    deviceWait(handle: string): Promise<{ ok: true; login: string | null } | { ok: false; reason: "denied" | "expired" | "cancelled" | "failed"; message?: string }>;
    deviceCancel(handle: string): Promise<void>;
    openDevicePage(): Promise<void>;
  };
  // Releases: build a picked folder's project for a branch and upload files to GitHub.
  release?: {
    // The usual build of the project in the folder (as it is on disk), and the tools it needs that aren't found.
    inspect(folder: string): Promise<{ label: string; note: string | null; plan: BuildPlan; missing: string[] } | null>;
    // Builds the branch in a temporary copy with a build configuration, or its usual build when `plan` is null.
    build(folder: string, branch: string, plan: BuildPlan | null): Promise<LocalFile[]>;
    stop(): void;
    onLog(handler: (line: string) => void): () => void;
    pickFiles(): Promise<LocalFile[]>;
    // Streams a file from disk to where its release host wants it (GitHub's release, GitLab's package registry).
    upload(target: { method: "POST" | "PUT"; url: string; headers: Record<string, string> }, file: string, name: string): Promise<unknown>;
    onProgress(handler: (file: string, done: number) => void): () => void;
  };
  // Secrets on this device, encrypted with the system keychain (`available` is false without one).
  secrets?: {
    available(): Promise<boolean>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  // Code channels (electron/codeTools.js): each channel's run folder is a one-way copy of its files, where
  // language servers and terminals run. `path` segments start at the channel's root.
  code?: {
    sync(workspaceId: string, channelId: number, entries: { path: string[]; text?: string; hash?: string }[]): Promise<{ folder: string; missing: number }>;
    openFolder(workspaceId: string, channelId: number): Promise<string>;
    startServer(serverId: string, workspaceId: string, channelId: number, override?: string): Promise<{ ok: true; id: number; command: string } | { ok: false; missing: string[]; install: string | null }>;
    // Downloads a language server into the app's own folder; `install` above says from where.
    installServer(serverId: string): Promise<void>;
    // Servers the app can install here; `size` in bytes while installed, `found` a program on PATH used first.
    installedServers(): Promise<{ id: string; label: string; from: string; installing: boolean; size: number | null; found: string | null }[]>;
    uninstallServer(serverId: string): Promise<void>;
    sendServer(id: number, text: string): void;
    stopServer(id: number): void;
    onServer(handler: (id: number, event: { text?: string; exit?: number | null; errors?: string }) => void): () => void;
    terminalsAvailable(): Promise<boolean>;
    startTerminal(options: { workspaceId: string; channelId: number; command?: string; shell?: string; title?: string; cols: number; rows: number }): Promise<number>;
    writeTerminal(id: number, data: string): void;
    resizeTerminal(id: number, cols: number, rows: number): void;
    // Stops the terminal's program (it can run again); closeTerminal ends the terminal and closes its window.
    killTerminal(id: number): void;
    closeTerminal(id: number): void;
    // Runs a Run's command again under the same terminal.
    restartTerminal(id: number): Promise<void>;
    // Pops the terminal out into a terminal window (at a screen point, else the cursor), or brings its window forward.
    popOutTerminal(id: number, at?: { x: number; y: number }): Promise<void>;
    // A terminal window's page takes the terminal over.
    adoptTerminal(id: number): Promise<TerminalState>;
    // Returns a popped-out terminal to its panel (its window closes).
    returnTerminal(id: number): void;
    // `returned`: a popped-out terminal came back to this page.
    onTerminal(handler: (id: number, event: { data?: string; exit?: number; returned?: TerminalState }) => void): () => void;
  };
  // The workspace's readable folder (p2p/diskView.ts) in ~/MakeWork/<server>/..., or in the workspace's own folder: kept
  // content by hash and generated text files. `key` is the workspace id.
  mirror?: {
    apply(key: string, workspaceName: string, entries: DiskEntry[]): Promise<{ folder: string; skipped: string[] }>;
    // `inner`: a folder inside it (a channel's), else the readable folder itself.
    open(key: string, workspaceName: string, inner?: string[]): Promise<string>;
    // Looks for changes made on disk now (they are also found by watching the folder).
    scan?(key: string): Promise<void>;
    // Takes a reported file as what the app wrote there; false when it changed again meanwhile. `relative`, `moveTo`:
    // paths in the readable folder joined with "/".
    adopt?(key: string, relative: string, stats: { hash?: string; size: number; mtimeMs: number }, moveTo?: string): Promise<boolean>;
    onChanges?(handler: (key: string, changes: FolderChange[]) => void): () => void;
  };
}

// A file in a workspace's readable folder that differs from what the app wrote (electron/mirror.js scan). `path`
// starts at the readable folder (["channels", ...]); `base` is what the app wrote there (a content hash, or
// "text:<sha256>"); `hash`, `text` (small .md/.json/.svg/.txt files), size and time are the file now.
export interface FolderChange {
  kind: "added" | "changed" | "removed";
  path: string[];
  base?: string;
  hash?: string;
  text?: string;
  size?: number;
  mtimeMs?: number;
}

export interface BackgroundSettings {
  closeToTray: boolean;
  launchAtStartup: boolean;
  startupAvailable: boolean;
  // The graphics card to draw with on computers with two, and whether the choice as saved needs a restart to apply
  // (Chromium picks its card when it starts). Missing in older desktop builds.
  gpu?: GpuChoice;
  gpuRestart?: boolean;
}

// "auto": the integrated GPU on a computer with a battery (a laptop), else the system's choice.
export type GpuChoice = "auto" | "integrated" | "discrete";

export interface DesktopPower {
  onBattery(): Promise<boolean>;
  onChange(handler: (onBattery: boolean) => void): () => void;
  noteBattery(): void;
}

export interface ScreenSource {
  id: string;
  name: string;
  screen: boolean;
  // A small picture as a data URL; empty when the system gave none.
  thumbnail: string;
}

export interface BrowserVideo {
  id: number;
  playing: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fx0: number;
  fy0: number;
  fx1: number;
  fy1: number;
  vw: number;
  vh: number;
}

export interface ProxiedResource {
  status: number;
  type: string;
  body: Uint8Array;
}

export interface BrowserExtension {
  id: string;
  name: string;
  version: string;
}

// A file on this computer (built or picked), for uploading.
export interface LocalFile {
  path: string;
  name: string;
  size: number;
}

// Git in a picked folder (electron/gitOps.js).
export interface GitRepoState {
  branch: string | null;
  head: string | null;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}
export interface GitChange {
  path: string;
  origPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
  // A submodule: the commit it is at changed (or its own files did), not a file.
  submodule?: true;
}
export interface GitSubmodule {
  // Its name in .gitmodules.
  name: string;
  // Inside the repository it belongs to.
  path: string;
  // As .gitmodules has it: it can be relative to the repository's own link.
  url: string;
  // The commit the repository's last commit records for it.
  pinned: string;
  // Its working copy when it is checked out on this device.
  folder: string | null;
  // The branch .gitmodules names for it: null for none, "." for its repository's own current branch.
  branch: string | null;
}
// A submodule after prepareSubmodules: cloned here now, the branch it is on (null for none), put on it now, why it
// was left as it is, or what went wrong (`auth`: the host whose sign-in is missing).
export interface GitPreparedSubmodule extends GitSubmodule {
  cloned: boolean;
  onBranch: string | null;
  attached: boolean;
  left?: string;
  error?: string;
  auth?: string;
}
export interface GitPatch {
  patch: string;
  truncated: boolean;
}
export interface GitBlameLine {
  line: number;
  sha: string;
  author: string;
  time: number;
  summary: string;
  text: string;
}
export interface GitLocalBranch {
  name: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}
export interface GitBranchList {
  current: string | null;
  defaultBranch: string | null;
  branches: GitLocalBranch[];
  // origin's branches as last fetched: "origin/x".
  remotes: { name: string; head: string }[];
}
export interface GitRef {
  name: string;
  kind: "local" | "remote" | "tag" | "detached";
  // Checked out here.
  head: boolean;
}
export interface GitGraphCommit {
  sha: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  message: string;
  refs: GitRef[];
}
export interface GitGraph {
  head: GitRepoState;
  commits: GitGraphCommit[];
  more: boolean;
  // On origin but not on this copy's branches yet, and on local branches but not pushed.
  incoming: string[];
  outgoing: string[];
}
export type GitBranchMergeResult =
  | { ok: true; merged: number; fastForward: boolean; into: string; from: string }
  | { ok: false; reason: "nothing" | "unknown"; into: string; from: string }
  | { ok: false; reason: "uncommitted"; files: string[]; into: string; from: string }
  | { ok: false; reason: "conflicts"; conflicts: string[]; into: string; from: string }
  | { ok: false; reason: "failed"; message: string; into: string; from: string };
// Reverting the current branch to an earlier commit: a new commit with that commit's files (nothing rewritten).
export type GitRevertResult = { branch: string; restored: string } & (
  | { ok: true; sha: string; changed: number }
  | { ok: false; reason: "nothing" | "empty" }
  | { ok: false; reason: "uncommitted" | "untracked"; files: string[] }
  | { ok: false; reason: "mass-delete"; deleted: number; total: number }
  | { ok: false; reason: "failed"; message: string });
// A stash: changes put aside (`files`, newest first in the list), with the branch it was made on.
export interface GitStash {
  sha: string;
  ref: string;
  message: string;
  branch: string | null;
  time: string;
  files: string[];
}
export type GitStashResult =
  | { ok: true; sha?: string; files: string[] }
  | { ok: false; reason: "nothing" }
  | { ok: false; reason: "uncommitted" | "untracked"; files: string[] }
  | { ok: false; reason: "conflicts"; files: string[]; message: string };
export type GitCommitResult =
  | { ok: true; sha: string }
  | { ok: false; reason: "empty"; total: number }
  | { ok: false; reason: "mass-delete"; deleted: number; total: number };
export interface GitRemoteChange {
  branch: string;
  from: string | null;
  to: string;
  count: number;
}
export interface GitCommitSummary {
  sha: string;
  author: string;
  subject: string;
}
export interface GitPushCheck {
  branch: string;
  // The branch is the one checked out (uncommitted changes only count then).
  current: boolean;
  state: "up-to-date" | "ahead" | "behind" | "diverged" | "new-branch";
  ahead: number;
  behind: number;
  outgoing: GitCommitSummary[];
  incoming: GitCommitSummary[];
  // When the remote has new commits: whether merging them would be clean (conflicts null: this git can't tell).
  merge: { clean: boolean; conflicts: string[] | null } | null;
  uncommitted: string[];
  blocked: "empty" | null;
  massDelete: { deleted: number; total: number } | null;
}
export type GitPushResult =
  | { ok: true; pushed: number; branch: string }
  | { ok: false; reason: "up-to-date" | "behind" | "empty" | "mass-delete"; check: GitPushCheck }
  | { ok: false; reason: "rejected"; message: string; check: GitPushCheck };
// A merge the app starts: the remote's new commits into the current branch (pull), another branch into the current
// one, or the current branch into another one (switching to it).
export type GitMergeTarget = { kind: "pull" } | { kind: "branch"; source: string } | { kind: "into"; target: string };
// One version of a conflicted file (null where that side has no such file).
export interface GitFileVersion {
  oid: string;
  mode: string;
}
export interface GitConflictFile {
  path: string;
  // The last commit both branches share, the receiving branch's and the incoming branch's.
  base: GitFileVersion | null;
  receiving: GitFileVersion | null;
  incoming: GitFileVersion | null;
  // A kind of conflict not resolved here (renames, a file and a folder): git's message about it.
  unsupported: string | null;
}
export interface GitConflicts {
  into: string;
  from: string;
  // The two commits being merged: the resolution is made for exactly these.
  receiving: string;
  incoming: string;
  // The merged tree as git makes it (conflicted files with markers), for the clean files' diffs.
  tree: string;
  files: GitConflictFile[];
  // Git's messages for the conflicts not resolved here; the merge then needs the user's own git tools.
  unsupported: string[];
  // The other files the merge changes, which merge by themselves.
  clean: string[];
  // The merge commit's message unless the user writes one (git's own).
  message: string;
}
export type GitFileText = { text: string } | { binary: true } | { tooLarge: true };
export interface GitFileTexts {
  base: GitFileText | null;
  receiving: GitFileText | null;
  incoming: GitFileText | null;
}
// What a conflicted file becomes: the text written for it, one side's version as it is, or no file.
export type GitResolution =
  | { path: string; content: string }
  | { path: string; side: "receiving" | "incoming" }
  | { path: string; delete: true };
export type GitResolvedResult =
  | { ok: true; sha: string; merged: number; resolved: number; into: string; from: string }
  // `moved`: the receiving branch has new commits since; `changed`: the conflicted files aren't the ones resolved.
  | { ok: false; reason: "moved" | "changed" | "empty"; into: string; from: string }
  | { ok: false; reason: "uncommitted"; files: string[]; into: string; from: string }
  | { ok: false; reason: "failed"; message: string; into: string; from: string };
export type GitMergeResult =
  | { ok: true; merged: number; fastForward: boolean }
  | { ok: false; reason: "nothing" | "uncommitted" | "conflicts" | "unknown"; check: GitPushCheck }
  | { ok: false; reason: "failed"; message: string; check: GitPushCheck };

export const desktop: DesktopBridge | undefined =
  typeof window !== "undefined" ? (window as { makeworkDesktop?: DesktopBridge }).makeworkDesktop : undefined;

// An error from a desktop call as a message for the user: without Electron's "Error invoking remote method …" prefix.
// A call the running app doesn't know means the page is newer than the app (an update that needs a restart).
export function desktopError(e: unknown): ShownError {
  const text = String((e as Error)?.message ?? e);
  if (text.includes("No handler registered")) return new ShownError("Restart the app to finish updating it.", { cause: e });
  return new ShownError(text.replace(/^Error invoking remote method '[^']*': (Error: )?/, ""), { cause: e });
}
