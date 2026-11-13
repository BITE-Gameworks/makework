import { describe, expect, it } from "vitest";
import {
  branchMenuItems, commitMenuItems, mergeMessage, pullMessage, pushMessage, resolvedMessage, revertMessage, stashMessage, type MenuState,
} from "../../../../src/plugins/builtin/git/actions";

const base: MenuState = {
  current: "main", defaultBranch: "main", dirty: false, operation: null, busy: false,
  local: [
    { name: "main", head: "a", upstream: "origin/main", ahead: 0, behind: 2, gone: false },
    { name: "feature", head: "b", upstream: null, ahead: 0, behind: 0, gone: false },
    { name: "fix", head: "c", upstream: "origin/fix", ahead: 3, behind: 0, gone: false },
  ],
};
const ids = (items: ReturnType<typeof branchMenuItems>) => items.filter((i) => i !== "separator").map((i) => i.id);
const item = (items: ReturnType<typeof branchMenuItems>, id: string) => items.find((i) => i !== "separator" && i.id === id) as { label: string; disabled: boolean };

describe("the branch menu", () => {
  it("offers checkout, new branch, merges both ways, publish and delete on another local branch", () => {
    const items = branchMenuItems({ name: "feature", kind: "local" }, base);
    expect(ids(items)).toEqual(["checkout", "new-branch", "merge-into-current", "merge-current-into", "publish", "delete", "copy"]);
    expect(item(items, "merge-into-current").label).toBe("Merge feature into main");
    expect(item(items, "merge-current-into").label).toBe("Switch to feature and merge main into it");
  });

  it("offers push for a branch ahead of its remote, and pull on the current branch when behind", () => {
    expect(ids(branchMenuItems({ name: "fix", kind: "local" }, base))).toContain("push");
    const current = branchMenuItems({ name: "main", kind: "local" }, base);
    expect(ids(current)).toEqual(["new-branch", "pull", "copy"]);
    expect(item(current, "pull").label).toBe("Pull 2 new commits");
  });

  it("checks out a remote branch as a local one and never deletes on the remote", () => {
    const items = branchMenuItems({ name: "origin/topic", kind: "remote" }, base);
    expect(ids(items)).toEqual(["checkout", "new-branch", "merge-into-current", "copy"]);
    expect(item(items, "checkout").label).toBe("Check out topic (following origin/topic)");
  });

  it("disables what can't happen now, and says why", () => {
    const dirty = branchMenuItems({ name: "feature", kind: "local" }, { ...base, dirty: true });
    expect(item(dirty, "checkout")).toMatchObject({ disabled: true, label: "Check out feature (commit your changes first)" });
    expect(item(dirty, "merge-into-current").disabled).toBe(true);
    expect(item(dirty, "new-branch").disabled).toBe(false);
    const detached = branchMenuItems({ name: "feature", kind: "local" }, { ...base, current: null });
    expect(item(detached, "merge-into-current").disabled).toBe(true);
    const merging = branchMenuItems({ name: "feature", kind: "local" }, { ...base, operation: "merge" });
    expect(ids(merging).every((id) => id === "copy" || item(merging, id).disabled)).toBe(true);
    // The default branch is never offered for deletion.
    expect(ids(branchMenuItems({ name: "main", kind: "local" }, { ...base, current: "feature" }))).not.toContain("delete");
  });
});

describe("what results say", () => {
  const check = {
    branch: "main", current: true, ahead: 1, behind: 1, outgoing: [], incoming: [], uncommitted: [], blocked: null, massDelete: null,
    state: "diverged" as const, merge: { clean: false, conflicts: ["a.ts"] },
  };
  it("explains pushes and when the push panel is needed", () => {
    expect(pushMessage({ ok: true, pushed: 2, branch: "main" })).toEqual({ kind: "ok", text: "Pushed 2 commits to origin/main." });
    expect(pushMessage({ ok: true, pushed: 0, branch: "topic" })).toEqual({ kind: "ok", text: "Published topic on the remote." });
    expect(pushMessage({ ok: false, reason: "behind", check }).attention).toBe(true);
    // Another branch than the current one: no panel, the message says what to do.
    const other = pushMessage({ ok: false, reason: "behind", check: { ...check, branch: "fix", current: false } });
    expect(other).toEqual({ kind: "info", text: "The remote has 1 new commit on fix this copy lacks; check fix out and pull first." });
    expect(pushMessage({ ok: false, reason: "up-to-date", check: { ...check, state: "up-to-date" } }).kind).toBe("info");
  });
  it("explains pulls and merges, listing conflicts", () => {
    expect(pullMessage({ ok: true, merged: 3, fastForward: true })).toEqual({ kind: "ok", text: "Pulled 3 new commits (fast-forward)." });
    expect(pullMessage({ ok: false, reason: "conflicts", check })).toEqual({
      kind: "error", text: "Not pulled: merging would conflict in these files. Nothing was changed yet:", list: ["a.ts"], resolve: { kind: "pull" },
    });
    const branch = { kind: "branch", source: "feature" } as const;
    expect(mergeMessage({ ok: false, reason: "uncommitted", files: ["x.ts"], into: "main", from: "feature" }, branch).list).toEqual(["x.ts"]);
    expect(mergeMessage({ ok: true, merged: 1, fastForward: false, into: "main", from: "feature" }, branch).text).toBe("Merged feature into main (1 commit).");
  });
  it("offers resolving a merge's conflicts, the way it was started", () => {
    const into = { kind: "into", target: "main" } as const;
    expect(mergeMessage({ ok: false, reason: "conflicts", conflicts: ["a.ts"], into: "main", from: "work" }, into)).toEqual({
      kind: "error", text: "Not merged: work and main conflict in these files. Nothing was changed yet:", list: ["a.ts"], resolve: into,
    });
  });
  it("explains a merge made with the member's choices", () => {
    const names = { into: "main", from: "origin/main" };
    expect(resolvedMessage({ ok: true, sha: "s", merged: 2, resolved: 3, ...names }))
      .toEqual({ kind: "ok", text: "Merged origin/main into main with your choices for 3 files. Push to share it." });
    expect(resolvedMessage({ ok: false, reason: "moved", ...names }))
      .toEqual({ kind: "error", text: "main has new commits since you started; check the conflicts again." });
    expect(resolvedMessage({ ok: false, reason: "uncommitted", files: ["x.ts"], ...names }))
      .toEqual({ kind: "error", text: "Commit or stash your changes first, then merge:", list: ["x.ts"], stashFirst: true });
    expect(resolvedMessage({ ok: false, reason: "failed", message: "boom", ...names }).text).toBe("The merge didn't go through; nothing was changed: boom");
  });
});

describe("the commit menu", () => {
  const state = { ...base, head: "h" };
  const revert = (commit: string, s = state) => commitMenuItems({ sha: commit }, s)[0];
  it("reverts the current branch to an earlier commit", () => {
    expect(commitMenuItems({ sha: "x" }, state).map((i) => i.id)).toEqual(["revert-to", "new-branch", "copy"]);
    expect(revert("x")).toEqual({ id: "revert-to", label: "Revert main to this commit...", disabled: false });
  });
  it("says why it can't now", () => {
    expect(revert("h")).toMatchObject({ disabled: true, label: "Revert main to this commit... (this is where main is)" });
    expect(revert("x", { ...state, dirty: true }).label).toMatch(/commit your changes first/);
    expect(revert("x", { ...state, current: null }).label).toMatch(/not on a branch/);
    expect(revert("x", { ...state, operation: "merge" }).disabled).toBe(true);
  });
  it("explains the result", () => {
    const base = { branch: "main", restored: "abcdef1234" };
    expect(revertMessage({ ok: true, sha: "n", changed: 3, ...base }).text).toBe("Reverted main to abcdef1 with a new commit (3 files changed). Push to share it.");
    expect(revertMessage({ ok: false, reason: "untracked", files: ["e.txt"], ...base })).toMatchObject({ kind: "error", list: ["e.txt"] });
    expect(revertMessage({ ok: false, reason: "nothing", ...base }).kind).toBe("info");
  });
});

describe("stash messages", () => {
  it("says what was put aside or brought back, and offers stashing when changes are in the way", () => {
    expect(stashMessage({ ok: true, sha: "s", files: ["a", "b"] }, "stash").text).toMatch(/^Stashed 2 files\./);
    expect(stashMessage({ ok: true, files: ["a"] }, "restore").text).toBe("Restored 1 file from the stash.");
    expect(stashMessage({ ok: false, reason: "conflicts", files: ["a"], message: "" }, "restore")).toMatchObject({ kind: "error", list: ["a"] });
    expect(mergeMessage({ ok: false, reason: "uncommitted", files: ["x.ts"], into: "main", from: "feature" }, { kind: "branch", source: "feature" })
      .stashFirst).toBe(true);
  });
});
