// Watching version control channels' remotes for new commits, so people know about a change without asking:
// - an open channel checks every 60 s (and when the window comes back): a working copy on this device by fetching
//   (which never touches local branches or files), a GitHub/GitLab channel through its API with ETags;
// - in the background, every 5 minutes, channels with a working copy on this device that aren't open.
// On a change: a note in the view or a desktop notification, and the channel's history is brought up to date.
import { workspaceApi, workspaces } from "../../../core/workspaces";
import { can } from "../../../core/roles";
import { desktop } from "../../../core/desktop";
import { openChannel } from "../../../core/navigation";
import { isLooking, notify } from "../../../core/notifier";
import { loadRepos, readerHere, workingCopies } from "./data";
import { gitCall } from "./local";
import { importChannel } from "./tree";

export const openCheckMs = 60_000;
export const backgroundCheckMs = 5 * 60_000;

export interface RemoteChange {
  branch: string;
  // New commits, when known (a fetch counts them; a host's branch list only says the head moved).
  count: number | null;
  isNew: boolean;
}

// Branches whose head moved, and new ones, between what the channel has and what the remote says.
export function compareHeads(known: { name: string; head: string }[], fresh: { name: string; head: string }[]): RemoteChange[] {
  const before = new Map(known.map((b) => [b.name, b.head]));
  return fresh.filter((b) => before.get(b.name) !== b.head).map((b) => ({ branch: b.name, count: null, isNew: !before.has(b.name) }));
}

export function describeChanges(changes: RemoteChange[]): string {
  return changes.map((c) => c.isNew ? `new branch ${c.branch}`
    : c.count === null ? `new commits on ${c.branch}` : `${c.count} new ${c.count === 1 ? "commit" : "commits"} on ${c.branch}`).join(", ");
}

// Runs `check` every `everyMs` and when the window gets focus (at most every `minGapMs`), never two at once.
export function repeat(check: () => Promise<void>, everyMs: number,
  options: { focus?: EventTarget; minGapMs?: number } = {}): () => void {
  const focus = options.focus ?? (typeof window === "undefined" ? undefined : window);
  const minGapMs = options.minGapMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let stopped = false;
  let last = 0;
  const run = async () => {
    if (checking || stopped) return;
    checking = true;
    clearTimeout(timer);
    try {
      await check();
    } catch (e) {
      console.warn("Watching the repository failed:", e);
    } finally {
      checking = false;
      last = Date.now();
      if (!stopped) timer = setTimeout(() => void run(), everyMs);
    }
  };
  const onFocus = () => {
    if (Date.now() - last >= minGapMs) void run();
  };
  last = Date.now();
  timer = setTimeout(() => void run(), everyMs);
  focus?.addEventListener("focus", onFocus);
  return () => {
    stopped = true;
    clearTimeout(timer);
    focus?.removeEventListener("focus", onFocus);
  };
}

// Brings a channel's history up to date, its submodules' too, if this member may (a GitHub/GitLab channel from the
// host, a local one from the folder on this device); used after a change was seen. Errors are left to the caller.
// `prepare`: missing submodules may be cloned first (an open view; never the background).
export async function importLatest(workspaceId: string, channelId: number, prepare = true): Promise<number> {
  if (!workspaces.byId[workspaceId] || !can(workspaceId, "edit_content")) return 0;
  const api = workspaceApi(workspaceId).plugin("git");
  const [repo] = await loadRepos(api, channelId);
  if (!repo) return 0;
  const here = await readerHere(workspaceId, channelId, repo);
  if (!here) return 0;
  return (await importChannel(api, workspaceId, channelId, repo, here.reader, "update", undefined, undefined, "", prepare)).added;
}

// A repository open in a view checks itself; the background leaves it alone. `sub`: a submodule of the channel's.
const watchedByView = new Set<string>();
const watchKey = (workspaceId: string, channelId: number, sub: string) => `${workspaceId}:${channelId}:${sub}`;
export function viewWatching(workspaceId: string, channelId: number, sub = ""): () => void {
  const key = watchKey(workspaceId, channelId, sub);
  watchedByView.add(key);
  return () => watchedByView.delete(key);
}

// `sub`: one of its submodules, named with it.
export function channelName(workspaceId: string, channelId: number, sub = ""): string {
  const server = workspaces.byId[workspaceId];
  const channel = server?.channels.find((c) => c.id === channelId);
  const name = channel ? `#${channel.name}${server?.info.name ? ` (${server.info.name})` : ""}` : "a version control channel";
  return sub ? `${sub} in ${name}` : name;
}

let started = false;
// Started once from the plugin; only in the desktop app, where working copies exist.
export function startBackgroundWatch(): void {
  if (started || !desktop?.git || typeof window === "undefined") return;
  started = true;
  repeat(async () => {
    // One import per channel and pass, after all of its folders were fetched.
    const changed = new Set<string>();
    for (const { workspaceId, channelId, folder, sub } of workingCopies()) {
      if (watchedByView.has(watchKey(workspaceId, channelId, sub)) || !workspaces.byId[workspaceId]) continue;
      try {
        const changes = (await gitCall((git) => git.fetch(folder))).filter((c) => c.count > 0);
        if (!changes.length) continue;
        const text = describeChanges(changes.map((c) => ({ branch: c.branch, count: c.count, isNew: c.from === null })));
        if (!isLooking(workspaceId, channelId))
          notify({ tag: `git:${workspaceId}:${channelId}:${sub}`, title: `New commits in ${channelName(workspaceId, channelId, sub)}`, body: text,
            onClick: () => openChannel(workspaceId, channelId) });
        changed.add(`${workspaceId}:${channelId}`);
      } catch (e) {
        console.warn(`Watching ${folder} failed:`, e);
      }
    }
    for (const key of changed) {
      const at = key.lastIndexOf(":");
      await importLatest(key.slice(0, at), Number(key.slice(at + 1)), false).catch((e) => console.warn("History not updated:", e));
    }
  }, backgroundCheckMs, { minGapMs: backgroundCheckMs });
}
