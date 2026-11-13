// The folder's local branches: which one is checked out, how far each is ahead of or behind the remote, and creating,
// switching and deleting them. Deleting only removes fully merged local branches (electron/gitOps.js `deleteBranch`).
import { For, Show, createResource, createSignal } from "solid-js";
import { userMessage } from "../../../api/client";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import Select from "../../../ui/Select";
import { pushMessage } from "./actions";
import { GitAuthError, gitCall } from "./local";

export default function Branches(props: {
  folder: string;
  defaultBranch: string;
  onChanged: () => void;
  // Publishing needs a sign-in first; `retry` publishes again once signed in.
  onAuth: (e: GitAuthError, retry: () => void) => void;
}) {
  const [list, { refetch }] = createResource(() => props.folder, (folder) => gitCall((git) => git.branchList(folder)));
  const [name, setName] = createSignal("");
  const [from, setFrom] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [note, setNote] = createSignal("");
  const [deleting, setDeleting] = createSignal<string | null>(null);
  const protectedNames = () => [props.defaultBranch, list()?.defaultBranch ?? ""].filter(Boolean);

  const act = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await action();
      setNote(done);
      props.onChanged();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setBusy(false);
      void refetch();
    }
  };
  // A published branch is pushed from the toolbar or the branch menu; this creates it on the remote.
  const publish = async (branch: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const result = await gitCall((git) => git.push(props.folder, { branch }));
      const message = pushMessage(result);
      if (message.kind === "error") setError(message.text);
      else setNote(message.text);
      if (result.ok) props.onChanged();
    } catch (e) {
      if (e instanceof GitAuthError) props.onAuth(e, () => void publish(branch));
      else setError(userMessage(e));
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  const create = (e: SubmitEvent) => {
    e.preventDefault();
    const branch = name().trim();
    const start = from() ?? list()?.current ?? props.defaultBranch;
    void act(() => gitCall((git) => git.createBranch(props.folder, branch, start)), `Created ${branch} from ${start}. Switch to it to work there.`)
      .then(() => !error() && setName(""));
  };

  return (
    <div class="git-branch-manager">
      <Show when={list.error}><p class="view-error">{userMessage(list.error)}</p></Show>
      <ul class="git-local-branches mw-box">
        <For each={list()?.branches ?? []} fallback={<li class="view-note">{list.loading ? "Reading branches..." : "No branches yet."}</li>}>
          {(b) => {
            const current = () => b.name === list()?.current;
            const isDefault = () => protectedNames().includes(b.name);
            return (
              <li class="git-local-branch" classList={{ current: current() }}>
                <Icon name={current() ? "check" : "channel-git"} />
                <span class="git-branch-name">{b.name}</span>
                <Show when={isDefault()}><span class="git-default muted">default</span></Show>
                <span class="git-track muted">
                  <Show when={b.upstream} fallback="not on the remote yet">
                    <Show when={b.gone} fallback={b.ahead || b.behind ? `${b.ahead} to push · ${b.behind} to merge` : "in sync"}>gone from the remote</Show>
                  </Show>
                </span>
                <Show when={!b.upstream}>
                  <button class="mw-button mw-box" disabled={busy()} title="Create this branch on the remote" onClick={() => void publish(b.name)}>
                    <Icon name="upload" /> Publish
                  </button>
                </Show>
                <Show when={!current()}>
                  <button class="mw-button mw-box" disabled={busy()} onClick={() =>
                    void act(() => gitCall((git) => git.switchBranch(props.folder, b.name)), `Switched to ${b.name}.`)}>Switch</button>
                  <Show when={!isDefault()}>
                    <button class="icon-button" title={`Delete ${b.name}`} aria-label={`Delete ${b.name}`} disabled={busy()}
                      onClick={() => setDeleting(deleting() === b.name ? null : b.name)}><Icon name="delete" /></button>
                  </Show>
                </Show>
                <div class="git-branch-confirm">
                  <ConfirmPrompt open={deleting() === b.name} confirmLabel="Delete"
                    question={`Delete the local branch ${b.name}? Only if its commits are merged elsewhere; the remote isn't touched.`}
                    onConfirm={() => {
                      setDeleting(null);
                      void act(() => gitCall((git) => git.deleteBranch(props.folder, b.name, protectedNames())), `Deleted ${b.name}.`);
                    }}
                    onCancel={() => setDeleting(null)} />
                </div>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={list()?.remotes.length}>
        <h4 class="git-pane-section">On origin</h4>
        <ul class="git-local-branches mw-box">
          <For each={list()!.remotes}>
            {(r) => {
              const here = () => list()?.branches.some((b) => b.name === r.name.slice("origin/".length));
              return (
                <li class="git-local-branch">
                  <Icon name="link" />
                  <span class="git-branch-name">{r.name}</span>
                  <Show when={!here()}>
                    <button class="mw-button mw-box" disabled={busy()} onClick={() =>
                      void act(() => gitCall((git) => git.switchBranch(props.folder, r.name)), `Checked out ${r.name.slice("origin/".length)}, following ${r.name}.`)}>
                      Check out
                    </button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <form class="git-new-branch" onSubmit={create}>
        <h4 class="git-pane-section">New branch</h4>
        <div class="git-new-branch-fields">
          <input class="mw-input mw-box" placeholder="feature/my-change" value={name()} onInput={(e) => setName(e.currentTarget.value)} disabled={busy()} />
          <Select label="From" value={from() ?? list()?.current ?? ""} onChange={setFrom} disabled={busy()}
            options={(list()?.branches ?? []).map((b) => ({ value: b.name, label: `from ${b.name}` }))} />
          <button class="mw-button mw-box accent" type="submit" disabled={busy() || !name().trim()}>Create</button>
        </div>
      </form>
      <Collapse open={!!error()}><p class="view-error">{error()}</p></Collapse>
      <Collapse open={!!note()}><p class="hint git-note">{note()}</p></Collapse>
    </div>
  );
}
