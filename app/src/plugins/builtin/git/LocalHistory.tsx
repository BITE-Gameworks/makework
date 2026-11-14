// This computer's graph: the working copy's local branches and origin's (fetched automatically by the remote watch),
// with commits that aren't here yet or aren't pushed marked. Right-clicking a branch (in the list or on a label)
// checks it out, starts a new branch from it, merges it in either direction, publishes, pushes or deletes it; every
// change goes through electron/gitOps.js and its checks (never forced, merges only when a dry run is clean).
// Right-clicking a commit reverts the current branch to it with a new commit (nothing in the history is rewritten).
import { copyText } from "../../../core/clipboard";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { GitLocalBranch } from "../../../core/desktop";
import type { MenuEntry } from "../../../ui/contextMenu";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import ConfirmPrompt from "../../../ui/ConfirmPrompt";
import type { ChannelContext } from "../../types";
import { branchMenuItems, commitMenuItems, mergeMessage, pullMessage, pushMessage, revertMessage, type BranchAction } from "./actions";
import CommitAside, { type Pane } from "./CommitAside";
import CommitList, { type CommitLabel } from "./CommitList";
import type { Commit, Repo } from "./data";
import { parseUnifiedDiff } from "./diff";
import { gitCall } from "./local";
import TypedConfirm from "./TypedConfirm";
import { graphPage, type WorkingCopy } from "./workingCopy";

export default function LocalHistory(props: {
  context: ChannelContext;
  repo: Repo;
  wc: WorkingCopy;
  onShared: () => void;
  // After something that changes what the channel's history should show (merges, pushes).
  onChanged: () => void;
  onAttention: () => void;
}) {
  const ctx = props.context;
  const wc = props.wc;
  const folder = () => wc.folder()!;
  const rows = createMemo((): Commit[] => (wc.graph()?.commits ?? []).map((c) => ({
    id: 0, sha: c.sha, parents: c.parents, authorName: c.author_name, authorEmail: c.author_email, authoredAt: c.authored_at, message: c.message,
  })));
  const refsBySha = createMemo(() => new Map((wc.graph()?.commits ?? []).map((c) => [c.sha, c.refs])));
  const incoming = createMemo(() => new Set(wc.graph()?.incoming ?? []));
  const outgoing = createMemo(() => new Set(wc.graph()?.outgoing ?? []));
  const defaultBranch = () => wc.branches()?.defaultBranch ?? props.repo.defaultBranch;
  const labelsOf = (sha: string): CommitLabel[] => (refsBySha().get(sha) ?? []).map((r) => ({
    ...r, isDefault: r.name === defaultBranch() || r.name === `origin/${defaultBranch()}`,
  }));
  const markOf = (sha: string) => (incoming().has(sha) ? "incoming" : outgoing().has(sha) ? "outgoing" : null);

  let list: HTMLOListElement | undefined;
  const [pane, setPane] = createSignal<Pane | null>(null);
  const selected = () => (pane()?.kind === "commit" ? (pane() as { sha: string }).sha : null);
  const select = (sha: string, toggle = false) => {
    if (toggle && selected() === sha) return setPane(null);
    setPane({ kind: "commit", sha });
    list?.querySelector(`[data-sha="${sha}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // A confirm for merges and deletes, and the new branch form, shown above the graph.
  const [confirming, setConfirming] = createSignal<{ question: string; label: string; run: () => void } | null>(null);
  const [creating, setCreating] = createSignal<{ from: string; label: string } | null>(null);
  const [newName, setNewName] = createSignal("");
  const [checkout, setCheckout] = createSignal(true);
  const protectedNames = () => [props.repo.defaultBranch, defaultBranch()].filter(Boolean);

  const run = (id: BranchAction, name: string) => {
    const current = wc.branches()?.current ?? "";
    switch (id) {
      case "checkout":
        return void wc.act("Checking out", (f) => gitCall((git) => git.switchBranch(f, name)), (now) => ({ kind: "ok", text: `Checked out ${now}.` }));
      case "new-branch":
        setNewName("");
        return setCreating({ from: name, label: name });
      case "merge-into-current":
        return setConfirming({
          question: `Merge ${name} into ${current}? Only when it can't conflict; nothing is pushed.`, label: "Merge",
          run: () => void wc.act("Merging", (f) => gitCall((git) => git.mergeBranch(f, name)),
            (r) => { if (r.ok) props.onChanged(); return mergeMessage(r, { kind: "branch", source: name }); }),
        });
      case "merge-current-into":
        return setConfirming({
          question: `Switch to ${name} and merge ${current} into it? Checked for conflicts before switching; nothing is pushed.`, label: "Switch and merge",
          run: () => void wc.act("Merging", (f) => gitCall((git) => git.mergeInto(f, name)),
            (r) => { if (r.ok) props.onChanged(); return mergeMessage(r, { kind: "into", target: name }); }),
        });
      case "publish":
      case "push":
        return void wc.act(id === "publish" ? "Publishing" : "Pushing", (f) => gitCall((git) => git.push(f, { branch: name })), (r) => {
          if (r.ok) props.onChanged();
          const message = pushMessage(r);
          if (message.attention) props.onAttention();
          return message;
        });
      case "pull":
        return void wc.act("Pulling", (f) => gitCall((git) => git.merge(f)), (r) => { if (r.ok) props.onChanged(); return pullMessage(r); });
      case "delete":
        return setConfirming({
          question: `Delete the local branch ${name}? Only if its commits are merged elsewhere; the remote isn't touched.`, label: "Delete",
          run: () => void wc.act("Deleting", (f) => gitCall((git) => git.deleteBranch(f, name, protectedNames())), () => ({ kind: "ok", text: `Deleted ${name}.` })),
        });
      case "copy":
        return void copyText(name);
    }
  };

  const menuState = () => ({
    current: wc.branches()?.current ?? null, defaultBranch: defaultBranch(), local: wc.branches()?.branches ?? [],
    dirty: wc.dirty(), operation: wc.graph()?.head.operation ?? null, busy: !!wc.busy(),
  });
  const branchMenu = (event: MouseEvent, name: string, kind: "local" | "remote") => {
    const state = menuState();
    const entries: MenuEntry[] = branchMenuItems({ name, kind }, state).map((item) => item === "separator" ? "separator" : {
      label: item.label, disabled: item.disabled, danger: item.id === "delete",
      icon: { checkout: "check", "new-branch": "add", "merge-into-current": "download", "merge-current-into": "upload", publish: "upload",
        push: "upload", pull: "download", delete: "delete", copy: "copy" }[item.id],
      action: () => run(item.id, name),
    });
    ctx.openContextMenu(event, entries);
  };
  // Reverting asks first; a big deletion then needs the branch name typed, as commits do.
  const [confirmMass, setConfirmMass] = createSignal<{ sha: string; deleted: number; total: number } | null>(null);
  const revertTo = (sha: string, allowMassDelete = false) => void wc.act("Reverting", (f) => gitCall((git) => git.revertTo(f, sha, { allowMassDelete })), (r) => {
    if (r.ok) props.onChanged();
    if (!r.ok && r.reason === "mass-delete") setConfirmMass({ sha, deleted: r.deleted, total: r.total });
    return revertMessage(r);
  });
  const commitMenu = (event: MouseEvent, commit: Commit) => {
    const state = { ...menuState(), head: wc.graph()?.head.head ?? null };
    const short = commit.sha.slice(0, 7);
    const subject = commit.message.split("\n")[0];
    const run = {
      "revert-to": () => setConfirming({
        question: `Add a commit to ${state.current} that puts every file back as it was at ${short} "${subject}"? The later commits stay in the history; nothing is pushed.`,
        label: "Revert", run: () => revertTo(commit.sha),
      }),
      "new-branch": () => { setNewName(""); setCreating({ from: commit.sha, label: short }); },
      copy: () => void copyText(commit.sha),
    };
    const icons = { "revert-to": "history", "new-branch": "add", copy: "copy" };
    ctx.openContextMenu(event, commitMenuItems(commit, state).map((item) => ({
      label: item.label, disabled: item.disabled, icon: icons[item.id], action: run[item.id],
    })));
  };

  const create = (e: SubmitEvent) => {
    e.preventDefault();
    const target = creating();
    const name = newName().trim();
    if (!target || !name) return;
    const andCheckout = checkout();
    setCreating(null);
    void wc.act("Creating a branch", async (f) => {
      await gitCall((git) => git.createBranch(f, name, target.from));
      if (andCheckout) await gitCall((git) => git.switchBranch(f, name));
      return name;
    }, (n) => ({ kind: "ok", text: `Created ${n} from ${target.label}${andCheckout ? " and checked it out" : ""}. Publish it to share it.` }));
  };

  const track = (b: GitLocalBranch) => !b.upstream ? "not published" : b.gone ? "gone from the remote"
    : b.ahead || b.behind ? `${b.ahead ? `↑${b.ahead}` : ""}${b.ahead && b.behind ? " " : ""}${b.behind ? `↓${b.behind}` : ""}` : "";

  return (
    <div class="git-body">
      <p class="git-source muted">
        <Icon name="folder" />
        <span class="git-source-text">This computer: <code>{folder()}</code>{wc.dirty() ? " · uncommitted changes" : ""}</span>
        <button class="mw-button mw-box" onClick={props.onShared} title="What the other members see, imported into the workspace">Shared history</button>
      </p>
      <div class="git-confirm">
        <ConfirmPrompt open={!!confirming()} question={confirming()?.question ?? ""} confirmLabel={confirming()?.label ?? ""}
          onConfirm={() => {
            const c = confirming();
            setConfirming(null);
            c?.run();
          }}
          onCancel={() => setConfirming(null)} />
        <TypedConfirm open={!!confirmMass()} word={wc.branches()?.current ?? ""} confirmLabel="Revert anyway"
          question={`Reverting removes ${confirmMass()?.deleted ?? 0} of the branch's ${confirmMass()?.total ?? 0} files. Are you sure?`}
          onConfirm={() => {
            const c = confirmMass();
            setConfirmMass(null);
            if (c) revertTo(c.sha, true);
          }}
          onCancel={() => setConfirmMass(null)} />
      </div>
      <Collapse open={!!creating()}>
        <form class="git-new-branch git-new-branch-inline mw-box" onSubmit={create}>
          <span>New branch from <code>{creating()?.label}</code></span>
          <input class="mw-input mw-box" placeholder="feature/my-change" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)}
            ref={(el) => queueMicrotask(() => creating() && el.focus())} />
          <label class="git-check"><input type="checkbox" checked={checkout()} onChange={(e) => setCheckout(e.currentTarget.checked)} /> Check it out</label>
          <button class="mw-button mw-box accent" type="submit" disabled={!newName().trim()}>Create</button>
          <button class="mw-button mw-box" type="button" onClick={() => setCreating(null)}>Cancel</button>
        </form>
      </Collapse>
      <div class="git-columns">
        <nav class="git-branches mw-box mw-scroll-fade" aria-label="Branches">
          <h4 class="git-branch-section">Local</h4>
          <For each={wc.branches()?.branches ?? []} fallback={<p class="view-note">No branches yet.</p>}>
            {(b) => (
              <button class="git-branch" classList={{ active: b.name === wc.branches()?.current }} title={`${b.name} (right-click for actions)`}
                onClick={() => select(b.head)} onContextMenu={(e) => { e.preventDefault(); branchMenu(e, b.name, "local"); }}>
                <Icon name={b.name === wc.branches()?.current ? "check" : "channel-git"} />
                <span class="git-branch-name">{b.name}</span>
                <span class="git-track muted">{track(b)}</span>
              </button>
            )}
          </For>
          <h4 class="git-branch-section">origin</h4>
          <For each={wc.branches()?.remotes ?? []} fallback={<p class="view-note">Nothing fetched yet.</p>}>
            {(r) => (
              <button class="git-branch" title={`${r.name} (right-click for actions)`} onClick={() => select(r.head)}
                onContextMenu={(e) => { e.preventDefault(); branchMenu(e, r.name, "remote"); }}>
                <Icon name="link" />
                <span class="git-branch-name">{r.name}</span>
              </button>
            )}
          </For>
        </nav>
        <section class="git-commits mw-scroll-fade" aria-label="Commits">
          <Show when={wc.graph()} fallback={<p class="view-note">Reading the repository...</p>}>
            <Show when={rows().length} fallback={<p class="view-note">No commits yet.</p>}>
              <CommitList rows={rows()} labelsOf={labelsOf} markOf={markOf} selected={selected()} onSelect={(sha) => select(sha, true)}
                onRowMenu={commitMenu}
                onLabelMenu={(e, label) => label.kind === "local" || label.kind === "remote" ? branchMenu(e, label.name, label.kind) : undefined}
                ref={(el) => (list = el)} />
              <Show when={wc.graph()?.more}>
                <button class="mw-button mw-box git-more" onClick={() => wc.setLimit(wc.limit() + graphPage)}>Show more</button>
              </Show>
            </Show>
          </Show>
        </section>
        <Show when={pane()}>
          {(open) => (
            <CommitAside context={ctx} repo={props.repo} pane={open()} setPane={setPane} folder={folder()}
              commitOf={(sha) => rows().find((r) => r.sha === sha) ?? null}
              labelsOf={(sha) => labelsOf(sha).map((l) => l.name)} onSelect={(sha) => select(sha)}
              diff={async (sha) => {
                const { patch, truncated } = await gitCall((git) => git.show(folder(), sha));
                return { files: parseUnifiedDiff(patch), truncated };
              }} />
          )}
        </Show>
      </div>
    </div>
  );
}
