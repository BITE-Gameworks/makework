// One repository of a version control channel: the main one, or one of its submodules (`sub`, chosen in GitView).
import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { openChannel } from "../../../core/navigation";
import Skeleton from "../../../ui/Skeleton";
import { userMessage } from "../../../api/client";
import { desktop, desktopError, type GitMergeTarget } from "../../../core/desktop";
import { isLooking, notify } from "../../../core/notifier";
import { checkGitHubSignIn, githubLogin, githubRevision, githubSignInReady } from "../../../core/githubAuth";
import { getToken, tokenRevision, tokenStorage } from "../../../core/secrets";
import { relativeTime } from "../../../core/time";
import { openSettings } from "../../../core/ui";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import type { MenuEntry } from "../../../ui/contextMenu";
import Select from "../../../ui/Select";
import TabUnderline from "../../../ui/TabUnderline";
import { ProgressBar } from "../../../ui/UploadList";
import type { ChannelContext } from "../../types";
import { addConnection, channelConnectionKey, channelToken, connectionRevision, connectionsFor, forgetConnection, useConnection } from "./connections";
import Branches from "./Branches";
import Changes from "./Changes";
import CommitAside, { type Pane } from "./CommitAside";
import CommitList, { type CommitLabel } from "./CommitList";
import Files from "./Files";
import { stashMessage } from "./actions";
import SignInPrompt from "./GitHubSignIn";
import { GitAuthError, gitCall } from "./local";
import LocalHistory from "./LocalHistory";
import MergeResolver from "./MergeResolver";
import PushPanel from "./PushPanel";
import SyncBar from "./SyncBar";
import { createWorkingCopy } from "./workingCopy";
import { channelName, compareHeads, describeChanges, importLatest, openCheckMs, repeat, viewWatching, type RemoteChange } from "./watch";
import { createHistory, createRepo, hostOf, loadRepos, localFolder, readerHere, repoName, setLocalFolder, type Repo } from "./data";
import { describeSkipped, importRepo, type ImportProgress, type Skipped } from "./importer";
import { describePrepared, findSubFolders, importChannel, type Prepared } from "./tree";
import ReleasePage from "./ReleasePage";
import { releaseHost, releaseTarget, type ReleaseHost } from "./releases";
import { RepoAccessError, parseRepoLink, readerFor, type RepoReader } from "./providers";

const pageSize = 100;

// Tabs for a channel with a working copy on this device; without one only History exists.
type Tab = "history" | "changes" | "branches" | "files";
const tabs: { id: Tab; label: string }[] = [
  { id: "history", label: "History" },
  { id: "changes", label: "Changes" },
  { id: "branches", label: "Branches" },
  { id: "files", label: "Files" },
];

export default function RepoView(props: {
  context: ChannelContext;
  // "" for the channel's main repository, else a submodule's path from its root.
  sub: string;
  // The channel's repositories, the main one first; empty before one is connected.
  repos: Repo[];
  onShow: (sub: string) => void;
}) {
  const ctx = props.context;
  const workspaceId = ctx.workspace.id;
  const channelId = ctx.channel.id;
  const sub = props.sub;
  const state = createRepo(ctx.api, channelId, sub);
  const repo = () => state.value.repo;
  const main = () => props.repos.find((r) => r.subPath === "") ?? null;
  const mainHost = () => (main() ? hostOf(main()!) : null);
  const [changing, setChanging] = createSignal(false);
  const [releasing, setReleasing] = createSignal(false);
  // The host this repository's host connection is for (connections.ts): its own, a folder's by its origin.
  const connectionHost = () => (repo() ? hostOf(repo()!) : null);
  // A submodule on another host than the main repository's has the channel's pick for that host.
  const ownHost = () => (sub !== "" && connectionHost() !== mainHost() ? connectionHost() ?? undefined : undefined);
  const revisions = () => connectionRevision() + tokenRevision() + githubRevision();
  // The repository's connection on this computer and the others for its host, for the More menu and sign-in prompts.
  const [connection] = createResource(() => (connectionHost() ? { host: connectionHost()!, own: !!ownHost(), revision: revisions() } : false),
    async ({ host, own }) => ({ key: await channelConnectionKey(workspaceId, channelId, host, own), list: await connectionsFor(host) }));
  const currentConnection = () => connection.latest?.key ?? null;
  // Releases go to the repository's GitHub or GitLab (a folder's through its origin there) and need a host
  // connection that may write to it: the channel's connection on this computer. Checked again after every sign-in,
  // sign-out or connection change, when the release page opens, and when publishing fails.
  // The main repository's only: a submodule's releases are made in a channel of its own.
  const target = createMemo(() => (repo() && sub === "" ? releaseTarget(repo()!) : null), null,
    { equals: (a, b) => a?.kind === b?.kind && a?.host === b?.host && a?.path === b?.path });
  type Access = { host: ReleaseHost; token: string };
  // The host's last answer per repository: when it can't be asked (offline, a server error), that answer stands,
  // so a hiccup neither hides the option nor takes a release page away.
  let lastAnswer: { key: string; access: Access | null } | null = null;
  const [release, { refetch: checkRelease }] = createResource(
    () => target() && { target: target()!, revision: revisions() },
    async ({ target: t }): Promise<Access | null> => {
      const key = `${t.kind}:${t.host}:${t.path}`;
      const host = releaseHost(t);
      const token = await channelToken(workspaceId, channelId, t.host);
      let access: Access | null = null;
      try {
        access = token && (await host.access(token)) ? { host, token } : null;
      } catch {
        return lastAnswer?.key === key ? lastAnswer.access : null;
      }
      lastAnswer = { key, access };
      return access;
    });
  const canRelease = () => !!target() && !!release();
  // The connection the open release page uses; a newer one that can write replaces it. Losing access keeps the
  // page (and what was built and typed on it) with a warning: a new token from the menu, and it can publish again.
  const [opened, setOpened] = createSignal<Access | null>(null);
  createEffect(() => releasing() && canRelease() && setOpened(release()!));
  const openRelease = () => {
    setOpened(release()!);
    setReleasing(true);
    void checkRelease();
  };
  // Adding or picking a host connection from the menu (for the channel, or for releases): why it is asked, and whether
  // it starts at adding one.
  const [adding, setAdding] = createSignal<{ reason: string; add: boolean } | null>(null);
  let lastAdding = { reason: "", add: false };
  const shownAdding = () => (lastAdding = adding() ?? lastAdding);
  const [error, setError] = createSignal("");
  // Something that didn't stop the import, e.g. a token that couldn't be remembered.
  const [note, setNote] = createSignal("");
  const tokenNotSaved = (e: unknown) =>
    setNote(`The token couldn't be remembered on this device (${userMessage(e)}). It was still used for this import.`);
  const [progress, setProgress] = createSignal<ImportProgress | null>(null);
  // After an update failed without a token: the host to ask one for, and why it failed.
  const [needsToken, setNeedsToken] = createSignal<{ host: string; reason: string } | null>(null);
  // The boxes keep their last content while they slide closed.
  let lastProgress: ImportProgress = { read: 0, sent: 0 };
  let lastNeed = { host: "", reason: "" };
  const shownProgress = () => (lastProgress = progress() ?? lastProgress);
  // The submodule the import is at, when it isn't the repository shown.
  const importing = () => (shownProgress().sub && shownProgress().sub !== sub ? ` of ${shownProgress().sub}` : "");
  const shownNeed = () => (lastNeed = needsToken() ?? lastNeed);
  // Counts the asks, so each one gets a fresh prompt (nothing typed or picked for the last one), even while open.
  const [needAsk, setNeedAsk] = createSignal(0);
  const [removing, setRemoving] = createSignal(false);
  // The working copy on this device (commits, branches, push and blame happen there), if there is one. A submodule's
  // is its folder inside the main repository's, when it is checked out there.
  const [folder, setFolder] = createSignal(localFolder(workspaceId, channelId, sub));
  const useFolder = (path: string | null) => {
    setLocalFolder(workspaceId, channelId, path);
    setFolder(path);
  };
  // Gets the folder's submodules ready (the missing ones cloned, each on its branch) and finds the ones checked out
  // since the last look, e.g. in a terminal.
  const findFolders = async () => {
    if (!desktop?.git || !main() || !localFolder(workspaceId, channelId)) return;
    const { prepared } = await findSubFolders(workspaceId, channelId, mainHost(), true);
    setFolder(localFolder(workspaceId, channelId, sub));
    showPrepared(prepared);
    void wc.refresh();
  };
  // What that did, in the status line; a missing sign-in offers it, and signing in tries again.
  const showPrepared = (prepared: Prepared) => {
    const text = describePrepared(prepared);
    if (!text) return;
    const auth = prepared.failed.find((f) => f.auth)?.auth;
    wc.setMessage(auth ? { kind: "info", text, auth, retry: findFolders }
      : { kind: prepared.failed.length ? "error" : prepared.left.length ? "info" : "ok", text });
  };
  const [tab, setTab] = createSignal<Tab>("history");
  // A commit to open in History (from blame in the Files tab).
  const [showCommit, setShowCommit] = createSignal<string | null>(null);
  const [pushing, setPushing] = createSignal(false);
  // A merge whose conflicts are being resolved; `fromPush`: the push panel goes back up once it's made.
  const [resolving, setResolving] = createSignal<{ target: GitMergeTarget; fromPush: boolean } | null>(null);
  const local = () => !!(folder() && desktop?.git && repo());
  // The working copy's branches, graph and actions; History shows this computer's graph unless `shared` is chosen.
  const wc = createWorkingCopy(() => (local() ? folder() : null));
  const [shared, setShared] = createSignal(false);
  // A sign-in the remote asked for (or the menu started): its host, and what to run again once signed in. `add`: the
  // menu's "Sign in to GitHub", which goes straight to signing in rather than offering saved connections first.
  const [signingIn, setSigningIn] = createSignal<{ host: string; reason: string; retry?: () => void; add?: boolean } | null>(null);
  let lastSignIn: { host: string; reason: string; add?: boolean } = { host: "", reason: "" };
  const shownSignIn = () => (lastSignIn = signingIn() ?? lastSignIn);
  // The remote check stops asking after a refused sign-in, until the user signed in or picked another connection.
  let authPaused = false;
  const pickConnection = (key: string) => {
    useConnection(workspaceId, channelId, key, ownHost());
    authPaused = false;
  };
  const signedIn = (login?: string | null) => {
    const retry = signingIn()?.retry;
    setSigningIn(null);
    authPaused = false;
    wc.setMessage({ kind: "ok", text: login ? `Signed in to GitHub as ${login}.` : "Connected." });
    retry?.();
  };
  // The More menu's entry for the channel's connection: pick another, none, add one, or manage them in Settings.
  const connectionMenu = (host: string): MenuEntry => {
    const list = connection.latest?.list ?? [];
    const current = list.find((c) => c.key === currentConnection());
    return {
      label: `Connection: ${current?.name ?? "none"}`, icon: "lock", items: [
        ...list.map((c): MenuEntry => ({ label: c.name, icon: c.key === current?.key ? "check" : "lock", action: () => pickConnection(c.key) })),
        { label: "No connection", icon: current ? "close" : "check", action: () => pickConnection("none") },
        "separator",
        { label: "Add a connection...", icon: "add",
          action: () => setAdding({ reason: `A connection for ${host}, which this ${sub ? "submodule" : "channel"} uses on this computer.`, add: true }) },
        { label: "Manage connections...", icon: "settings", action: () => openSettings("plugins") },
      ],
    };
  };
  const againLabel: Record<string, string> = { Pulling: "pull", Merging: "merge", "Checking out": "check out", Reverting: "revert" };
  // Changes in the way of a pull, checkout, merge or revert: put them aside, run it again, and say where they are.
  const stashAndRetry = async () => {
    const m = wc.message();
    const f = folder();
    if (!m?.retry || !f) return;
    const doing = (m.action ?? "changing branches").toLowerCase();
    const stashed = await wc.act("Stashing", (dir) => gitCall((git) => git.stashPush(dir, { message: `Put aside before ${doing}`, includeUntracked: false })),
      (r) => stashMessage(r, "stash"));
    if (!stashed?.ok) return;
    await m.retry();
    const after = wc.message();
    const note = "Your changes are in Stashes (Changes tab); restore them when ready.";
    wc.setMessage(after ? { ...after, text: `${after.text} ${note}` } : { kind: "ok", text: note });
  };
  // The GitHub user MakeWork's own connection is signed in as, for GitHub repositories (local ones by their origin).
  const githubHere = () => repo()?.host === "github.com" || parseRepoLink(repo()?.url ?? "")?.host === "github.com";
  const [githubUser] = createResource(() => (githubHere() && desktop?.github ? githubRevision() + 1 : false), () => githubLogin());
  // After anything that changed the working copy: read it again, and bring the channel's history up to date.
  const changed = () => {
    void wc.refresh();
    void syncQuietly();
  };
  const remove = () => {
    setRemoving(false);
    void ctx.api.call("remove-repo", { channel_id: channelId })
      .then(() => useFolder(null), (e) => setError(userMessage(e)));
  };
  let running: AbortController | null = null;

  // Showing a submodule of this repository, by its path here, when the channel has it.
  const openSubmodule = (path: string) => {
    const full = sub ? `${sub}/${path}` : path;
    return props.repos.some((r) => r.subPath === full) ? () => props.onShow(full) : undefined;
  };

  // Whether imports bring the submodules: turning it on imports them now, turning it off forgets them.
  const includeSubmodules = async (include: boolean) => {
    try {
      await ctx.api.call("include-subrepos", { channel_id: channelId, subrepos: include });
      if (include) await update("update");
      else await ctx.api.call("set-subrepos", { channel_id: channelId, subrepos: "[]" });
    } catch (e) {
      setError(userMessage(e));
    }
  };

  // Linking this device's clone of a GitHub/GitLab repository: its origin must be that repository.
  const linkLocalCopy = async () => {
    const current = repo();
    if (!current) return;
    try {
      const picked = await desktop!.git!.pickFolder();
      if (!picked) return;
      const origin = parseRepoLink(picked.origin);
      const same = current.provider === "local"
        ? !current.url || origin?.url === current.url
        : origin?.host === current.host && origin.path.toLowerCase() === current.path.toLowerCase();
      if (!same) {
        setError(`That folder's origin is ${picked.origin || "not set"}, not this channel's repository.`);
        return;
      }
      useFolder(picked.path);
      setNote(`Using ${picked.path} on this computer for commits, branches and pushes.`);
      // Submodules checked out in it come along.
      void findFolders().then(syncQuietly);
    } catch (e) {
      setError(userMessage(desktopError(e)));
    }
  };

  // Watching the remote while the channel is open: the working copy on this device by fetching (local branches and
  // files are never touched), else the host's branch list (ETags: unchanged answers cost no rate limit).
  const [remoteNote, setRemoteNote] = createSignal("");
  let etag: string | null = null;
  const checkRemote = async () => {
    const current = repo();
    if (!current || changing() || running || authPaused) return;
    const f = folder();
    let changes: RemoteChange[];
    if (f && desktop?.git) {
      try {
        changes = (await gitCall((git) => git.fetch(f))).filter((c) => c.count > 0)
          .map((c) => ({ branch: c.branch, count: c.count, isNew: c.from === null }));
      } catch (e) {
        if (!(e instanceof GitAuthError)) throw e;
        // Said once; checking again only after signing in.
        authPaused = true;
        wc.setMessage({ kind: "info", text: `${e.message} New commits can't be fetched until then.`, auth: e.host, retry: () => checkRemote() });
        return;
      }
    } else {
      const here = await readerHere(workspaceId, channelId, current, undefined, mainHost());
      if (!here?.reader.watchBranches) return;
      const result = await here.reader.watchBranches(etag);
      if (!result) return;
      etag = result.etag;
      changes = compareHeads(state.value.branches, result.branches);
    }
    if (!changes.length) return;
    const text = describeChanges(changes);
    if (f) void wc.refresh();
    setRemoteNote(`The remote has changes: ${text}.${f ? " Your branches and files aren't touched; Pull brings them in." : ""}`);
    if (!isLooking(workspaceId, channelId))
      notify({ tag: `git:${workspaceId}:${channelId}:${sub}`, title: `New commits in ${channelName(workspaceId, channelId, sub)}`, body: text,
        onClick: () => openChannel(workspaceId, channelId) });
    await syncQuietly();
  };
  onMount(() => {
    void checkGitHubSignIn();
    void findFolders();
    const notWatched = viewWatching(workspaceId, channelId, sub);
    const stop = repeat(checkRemote, openCheckMs);
    onCleanup(() => { stop(); notWatched(); });
  });

  // After a commit, push, merge or branch change: brings the channel's history up to date without the progress box
  // (members see it; a GitHub/GitLab channel reads the host, so only pushed commits appear).
  const syncQuietly = async () => {
    if (running) return;
    await importLatest(workspaceId, channelId).catch((e) => setNote(`The channel's history wasn't updated: ${userMessage(e)}`));
  };

  // Imports with a reader; shows progress, can be cancelled, reports what went wrong (and returns it). The main
  // repository's first import and its updates bring its submodules along (tree.ts); a submodule's own update looks
  // at it and what is inside it; older commits are only ever this repository's.
  const run = async (reader: RepoReader, mode: "first" | "update" | "older", before?: () => Promise<unknown>): Promise<unknown> => {
    running = new AbortController();
    const signal = running.signal;
    setError("");
    setNote("");
    setProgress({ read: 0, sent: 0 });
    try {
      await before?.();
      let added: number;
      let skipped: Skipped[] = [];
      if (mode === "older") ({ added } = await importRepo(ctx.api, channelId, reader, mode, setProgress, signal, sub));
      else {
        // Read again: setup has just saved the repository.
        const [saved] = await loadRepos(ctx.api, channelId);
        if (!saved) throw new Error("This channel has no repository yet.");
        const result = await importChannel(ctx.api, workspaceId, channelId, saved, reader, mode, setProgress, signal, sub);
        ({ added, skipped } = result);
        showPrepared(result.prepared);
      }
      ctx.playSound("upload-done");
      // Nothing went wrong: a note, not an error (as an error it opened the token box).
      const missed = describeSkipped(skipped, sub);
      if (mode !== "first" && added === 0) setNote([mode === "older" ? "There is nothing older to import." : "Already up to date.", missed].filter(Boolean).join(" "));
      else if (missed) setNote(missed);
      setChanging(false);
      setNeedsToken(null);
      return null;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(userMessage(e));
        ctx.playSound("error");
      }
      return e;
    } finally {
      running = null;
      setProgress(null);
      // Setup may have just picked a folder on this device.
      setFolder(localFolder(workspaceId, channelId, sub));
    }
  };

  const update = async (mode: "update" | "older", token?: string) => {
    const current = repo();
    if (!current) return;
    const here = await readerHere(workspaceId, channelId, current, token, mainHost());
    if (!here) {
      setError("This history came from a folder on another member's device without a link; update it from there.");
      return;
    }
    const failed = await run(here.reader, mode);
    // Only when a token would let it through (the kept one, if any, was refused or can't read it): a member already
    // signed in to GitHub was asked to sign in after every failed update, "Already up to date" included.
    if (failed instanceof RepoAccessError && here.host && !token) {
      setNeedsToken({ host: here.host, reason: error() });
      setNeedAsk((n) => n + 1);
    }
  };

  return (
    <div class="view git mw-fade-in">
      <header class="view-header">
        <Show when={props.repos.length > 1 && !changing()}>
          <Select class="git-repo-pick" label="Repository" value={sub} onChange={props.onShow} search={props.repos.length > 8}
            options={props.repos.map((r) => ({ value: r.subPath, label: repoName(r), icon: r.subPath ? "folder" : "channel-git" }))} />
        </Show>
        <Show when={repo() && !changing()}>
          <Show when={canRelease() && !releasing()}>
            <button class="mw-button mw-box" onClick={openRelease}><Icon name="upload" /> Create release</button>
          </Show>
          <Show when={local()}>
            <SyncBar wc={wc} onChanged={changed} onAttention={() => setPushing(true)} onStashes={() => { setShared(false); setTab("changes"); }} />
          </Show>
          <div class="view-tools mw-box">
            <button class="icon-button" title="Update" aria-label="Update" disabled={!!progress() || !ctx.can("edit_content")}
              onClick={() => void update("update")}><Icon name="refresh" /></button>
            <button class="icon-button" title="Import older commits" aria-label="Import older commits" disabled={!!progress() || !ctx.can("edit_content")}
              onClick={() => void update("older")}><Icon name="history" /></button>
            <button class="icon-button" title="More" aria-label="More" onClick={(e) => ctx.openContextMenu(e, [
              ...(sub === "" ? [
                { label: "Change repository", icon: "rename", disabled: !ctx.can("edit_content"), action: () => setChanging(true) },
                ...(repo()!.provider === "local" ? [] : [{ label: repo()!.subrepos ? "Submodules are imported too" : "Import its submodules too",
                  icon: repo()!.subrepos ? "check" : "folder", disabled: !ctx.can("edit_content") || !!progress(),
                  action: () => void includeSubmodules(!repo()!.subrepos) }]),
                ...(desktop?.git ? [folder()
                  ? { label: "Stop using my local copy here", icon: "folder",
                      action: () => { useFolder(null); setTab("history"); setPushing(false); setResolving(null); } }
                  : { label: "Use my local copy...", icon: "folder", action: () => void linkLocalCopy() }] : []),
              ] : folder() && desktop?.git ? [{ label: "Open its folder", icon: "folder",
                action: () => void desktop!.git!.openFolder(folder()!).catch((error) => setError(userMessage(desktopError(error)))) }] : []),
              ...(githubHere() && githubSignInReady() === true ? (githubUser()
                ? [{ label: `Signed in to GitHub as ${githubUser()}`, icon: "check", disabled: true, action: () => {} },
                    { label: "Sign out of GitHub here", icon: "close", action: () => void forgetConnection("github.com").catch((e) => setError(userMessage(e))) }]
                : [{ label: "Sign in to GitHub...", icon: "channel-git",
                    action: () => setSigningIn({ host: "github.com", reason: "Sign in to GitHub for this repository (MakeWork's own connection).", add: true }) }])
                : []),
              ...(connectionHost() ? [connectionMenu(connectionHost()!)] : []),
              // No release option without a connection that can write: the reason, and the way to get one (for
              // GitHub, unless the sign-in above already offers it).
              ...(target() && !release() && !release.loading ? [
                { label: `Releases need a ${releaseHost(target()!).name} connection that can write here`, icon: "info", disabled: true, action: () => {} },
                ...(target()!.kind === "github" && githubSignInReady() === true && !githubUser() ? []
                  : [{ label: `Connection for releases on ${target()!.host}...`, icon: "add",
                      action: () => setAdding({ reason: "Releases need a connection that can write to this repository.", add: false }) }]),
              ] : []),
              ...(sub === "" ? ["separator" as const,
                { label: "Remove repository", icon: "delete", danger: true, disabled: !ctx.can("edit_content"), action: () => setRemoving(true) }] : []),
            ])}><Icon name="more" /></button>
          </div>
        </Show>
      </header>

      <Show when={local() && !changing() && !releasing() && !resolving()}>
        <nav class="settings-tabs git-tabs mw-scroll-fade-x" aria-label="Version control">
          <For each={tabs}>
            {(t) => (
              <button class="settings-tab" classList={{ active: tab() === t.id }} aria-current={tab() === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            )}
          </For>
          <TabUnderline active={tab()} />
        </nav>
      </Show>
      <Collapse open={local() && !!wc.message()}>
        <div class={`git-status-line mw-box ${wc.message()?.kind ?? ""}`} role="status">
          <span>
            {wc.message()?.text}
            <Show when={wc.message()?.list?.length}>
              <ul class="git-push-commits"><For each={wc.message()!.list!}>{(f) => <li><code>{f}</code></li>}</For></ul>
            </Show>
          </span>
          <Show when={wc.message()?.auth && !signingIn()}>
            <button class="mw-button mw-box accent" onClick={() => {
              const m = wc.message()!;
              setSigningIn({ host: m.auth!, reason: m.text, retry: m.retry });
              wc.setMessage(null);
            }}>{wc.message()!.auth === "github.com" ? "Sign in to GitHub" : `Sign in to ${wc.message()!.auth}`}</button>
          </Show>
          <Show when={wc.message()?.resolve}>
            <button class="mw-button mw-box accent" disabled={!!wc.busy()} onClick={() => {
              setResolving({ target: wc.message()!.resolve!, fromPush: false });
              setPushing(false);
              wc.setMessage(null);
            }}>Resolve conflicts</button>
          </Show>
          <Show when={wc.message()?.stashFirst && wc.message()?.retry}>
            <button class="mw-button mw-box accent" disabled={!!wc.busy()} onClick={() => void stashAndRetry()}>
              <Icon name="box" /> Stash my changes and {againLabel[wc.message()!.action ?? ""] ?? "try"} again
            </button>
          </Show>
          <button class="icon-button" title="Dismiss" aria-label="Dismiss" onClick={() => wc.setMessage(null)}><Icon name="close" /></button>
        </div>
      </Collapse>
      {/* Keyed: each ask gets a fresh prompt. */}
      <Collapse open={!!signingIn()}>
        <Show when={signingIn()} keyed>
          <SignInPrompt host={shownSignIn().host} reason={shownSignIn().reason} submitLabel={shownSignIn().add ? "Use it here" : "Try again with it"}
            current={currentConnection()} adding={shownSignIn().add} onNotSaved={tokenNotSaved}
            onDone={(key, _token, login) => {
              if (key) pickConnection(key);
              signedIn(login);
            }} onCancel={() => setSigningIn(null)} />
        </Show>
      </Collapse>
      <Collapse open={local() && pushing()}>
        <Show when={local() && pushing()}>
          <PushPanel folder={folder()!} onChanged={changed} onClose={() => { setPushing(false); void wc.refresh(); }}
            onAuth={(e, retry) => setSigningIn({ host: e.host, reason: e.message, retry })}
            onResolve={() => { setPushing(false); setResolving({ target: { kind: "pull" }, fromPush: true }); }} />
        </Show>
      </Collapse>
      <div class="git-confirm">
        <ConfirmPrompt open={removing()} question="Remove the repository? Its imported history is deleted for everyone."
          confirmLabel="Remove" onConfirm={remove} onCancel={() => setRemoving(false)} />
      </div>
      {/* The token box carries the failed update's reason itself, so only one box opens there. */}
      <Collapse open={!!error() && !needsToken()}><p class="view-error">{error()}</p></Collapse>
      <Collapse open={!!note()}><p class="hint git-note">{note()}</p></Collapse>
      <Collapse open={!!remoteNote()}>
        <p class="git-remote-note mw-box">
          <Icon name="refresh" /><span>{remoteNote()}</span>
          <button class="icon-button" title="Dismiss" aria-label="Dismiss" onClick={() => setRemoteNote("")}><Icon name="close" /></button>
        </p>
      </Collapse>
      <Collapse open={!!needsToken()}>
        <Show when={needAsk()} keyed>
          <SignInPrompt host={shownNeed().host} reason={`${shownNeed().reason} Another connection may help.`} submitLabel="Update with it"
            current={currentConnection()} onNotSaved={tokenNotSaved} onDone={(key, token) => {
            if (key) pickConnection(key);
            // Swaps with the progress box in place instead of stacking.
            setNeedsToken(null);
            void update("update", token ?? undefined);
          }} />
        </Show>
      </Collapse>
      <Collapse open={!!adding() && !!connectionHost()}>
        <Show when={adding()} keyed>
          <SignInPrompt host={connectionHost() ?? ""} reason={shownAdding().reason} submitLabel="Use it here" current={currentConnection()}
            adding={shownAdding().add}
            onNotSaved={(e) => setNote(`The token couldn't be remembered on this device (${userMessage(e)}), so this channel can't keep using it.`)}
            onCancel={() => setAdding(null)}
            onDone={(key) => {
              if (key) pickConnection(key);
              setAdding(null);
            }} />
        </Show>
      </Collapse>
      <Collapse open={!!progress()}>
        <div class="git-progress mw-box">
          <span>{shownProgress().sent ? `Importing${importing()}: ${shownProgress().sent} of ${shownProgress().read} commits saved`
            : `Reading the history${importing()}: ${shownProgress().read} new commits`}</span>
          <button class="icon-button" title="Stop" aria-label="Stop importing" onClick={() => running?.abort()}><Icon name="close" /></button>
          <ProgressBar value={shownProgress().read ? shownProgress().sent / shownProgress().read : 0} label="Import" />
        </div>
      </Collapse>

      <Switch>
        <Match when={!state.loaded}><Skeleton kind="list" header={false} /></Match>
        <Match when={!repo() || changing()}>
          <Setup context={ctx} busy={!!progress()} onCancel={repo() ? () => setChanging(false) : undefined}
            onLink={(reader, setRepo) => void run(reader, "first", setRepo)}
            onFolder={(reader, setRepo) => void run(reader, "first", setRepo)} onError={setError} onTokenNotSaved={tokenNotSaved} />
        </Match>
        <Match when={releasing() && opened() && repo()}>
          <ReleasePage context={ctx} repo={repo()!} host={opened()!.host} branches={state.value.branches} token={opened()!.token}
            connected={release.loading || canRelease()} onBack={() => setReleasing(false)} onFailed={() => void checkRelease()} />
        </Match>
        <Match when={local() && resolving()}>
          {(r) => (
            <MergeResolver folder={folder()!} wc={wc} target={r().target} onClose={() => setResolving(null)} onDone={() => {
              const back = resolving()?.fromPush;
              setResolving(null);
              changed();
              if (back) setPushing(true);
            }} />
          )}
        </Match>
        <Match when={local() && tab() === "changes"}>
          <Changes folder={folder()!} wc={wc} onCommitted={changed} openSubmodule={openSubmodule} />
        </Match>
        <Match when={local() && tab() === "branches"}>
          <Branches folder={folder()!} defaultBranch={repo()!.defaultBranch} onChanged={changed}
            onAuth={(e, retry) => setSigningIn({ host: e.host, reason: e.message, retry })} />
        </Match>
        <Match when={local() && tab() === "files"}>
          <Files folder={folder()!} onCommit={(sha) => { setShowCommit(sha); setTab("history"); }} openSubmodule={openSubmodule} />
        </Match>
        <Match when={local() && !shared()}>
          <LocalHistory context={ctx} repo={repo()!} mainHost={mainHost()} wc={wc} onShared={() => setShared(true)} onChanged={changed}
            onAttention={() => setPushing(true)} />
        </Match>
        <Match when={repo()}>
          {(r) => <History context={ctx} repo={r()} main={main()} folder={folder()} branches={state.value.branches} onOlder={() => void update("older")} onUpdate={() => void update("update")}
            showCommit={showCommit()} onLocal={local() ? () => setShared(false) : undefined} onShow={props.onShow} />}
        </Match>
      </Switch>
    </div>
  );
}

// Choosing the repository: a GitHub/GitLab link (with one of this member's host connections, or a new token, for
// private ones) or a local folder.
function Setup(props: {
  context: ChannelContext;
  busy: boolean;
  onCancel?: () => void;
  onLink: (reader: RepoReader, setRepo: () => Promise<unknown>) => void;
  onFolder: (reader: RepoReader, setRepo: () => Promise<unknown>) => void;
  onError: (message: string) => void;
  onTokenNotSaved: (e: unknown) => void;
}) {
  const ctx = props.context;
  const [link, setLink] = createSignal("");
  const [name, setName] = createSignal("");
  const [token, setTokenText] = createSignal("");
  const [remember, setRemember] = createSignal(true);
  const [submodules, setSubmodules] = createSignal(true);
  const [storage, setStorage] = createSignal<"encrypted" | "plain" | "none">("encrypted");
  void tokenStorage().then(setStorage, () => setStorage("none"));
  const parsed = () => parseRepoLink(link());
  const allowed = () => ctx.can("edit_content");
  // This member's connections for the link's host; a pick from them, "none" or "new" (a token typed here). Until
  // picked: the one used most recently, else a new token.
  const [saved] = createResource(() => (parsed() ? { host: parsed()!.host, revision: connectionRevision() } : false),
    ({ host }) => connectionsFor(host));
  const known = () => (parsed() ? (saved.latest ?? []).filter((c) => c.host === parsed()!.host) : []);
  const [picked, setPicked] = createSignal<string | null>(null);
  const chosen = () => {
    const p = picked();
    if (p === "new" || p === "none" || known().some((c) => c.key === p)) return p!;
    // A token typed before the saved ones were read stays the choice (it would be hidden and left unused).
    return token().trim() ? "new" : known()[0]?.key ?? "new";
  };

  const submitLink = async (e: SubmitEvent) => {
    e.preventDefault();
    const p = parsed();
    if (!p) return props.onError("That isn't a GitHub or GitLab link.");
    // Unknown hosts are read as a self-hosted GitLab.
    const provider = p.provider ?? "gitlab";
    const pick = chosen();
    const typed = pick === "new" ? token().trim() : "";
    const reader = readerFor({ provider, host: p.host, path: p.path }, pick === "new" ? typed || null : pick === "none" ? null : await getToken(pick));
    props.onLink(reader, async () => {
      const defaultBranch = await reader.defaultBranch();
      // Remembering it is a convenience: the import goes on with the typed token either way.
      let key: string | null = pick === "new" ? null : pick;
      if (typed && remember() && storage() !== "none")
        key = (await addConnection({ host: p.host, provider, token: typed, name: name() }).catch((error) => { props.onTokenNotSaved(error); return null; }))?.key ?? null;
      await ctx.api.call("set-repo", { channel_id: ctx.channel.id, provider, host: p.host, path: p.path, url: p.url, default_branch: defaultBranch,
        subrepos: submodules() });
      // Always a pick: a token used once (or none) must not turn into another saved connection on the next update.
      useConnection(ctx.workspace.id, ctx.channel.id, key ?? "none");
    });
  };

  const pickFolder = async () => {
    try {
      const picked = await desktop!.git!.pickFolder();
      if (!picked) return;
      const reader = readerFor({ provider: "local", host: "", path: picked.path }, null);
      const origin = parseRepoLink(picked.origin);
      props.onFolder(reader, async () => {
        const defaultBranch = await reader.defaultBranch();
        // A folder's submodules always come along.
        await ctx.api.call("set-repo", { channel_id: ctx.channel.id, provider: "local", host: "", path: picked.name, url: origin?.url ?? "", default_branch: defaultBranch,
          subrepos: true });
        setLocalFolder(ctx.workspace.id, ctx.channel.id, picked.path);
      });
    } catch (e) {
      props.onError(userMessage(desktopError(e)));
    }
  };

  return (
    <div class="git-setup mw-fade-in">
      <h3>Connect a repository</h3>
      <p class="hint">Its branches and commit history are imported for everyone in this workspace; nobody else needs access to it.</p>
      <form class="git-setup-form" onSubmit={(e) => void submitLink(e)}>
        <label>
          <span>Link</span>
          <input class="mw-input mw-box" placeholder="https://github.com/owner/repo or git@gitlab.com:group/repo.git" value={link()}
            onInput={(e) => setLink(e.currentTarget.value)} disabled={!allowed()} />
        </label>
        <Show when={parsed()?.provider === null}>
          <p class="hint mw-fade-in">{parsed()!.host} is read as a self-hosted GitLab.</p>
        </Show>
        <Collapse open={!!known().length}>
          <label>
            <span>Connection <span class="muted">(for private repositories)</span></span>
            <Select value={chosen()} label={`Connection for ${parsed()?.host ?? "the host"}`} disabled={!allowed()} onChange={setPicked}
              options={[
                ...known().map((c) => ({ value: c.key, label: c.name, icon: "lock" })),
                { value: "none", label: "No connection (public repository)", icon: "close" },
                { value: "new", label: "New token...", icon: "add" },
              ]} />
          </label>
        </Collapse>
        <Collapse open={chosen() === "new"}>
          <div class="git-setup-token">
            <label>
              <span>Personal access token <span class="muted">(for private repositories)</span></span>
              <input class="mw-input mw-box" type="password" autocomplete="off" value={token()} onInput={(e) => setTokenText(e.currentTarget.value)}
                disabled={!allowed()} />
            </label>
            <p class="hint">
              Read-only is enough. GitHub: a fine-grained token with "Contents: read". GitLab: <code>read_api</code> and <code>read_repository</code>.
              The token stays on this device and is only sent to {parsed()?.host ?? "that host"}.
            </p>
            <Collapse open={!!token().trim() && storage() !== "none"}>
              <label>
                <span>Name <span class="muted">(optional; else the user {parsed()?.host ?? "the host"} says the token is for)</span></span>
                <input class="mw-input mw-box" placeholder="e.g. Work" value={name()} onInput={(e) => setName(e.currentTarget.value)} disabled={!allowed()} />
              </label>
            </Collapse>
            <label class="git-check">
              <input type="checkbox" checked={remember()} disabled={storage() === "none"} onChange={(e) => setRemember(e.currentTarget.checked)} />
              {storage() === "none" ? "Can't remember it: this system has no keychain" : storage() === "plain"
                ? "Remember it in this browser (not encrypted) for other channels" : "Remember it on this device (encrypted) for other channels"}
            </label>
          </div>
        </Collapse>
        <label class="git-check">
          <input type="checkbox" checked={submodules()} disabled={!allowed()} onChange={(e) => setSubmodules(e.currentTarget.checked)} />
          Also import its submodules
        </label>
        <div class="git-setup-buttons">
          <button class="mw-button mw-box accent" type="submit" disabled={props.busy || !parsed() || !allowed()}>Import</button>
          <Show when={desktop?.git}>
            <button class="mw-button mw-box" type="button" disabled={props.busy || !allowed()} onClick={() => void pickFolder()}>
              <Icon name="folder" /> Use a folder on this computer...
            </button>
          </Show>
          <Show when={props.onCancel}>
            <button class="mw-button mw-box" type="button" onClick={() => props.onCancel!()}>Cancel</button>
          </Show>
        </div>
        <Show when={desktop?.git}><p class="hint">A folder's submodules are always imported with it.</p></Show>
        <Show when={!allowed()}><p class="hint warning">You need the "edit content" permission to connect a repository.</p></Show>
      </form>
    </div>
  );
}

function History(props: {
  context: ChannelContext;
  repo: Repo;
  // The channel's main repository (this one, unless it is a submodule).
  main: Repo | null;
  // The working copy on this device, which blame reads.
  folder: string | null;
  branches: { name: string; head: string }[];
  onOlder: () => void;
  onUpdate: () => void;
  showCommit: string | null;
  // Switches back to this computer's graph, when there is a working copy here.
  onLocal?: () => void;
  // Shows another of the channel's repositories.
  onShow: (sub: string) => void;
}) {
  const ctx = props.context;
  const ordered = () => [...props.branches].sort((a, b) =>
    Number(b.name === props.repo.defaultBranch) - Number(a.name === props.repo.defaultBranch) || a.name.localeCompare(b.name));
  // null: all branches together.
  const [branch, setBranch] = createSignal<string | null>(null);
  const [limit, setLimit] = createSignal(pageSize);
  createEffect(() => {
    const name = branch();
    if (name !== null && !props.branches.some((b) => b.name === name)) setBranch(null);
  });
  createEffect(on(branch, () => setLimit(pageSize), { defer: true }));
  const history = createHistory(ctx.api, ctx.channel.id, props.repo.subPath, branch, limit);
  // Branch names by the commit they point at.
  const labels = createMemo(() => {
    const byHead = new Map<string, string[]>();
    for (const h of history.value.heads) byHead.set(h.head, [...(byHead.get(h.head) ?? []), h.name]);
    return byHead;
  });
  // The commit a submodule's parent records for it is marked: its full sha, or the start of one.
  const pinnedHere = (sha: string) => !!props.repo.pinned && sha.startsWith(props.repo.pinned);
  const labelsOf = (sha: string): CommitLabel[] => [
    ...(labels().get(sha) ?? []).map((name): CommitLabel => ({ name, kind: "local", isDefault: name === props.repo.defaultBranch })),
    ...(pinnedHere(sha) ? [{ name: "pinned", kind: "pinned" } as const] : []),
  ];
  const source = () => (props.repo.provider === "local"
    ? `Local folder "${props.repo.path}"${props.folder ? "" : " on another member's device"}`
    : `${props.repo.host}/${props.repo.path}`);
  let list: HTMLOListElement | undefined;
  const [pane, setPane] = createSignal<Pane | null>(null);
  const selected = () => (pane()?.kind === "commit" ? (pane() as { sha: string }).sha : null);

  // Clicking a commit toggles its pane; following a parent or a blame line only opens.
  const select = (sha: string, toggle = false) => {
    if (toggle && selected() === sha) return setPane(null);
    setPane({ kind: "commit", sha });
    list?.querySelector(`[data-sha="${sha}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  createEffect(on(() => props.showCommit, (sha) => sha && select(sha)));

  return (
    <div class="git-body">
      <p class="git-source muted">
        <Icon name={props.repo.provider === "local" ? "folder" : "link"} />
        <span class="git-source-text">
          <Show when={props.repo.subPath && props.main}>
            Submodule <code>{props.repo.subPath}</code> of{" "}
            <button class="git-source-link" onClick={() => props.onShow("")}>{repoName(props.main!)}</button>
            <Show when={props.repo.pinned}>, pinned at <code>{props.repo.pinned.slice(0, 7)}</code></Show>
            {" · "}
          </Show>
          <Show when={props.repo.url} fallback={source()}>
            <a href={props.repo.url} target="_blank" rel="noreferrer">{source()}</a>
          </Show>
          <Show when={props.repo.importedAt}>
            {" · "}imported {relativeTime(props.repo.importedAt)} by {ctx.users.get(props.repo.importedBy).displayName}
          </Show>
        </span>
        <Show when={props.onLocal}>
          <button class="mw-button mw-box" onClick={() => props.onLocal!()}>This computer's graph</button>
        </Show>
      </p>
      <div class="git-columns">
        <nav class="git-branches mw-box mw-scroll-fade" aria-label="Branches">
          <button class="git-branch" classList={{ active: branch() === null }} onClick={() => setBranch(null)}>
            <Icon name="channel-git" /> <span class="git-branch-name">All branches</span>
          </button>
          <For each={ordered()} fallback={
            <div class="view-note">
              <p>{props.repo.provider === "local" ? "This history hasn't been imported yet." : `Nothing from ${props.repo.host} here yet.`}</p>
              <button class="mw-button mw-box" disabled={!ctx.can("edit_content")} onClick={() => props.onUpdate()}><Icon name="refresh" /> Import branches</button>
            </div>
          }>
            {(b) => (
              <button class="git-branch" classList={{ active: b.name === branch() }} onClick={() => setBranch(b.name)} title={b.head}>
                <Icon name="channel-git" />
                <span class="git-branch-name">{b.name}</span>
                <Show when={b.name === props.repo.defaultBranch}><span class="git-default muted">default</span></Show>
              </button>
            )}
          </For>
        </nav>
        <section class="git-commits mw-scroll-fade" aria-label="Commits">
          <Show when={history.loaded} fallback={<Skeleton kind="list" header={false} />}>
            <CommitList rows={history.value.rows} labelsOf={labelsOf} selected={selected()} onSelect={(sha) => select(sha, true)}
              ref={(el) => (list = el)} />
            <Show when={history.value.total > history.value.rows.length}>
              <button class="mw-button mw-box git-more" onClick={() => setLimit(limit() + pageSize)}>Show more</button>
            </Show>
            <Show when={history.value.total <= history.value.rows.length && history.value.truncated}>
              <p class="view-note">
                Older commits aren't imported yet.{" "}
                <button class="mw-button mw-box" disabled={!ctx.can("edit_content")} onClick={() => props.onOlder()}>Import older commits</button>
              </p>
            </Show>
          </Show>
        </section>
        <Show when={pane()}>
          {(open) => (
            <CommitAside context={ctx} repo={props.repo} mainHost={props.main ? hostOf(props.main) : null} pane={open()} setPane={setPane} folder={props.folder}
              commitOf={(sha) => history.value.rows.find((r) => r.sha === sha) ?? null} labelsOf={(sha) => labels().get(sha) ?? []}
              onSelect={(sha) => select(sha)} />
          )}
        </Show>
      </div>
    </div>
  );
}
