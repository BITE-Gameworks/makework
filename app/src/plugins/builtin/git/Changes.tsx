// Uncommitted changes in the folder on this device: tick files, see each one's diff, write a message, commit to the
// current branch, or stash them (put aside) and restore them later. The safety checks are in electron/gitOps.js
// (`commit`, `stashPush`, `stashRestore`); this shows what they say.
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { userMessage } from "../../../api/client";
import type { GitChange, GitStash } from "../../../core/desktop";
import { relativeTime } from "../../../core/time";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import { stashMessage, type ActionMessage } from "./actions";
import { parseUnifiedDiff } from "./diff";
import DiffView from "./DiffView";
import { gitCall } from "./local";
import TypedConfirm from "./TypedConfirm";
import type { WorkingCopy } from "./workingCopy";

const kindLabel: Record<GitChange["kind"], string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "New", conflicted: "Conflict",
};

export default function Changes(props: { folder: string; wc: WorkingCopy; onCommitted: () => void }) {
  const [state, { refetch }] = createResource(() => props.folder, (folder) => gitCall((git) => git.status(folder)));
  // Refreshed when the window comes back, e.g. after editing in another program.
  onMount(() => {
    const again = () => void refetch();
    window.addEventListener("focus", again);
    onCleanup(() => window.removeEventListener("focus", again));
  });
  const files = () => state()?.files ?? [];
  const committable = () => files().filter((f) => f.kind !== "conflicted");
  // Ticked paths; files that are no longer changed drop out.
  const [ticked, setTicked] = createSignal<Set<string>>(new Set());
  const chosen = createMemo(() => committable().filter((f) => ticked().has(f.path)).map((f) => f.path));
  const allTicked = () => committable().length > 0 && chosen().length === committable().length;
  const toggle = (path: string) => {
    const next = new Set(ticked());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setTicked(next);
  };
  const [shown, setShown] = createSignal<string | null>(null);
  const [diff] = createResource(() => shown() && [props.folder, shown()!] as const,
    ([folder, path]) => gitCall((git) => git.workingDiff(folder, path)));

  const [subject, setSubject] = createSignal("");
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [done, setDone] = createSignal("");
  const [confirmMass, setConfirmMass] = createSignal<{ deleted: number; total: number } | null>(null);
  const message = () => [subject().trim(), body().trim()].filter(Boolean).join("\n\n");
  const [includeNew, setIncludeNew] = createSignal(true);

  // Results of stashing and restoring, as the status lines below say them.
  const show = (m: ActionMessage) => {
    setError(m.kind === "error" ? [m.text, ...(m.list ?? [])].join(" ") : "");
    setDone(m.kind === "error" ? "" : m.text);
  };
  const stashAct = async (run: () => Promise<Parameters<typeof stashMessage>[0]>, doing: "stash" | "restore") => {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const result = await run();
      show(stashMessage(result, doing));
      if (result.ok) {
        setTicked(new Set<string>());
        setShown(null);
        props.onCommitted();
      }
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
      void refetch();
      void props.wc.refresh();
    }
  };
  // The ticked files, else everything (new files only with "Include new files"); the summary, if written, names it.
  const stash = () => stashAct(() => gitCall((git) => git.stashPush(props.folder, {
    paths: chosen(), message: subject().trim(), includeUntracked: includeNew(),
  })), "stash");
  const restore = (s: GitStash) => stashAct(() => gitCall((git) => git.stashRestore(props.folder, s.sha)), "restore");
  const remove = async (s: GitStash) => {
    setError("");
    setDone("");
    try {
      await gitCall((git) => git.stashDelete(props.folder, s.sha));
      setDone(`Deleted the stash "${s.message}".`);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      void props.wc.refresh();
    }
  };

  const commit = async (allowMassDelete = false) => {
    setBusy(true);
    setError("");
    setDone("");
    setConfirmMass(null);
    try {
      const result = await gitCall((git) => git.commit(props.folder, { paths: chosen(), message: message(), allowMassDelete }));
      if (result.ok) {
        setDone(`Committed ${chosen().length} ${chosen().length === 1 ? "file" : "files"} as ${result.sha.slice(0, 7)}. Push to share it.`);
        setSubject("");
        setBody("");
        setTicked(new Set<string>());
        setShown(null);
        props.onCommitted();
      } else if (result.reason === "mass-delete") setConfirmMass({ deleted: result.deleted, total: result.total });
      else setError(`Not committed: this would remove every file (${result.total}) from the branch.`);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  return (
    <div class="git-changes">
      <Show when={state()}>
        {(s) => (
          <>
            <Show when={!s().branch}><p class="view-note warning">This copy isn't on a branch (detached HEAD). Switch to a branch to commit.</p></Show>
            <Show when={s().operation}><p class="view-note warning">A {s().operation} is in progress here. Finish it in your git tools first.</p></Show>
          </>
        )}
      </Show>
      <Show when={state.error}><p class="view-error">{userMessage(state.error)}</p></Show>
      <div class="git-changes-columns">
        <section class="git-changes-list mw-box mw-scroll-fade" aria-label="Changed files">
          <header class="git-changes-head">
            <label class="git-check">
              <input type="checkbox" checked={allTicked()} disabled={!committable().length}
                onChange={(e) => setTicked(new Set(e.currentTarget.checked ? committable().map((f) => f.path) : []))} />
              {files().length} changed
            </label>
            <button class="mw-button mw-box" onClick={() => void refetch()} disabled={state.loading}>Refresh</button>
          </header>
          <For each={files()} fallback={<p class="view-note">{state.loading ? "Looking for changes..." : "No changes. Everything is committed."}</p>}>
            {(f) => (
              <div class="git-change" classList={{ shown: shown() === f.path }}>
                <input type="checkbox" checked={ticked().has(f.path)} disabled={f.kind === "conflicted"} onChange={() => toggle(f.path)}
                  aria-label={`Include ${f.path}`} />
                <button class="git-change-name" onClick={() => setShown(shown() === f.path ? null : f.path)} title={f.path}>
                  <span class={`git-status git-status-${f.kind === "untracked" ? "added" : f.kind === "conflicted" ? "deleted" : f.kind}`}>{kindLabel[f.kind]}</span>
                  <span class="git-diff-path">{f.path}</span>
                </button>
              </div>
            )}
          </For>
        </section>
        <section class="git-changes-diff mw-scroll-fade" aria-label="Diff">
          <Show when={shown()} fallback={<p class="view-note">Choose a file to see its changes.</p>}>
            <Show when={!diff.error} fallback={<p class="view-error">{userMessage(diff.error)}</p>}>
              <Show when={diff()} fallback={<p class="view-note">Reading...</p>}>
                {(d) => <DiffView files={parseUnifiedDiff(d().patch)} truncated={d().truncated} empty="No line changes." />}
              </Show>
            </Show>
          </Show>
        </section>
      </div>
      <form class="git-commit-form" onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}>
        <input class="mw-input mw-box" placeholder="Summary of the change (required)" value={subject()} onInput={(e) => setSubject(e.currentTarget.value)}
          maxLength={200} disabled={busy()} />
        <textarea class="mw-input mw-box" placeholder="More details (optional)" rows={3} value={body()} onInput={(e) => setBody(e.currentTarget.value)}
          disabled={busy()} />
        <div class="git-commit-actions">
          <button class="mw-button mw-box accent" type="submit"
            disabled={busy() || !chosen().length || !subject().trim() || !state()?.branch || !!state()?.operation}>
            {busy() ? "Committing..." : `Commit ${chosen().length || ""} ${chosen().length === 1 ? "file" : "files"} to ${state()?.branch ?? "..."}`}
          </button>
          <button class="mw-button mw-box" type="button" onClick={() => void stash()}
            disabled={busy() || !files().length || !!state()?.operation || files().some((f) => f.kind === "conflicted")}
            title="Put these changes aside (the files go back to the last commit); restore them from Stashes below">
            <Icon name="box" /> {chosen().length ? `Stash ${chosen().length} ${chosen().length === 1 ? "file" : "files"}` : "Stash all changes"}
          </button>
          <Show when={!chosen().length}>
            <label class="git-check"><input type="checkbox" checked={includeNew()} onChange={(e) => setIncludeNew(e.currentTarget.checked)} /> Include new files</label>
          </Show>
          <span class="hint">Only ticked files go in. Nothing is pushed until you push.</span>
        </div>
      </form>
      <TypedConfirm open={!!confirmMass()} word={state()?.branch ?? ""} confirmLabel="Commit anyway"
        question={`This commit removes ${confirmMass()?.deleted ?? 0} of the branch's ${confirmMass()?.total ?? 0} files. Are you sure?`}
        onConfirm={() => void commit(true)} onCancel={() => setConfirmMass(null)} />
      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <Collapse open={!!done()}><p class="hint git-note">{done()}</p></Collapse>
      <Collapse open={props.wc.stashes().length > 0}>
        <section class="git-stashes mw-box" aria-label="Stashes">
          <h4 class="git-branch-section">Stashes</h4>
          <For each={props.wc.stashes()}>
            {(s) => <StashRow stash={s} busy={busy()} onRestore={() => void restore(s)} onDelete={() => void remove(s)} />}
          </For>
        </section>
      </Collapse>
    </div>
  );
}

// One stash: what it is, its files on demand, Restore (then it leaves the list) and Delete (asks first).
function StashRow(props: { stash: GitStash; busy: boolean; onRestore: () => void; onDelete: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const count = () => props.stash.files.length;
  return (
    <div class="git-stash">
      <div class="git-stash-line">
        <button class="git-stash-name" onClick={() => setOpen(!open())} aria-expanded={open()} title="Show the files">
          <Icon name={open() ? "expanded" : "collapsed"} />
          <span class="git-stash-message">{props.stash.message}</span>
          <span class="muted">{props.stash.branch ? `on ${props.stash.branch} · ` : ""}{relativeTime(props.stash.time)} · {count()} {count() === 1 ? "file" : "files"}</span>
        </button>
        <button class="mw-button mw-box" disabled={props.busy} onClick={props.onRestore} title="Bring these changes back into the files">Restore</button>
        <button class="icon-button" title="Delete this stash" aria-label="Delete this stash" disabled={props.busy} onClick={() => setDeleting(!deleting())}>
          <Icon name="delete" />
        </button>
      </div>
      <ConfirmPrompt open={deleting()} question="Delete this stash? Its changes are gone for good." confirmLabel="Delete"
        onConfirm={() => { setDeleting(false); props.onDelete(); }} onCancel={() => setDeleting(false)} />
      <Collapse open={open()}>
        <ul class="git-push-commits">
          <For each={props.stash.files}>{(f) => <li><code>{f}</code></li>}</For>
        </ul>
      </Collapse>
    </div>
  );
}
