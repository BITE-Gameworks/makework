// The working copy on this device as the view sees it: its branches (with origin's), this computer's graph, whether
// anything is uncommitted, its stashes, and one action at a time (fetch, pull, push, checkout, merge, ...) with a line saying how
// it went. Everything is read again after each action and after the remote watch fetched.
import { createEffect, createSignal, on, type Accessor } from "solid-js";
import { userMessage } from "../../../api/client";
import type { GitBranchList, GitGraph, GitStash } from "../../../core/desktop";
import type { ActionMessage } from "./actions";
import { GitAuthError, gitCall } from "./local";

export const graphPage = 400;

export function createWorkingCopy(folder: Accessor<string | null>) {
  const [branches, setBranches] = createSignal<GitBranchList | null>(null);
  const [graph, setGraph] = createSignal<GitGraph | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [stashes, setStashes] = createSignal<GitStash[]>([]);
  const [limit, setLimit] = createSignal(graphPage);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [message, setMessage] = createSignal<ActionMessage | null>(null);

  let refreshing: Promise<void> | null = null;
  const refresh = (): Promise<void> => (refreshing ??= (async () => {
    const f = folder();
    if (!f) return;
    try {
      const [list, g, state, stashed] = await Promise.all([
        gitCall((git) => git.branchList(f)), gitCall((git) => git.graph(f, { max: limit() })), gitCall((git) => git.status(f)),
        gitCall((git) => git.stashList(f)),
      ]);
      setBranches(list);
      setGraph(g);
      setDirty(state.files.some((file) => file.kind !== "untracked"));
      setStashes(stashed);
    } catch (e) {
      setMessage({ kind: "error", text: userMessage(e) });
    }
  })().finally(() => (refreshing = null)));
  createEffect(on([folder, limit], () => void refresh()));

  // The checked-out branch with its distance to origin (as of the last fetch).
  const current = () => {
    const list = branches();
    return list?.branches.find((b) => b.name === list.current) ?? null;
  };

  // Runs one action at a time; `describe` turns its result into the status line. Reads everything again afterwards.
  // A refusal the user can get past (a sign-in, uncommitted changes to stash) carries `retry`, which runs it again.
  const act = async <T>(label: string, action: (folder: string) => Promise<T>, describe: (result: T) => ActionMessage | null): Promise<T | undefined> => {
    const retry = () => act(label, action, describe);
    const f = folder();
    if (!f || busy()) return undefined;
    setBusy(label);
    setMessage(null);
    try {
      const result = await action(f);
      const said = describe(result);
      setMessage(said?.stashFirst ? { ...said, action: label, retry } : said);
      return result;
    } catch (e) {
      // Signing in (GitView offers it) runs the same action again.
      const text = userMessage(e);
      setMessage(e instanceof GitAuthError ? { kind: "error", text, auth: e.host, retry }
        // Switching branches refuses uncommitted changes this way (gitOps.js `switchBranch`).
        : label === "Checking out" && text.startsWith("Commit your changes first") ? { kind: "error", text, stashFirst: true, action: label, retry }
        : { kind: "error", text });
      return undefined;
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  return { folder, branches, graph, dirty, stashes, limit, setLimit, busy, message, setMessage, refresh, act, current };
}

export type WorkingCopy = ReturnType<typeof createWorkingCopy>;
