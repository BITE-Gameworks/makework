// What the version control view offers and says, as plain data: which branch menu items apply (and why the others
// can't now), and what a push, pull or merge result means for the user. The git work itself is electron/gitOps.js.
import type {
  GitBranchMergeResult, GitLocalBranch, GitMergeResult, GitMergeTarget, GitPushResult, GitResolvedResult, GitRevertResult, GitStashResult,
} from "../../../core/desktop";
import { plural } from "../../../core/plural";

export type BranchAction = "checkout" | "new-branch" | "merge-into-current" | "merge-current-into" | "publish" | "push" | "pull" | "delete" | "copy";

export interface MenuState {
  current: string | null;
  defaultBranch: string;
  local: GitLocalBranch[];
  // Uncommitted changes to tracked files.
  dirty: boolean;
  operation: string | null;
  // Another action is running.
  busy: boolean;
}

export type MenuItem = { id: BranchAction; label: string; disabled: boolean } | "separator";

export function branchMenuItems(target: { name: string; kind: "local" | "remote" }, s: MenuState): MenuItem[] {
  const isCurrent = target.kind === "local" && target.name === s.current;
  const local = s.local.find((b) => b.name === target.name);
  // Why a change can't happen right now, if it can't.
  const blocked = s.operation ? `a ${s.operation} is in progress` : s.busy ? "busy" : null;
  const needsClean = blocked ?? (s.dirty ? "commit your changes first" : null);
  const needsBranch = needsClean ?? (s.current ? null : "not on a branch");
  const item = (id: BranchAction, label: string, reason: string | null): MenuItem =>
    ({ id, label: reason ? `${label} (${reason})` : label, disabled: !!reason });
  const items: MenuItem[] = [];
  const localName = target.kind === "remote" ? target.name.slice("origin/".length) : target.name;

  if (!isCurrent) items.push(item("checkout", target.kind === "remote"
    ? `Check out ${localName} (following ${target.name})` : `Check out ${target.name}`, needsClean));
  items.push(item("new-branch", `New branch from ${target.name}...`, blocked));
  if (!isCurrent && s.current) items.push(item("merge-into-current", `Merge ${target.name} into ${s.current}`, needsBranch));
  else if (!isCurrent) items.push(item("merge-into-current", `Merge ${target.name} into the current branch`, "not on a branch"));
  if (target.kind === "local" && !isCurrent && s.current)
    items.push(item("merge-current-into", `Switch to ${target.name} and merge ${s.current} into it`, needsBranch));
  if (target.kind === "local" && local) {
    if (!local.upstream) items.push(item("publish", `Publish ${target.name}`, blocked));
    else if (local.ahead > 0) items.push(item("push", `Push ${target.name} (${plural(local.ahead, "commit")})`, blocked));
    if (isCurrent && local.upstream && local.behind > 0) items.push(item("pull", `Pull ${plural(local.behind, "new commit")}`, needsClean));
    if (!isCurrent && target.name !== s.defaultBranch) items.push(item("delete", `Delete ${target.name}...`, blocked));
  }
  items.push("separator", { id: "copy", label: "Copy name", disabled: false });
  return items;
}

export type CommitAction = "revert-to" | "new-branch" | "copy";

// A commit row's menu. Reverting the current branch to an earlier commit adds a commit with that commit's files
// (electron/gitOps.js `restoreCommit`); it can't apply to the commit the branch is on.
export function commitMenuItems(commit: { sha: string }, s: MenuState & { head: string | null }): { id: CommitAction; label: string; disabled: boolean }[] {
  const blocked = s.operation ? `a ${s.operation} is in progress` : s.busy ? "busy" : null;
  const revertWhy = blocked ?? (!s.current ? "not on a branch" : s.dirty ? "commit your changes first"
    : commit.sha === s.head ? `this is where ${s.current} is` : null);
  const item = (id: CommitAction, label: string, reason: string | null) => ({ id, label: reason ? `${label} (${reason})` : label, disabled: !!reason });
  return [
    item("revert-to", `Revert ${s.current ?? "the branch"} to this commit...`, revertWhy),
    item("new-branch", "New branch from this commit...", blocked),
    item("copy", "Copy commit id", null),
  ];
}

// A result as a line in the status strip; `attention`: the push panel should open with the details.
export interface ActionMessage {
  kind: "ok" | "info" | "error";
  text: string;
  list?: string[];
  attention?: boolean;
  // The remote needs a sign-in to this host first; `retry` runs the action again afterwards.
  auth?: string;
  // Refused for uncommitted changes: they can be stashed, then `retry` runs the action again.
  stashFirst?: boolean;
  // What was being done ("Pulling"), for the stash's message.
  action?: string;
  // The merge would conflict: its conflicts can be resolved here first.
  resolve?: GitMergeTarget;
  retry?: () => Promise<unknown>;
  // A page that settles it, opened in the browser.
  link?: { label: string; url: string };
  // The submodule it is about when that isn't the repository shown (its path from the main repository's root).
  about?: string;
  // The host's own reason for a refusal was looked up already.
  explained?: boolean;
}

// The push panel works on the current branch; for another branch the message says what to do instead.
export function pushMessage(r: GitPushResult): ActionMessage {
  if (r.ok) return r.pushed === 0
    ? { kind: "ok", text: `Published ${r.branch} on the remote.` }
    : { kind: "ok", text: `Pushed ${plural(r.pushed, "commit")} to origin/${r.branch}.` };
  const elsewhere = !r.check.current;
  switch (r.reason) {
    case "up-to-date": return { kind: "info", text: "Nothing to push: the remote already has everything." };
    case "behind": return elsewhere
      ? { kind: "info", text: `The remote has ${plural(r.check.behind, "new commit")} on ${r.check.branch} this copy lacks; check ${r.check.branch} out and pull first.` }
      : { kind: "info", text: `The remote has ${plural(r.check.behind, "new commit")} this copy lacks; pushing is refused until they're merged.`, attention: true };
    case "mass-delete": return elsewhere
      ? { kind: "info", text: `Pushing ${r.check.branch} removes many files; check it out and push from there to confirm.` }
      : { kind: "info", text: "This push removes many files; confirm it in the panel.", attention: true };
    case "empty": return { kind: "error", text: "Not pushed: this would leave the remote branch without any files." };
    case "rejected": return { kind: "error", text: `The remote refused the push; nothing was changed there: ${r.message}` };
  }
}

export function pullMessage(r: GitMergeResult): ActionMessage {
  if (r.ok) return { kind: "ok", text: `Pulled ${plural(r.merged, "new commit")}${r.fastForward ? " (fast-forward)" : " (merged)"}.` };
  switch (r.reason) {
    case "nothing": return { kind: "info", text: "Already up to date with the remote." };
    case "uncommitted": return { kind: "error", text: "Commit or stash your changes first, then pull:", list: r.check.uncommitted, stashFirst: true };
    case "conflicts": return { kind: "error", text: "Not pulled: merging would conflict in these files. Nothing was changed yet:", list: r.check.merge?.conflicts ?? [],
      resolve: { kind: "pull" } };
    case "unknown": return { kind: "error", text: "This version of git can't check for conflicts first; pull with your git tools." };
    case "failed": return { kind: "error", text: `The merge didn't go through and was undone: ${r.message}` };
  }
}

// `target`: how the merge was started, for resolving its conflicts the same way.
export function mergeMessage(r: GitBranchMergeResult, target: GitMergeTarget): ActionMessage {
  if (r.ok) return { kind: "ok", text: `Merged ${r.from} into ${r.into} (${plural(r.merged, "commit")}${r.fastForward ? ", fast-forward" : ""}).` };
  switch (r.reason) {
    case "nothing": return { kind: "info", text: `${r.into} already has everything from ${r.from}.` };
    case "uncommitted": return { kind: "error", text: "Commit or stash your changes first, then merge:", list: r.files, stashFirst: true };
    case "conflicts": return { kind: "error", text: `Not merged: ${r.from} and ${r.into} conflict in these files. Nothing was changed yet:`, list: r.conflicts,
      resolve: target };
    case "unknown": return { kind: "error", text: "This version of git can't check for conflicts first; merge with your git tools." };
    case "failed": return { kind: "error", text: `The merge didn't go through and was undone: ${r.message}` };
  }
}

// A merge made with the member's choice for every conflicted file.
export function resolvedMessage(r: GitResolvedResult): ActionMessage {
  if (r.ok) return { kind: "ok", text: `Merged ${r.from} into ${r.into} with your choices for ${plural(r.resolved, "file")}. Push to share it.` };
  switch (r.reason) {
    case "moved": return { kind: "error", text: `${r.into} has new commits since you started; check the conflicts again.` };
    case "changed": return { kind: "error", text: "The conflicts aren't the same as when you started; check them again." };
    case "empty": return { kind: "error", text: `Not merged: this would leave ${r.into} without any files.` };
    case "uncommitted": return { kind: "error", text: "Commit or stash your changes first, then merge:", list: r.files, stashFirst: true };
    case "failed": return { kind: "error", text: `The merge didn't go through; nothing was changed: ${r.message}` };
  }
}

export function revertMessage(r: GitRevertResult): ActionMessage {
  const short = r.restored.slice(0, 7);
  if (r.ok) return { kind: "ok", text: `Reverted ${r.branch} to ${short} with a new commit (${plural(r.changed, "file")} changed). Push to share it.` };
  switch (r.reason) {
    case "nothing": return { kind: "info", text: `${r.branch} already has exactly the files of ${short}.` };
    case "uncommitted": return { kind: "error", text: "Commit or stash your changes first, then revert:", list: r.files, stashFirst: true };
    case "untracked": return { kind: "error", text: "Not reverted: these files aren't tracked here and would be written over. Move them away first:", list: r.files };
    case "empty": return { kind: "error", text: `Not reverted: ${short} has no files, and a branch is never emptied here.` };
    case "mass-delete": return { kind: "info", text: `Reverting to ${short} removes ${r.deleted} of ${r.total} files; confirm it below.` };
    case "failed": return { kind: "error", text: `The revert didn't go through and was undone: ${r.message}` };
  }
}

// Putting changes aside, and bringing a stash back.
export function stashMessage(r: GitStashResult, doing: "stash" | "restore"): ActionMessage {
  if (r.ok) return doing === "stash"
    ? { kind: "ok", text: `Stashed ${plural(r.files.length, "file")}. They're in Stashes below; restore them when ready.` }
    : { kind: "ok", text: `Restored ${plural(r.files.length, "file")} from the stash.` };
  switch (r.reason) {
    case "nothing": return { kind: "info", text: "There are no changes to stash." };
    case "uncommitted": return { kind: "error", text: "Not restored: these files have changes here that the stash would write over. Commit or stash them first:", list: r.files };
    case "untracked": return { kind: "error", text: "Not restored: these files are already here and would be written over. Move them away first:", list: r.files };
    case "conflicts": return { kind: "error", text: "Not restored: the stash conflicts with what's committed now. Nothing was changed and the stash is kept:", list: r.files };
  }
}
