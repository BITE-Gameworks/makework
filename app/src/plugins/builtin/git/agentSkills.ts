// Agent skills of version control channels: reading the history, and working in the local copy on this device (desktop).
import { trimChars } from "../../../core/text";
import { decodeEmoji } from "../../../markdown/emoji";
import { findChannel } from "../../../agents/skillKit";
import type { AgentSkill, BotContext } from "../../types";
import { desktop } from "../../../core/desktop";
import { pullMessage, pushMessage } from "./actions";
import { localFolder } from "./data";
import { gitCall } from "./local";

const maxCommits = 30;

// The skills' `repo` argument: one of the channel's submodules by its path, "" for its main repository.
const repoArg = "repo: a submodule's path from the main repository's root (e.g. libs/core), empty for the main repository.";
const subOf = (args: Record<string, string | number>) => trimChars(String(args.repo ?? "").trim(), "/");

// The channel's repository, or one of its submodules (`sub`), with the name to call it by in answers.
async function repoOf(context: BotContext, name: string, sub = "") {
  const channel = await findChannel(context, name, "git");
  const repos = await context.read("git", "git_repos", { channel_id: channel.id });
  const repo = repos.find((r) => String(r.sub_path ?? "") === sub);
  if (!repo) {
    if (!sub || !repos.length) throw new Error(`#${channel.name} has no repository connected.`);
    const subs = repos.map((r) => String(r.sub_path ?? "")).filter(Boolean);
    throw new Error(`#${channel.name} has no submodule '${sub}'. Its submodules: ${subs.join(", ") || "none"}.`);
  }
  return { channel, repo, where: sub ? `${sub} in #${channel.name}` : `#${channel.name}` };
}

// The working copy on this device that a git channel was linked to (the host's own; the bot works in it), or a
// submodule's folder inside it.
async function copyOf(context: BotContext, name: string, sub = "") {
  const channel = await findChannel(context, name, "git");
  const git = desktop?.git;
  if (!git) throw new Error("Changing a local copy needs the desktop app on the device that runs this agent.");
  const root = localFolder(context.workspaceId, channel.id);
  if (!root) throw new Error(`#${channel.name} is not linked to a folder on this device. A member has to use "Use my local copy..." in that channel first.`);
  const folder = sub ? localFolder(context.workspaceId, channel.id, sub) : root;
  if (!folder) throw new Error(`The submodule '${sub}' of #${channel.name} isn't checked out on this device (or the channel wasn't opened here since).`);
  return { channel, git, folder, where: sub ? `${sub} in #${channel.name}` : `#${channel.name}` };
}

const diffChars = 3500;

// Pushing sends work to a shared remote with the host's sign-in, so it is done by a member pressing a button.
// Talking to the remote goes through gitCall, which tells main whose sign-in each folder uses (its channel's host
// connection); reading and committing in the folder doesn't need it.
export async function pushLocal(context: BotContext, name: string, sub = ""): Promise<string> {
  const { folder, where } = await copyOf(context, name, sub);
  return pushMessage(await gitCall((git) => git.push(folder))).text.replace(/^/, `${where}: `);
}

export const localGitSkills: AgentSkill[] = [{
  name: "git_changes",
  description: `Shows the uncommitted changes in the local copy of a version control channel (files and what changed) and the latest commit messages, so you can write a fitting commit message. ${repoArg}`,
  args: { channel: "string", repo: "string" },
  permissions: ["read:git"], channelType: "git",
  async run(context, args) {
    const { git, folder, where } = await copyOf(context, String(args.channel), subOf(args));
    const [state, recent] = await Promise.all([git.status(folder), git.graph(folder, { max: 5 }).catch(() => null)]);
    if (!state.files.length) return `${where} (${state.branch ?? "no branch"}): no uncommitted changes.`;
    let patches = "";
    for (const file of state.files.slice(0, 8)) {
      if (patches.length > diffChars) break;
      const diff = await git.workingDiff(folder, file.path).catch(() => null);
      patches += `\n--- ${file.kind} ${file.path}\n${(diff?.patch ?? "").slice(0, 900)}`;
    }
    const last = recent ? `\nRecent commit messages:\n${recent.commits.map((c) => `- ${c.message.split("\n")[0]}`).join("\n")}` : "";
    return `${where} on ${state.branch ?? "no branch"}: ${state.files.length} changed ${state.files.length === 1 ? "file" : "files"}: ${state.files.map((f) => `${f.kind} ${f.path}`).join(", ")}${last}${patches}`;
  },
}, {
  name: "git_commit",
  description: `Commits all uncommitted changes of the local copy with a message you write: a short subject line (under 70 characters, like the recent ones), optionally a blank line and details. Look at git_changes first. ${repoArg}`,
  args: { channel: "string", message: "string", repo: "string" },
  permissions: ["read:git", "write:git"], channelType: "git",
  async run(context, args) {
    const message = String(args.message).trim();
    if (!message) throw new Error("A commit needs a message.");
    const { git, folder, where } = await copyOf(context, String(args.channel), subOf(args));
    const state = await git.status(folder);
    const paths = state.files.filter((f) => f.kind !== "conflicted").map((f) => f.path);
    if (!paths.length) return "There is nothing to commit.";
    const result = await git.commit(folder, { paths, message });
    if (!result.ok) return result.reason === "mass-delete" ? `Not committed: it would delete ${result.deleted} of ${result.total} files. A member must commit that in the git channel.` : "Nothing to commit.";
    return `Committed ${result.sha.slice(0, 7)} in ${where}: ${message.split("\n")[0]}`;
  },
}, {
  name: "git_pull",
  description: `Pulls new commits from the remote into the local copy's current branch (only when it merges cleanly and nothing is uncommitted). ${repoArg}`,
  args: { channel: "string", repo: "string" },
  permissions: ["read:git", "write:git"], channelType: "git",
  async run(context, args) {
    const { folder, where } = await copyOf(context, String(args.channel), subOf(args));
    await gitCall((git) => git.fetch(folder));
    const m = pullMessage(await gitCall((git) => git.merge(folder)));
    // Agents never choose what code to keep; a member resolves the conflicts in the channel.
    const resolve = m.resolve ? " A member can resolve the conflicts in the channel (Resolve conflicts)." : "";
    return `${where}: ${m.text}${m.list?.length ? ` ${m.list.join(", ")}` : ""}${resolve}`;
  },
}, {
  name: "git_push",
  description: `Asks the members to push the current branch: posts a message with a Push button. Agents never push by themselves; a member presses the button. Commit first. ${repoArg}`,
  args: { channel: "string", repo: "string" },
  permissions: ["read:git", "write:git"], channelType: "git",
  async run(context, args, env) {
    const sub = subOf(args);
    const { channel, folder, where } = await copyOf(context, String(args.channel), sub);
    const check = await gitCall((git) => git.pushCheck(folder));
    if (check.state === "up-to-date") return `Nothing to push in ${where}.`;
    if (check.state === "behind" || check.state === "diverged") return `The remote has ${check.behind} new commits ${where} lacks. Pull first.`;
    if (check.uncommitted.length) return `${check.uncommitted.length} changed files are not committed yet; commit them first if they belong in the push.`;
    if (env.channelId === undefined) throw new Error("There is no chat to ask in.");
    await context.post(env.channelId, `Ready to push ${check.ahead || "the"} ${check.ahead === 1 ? "commit" : "commits"} on \`${check.branch}\` of ${where}:\n${check.outgoing.slice(0, 8).map((c) => `- ${c.subject}`).join("\n")}`,
      { threadId: env.threadId ?? null, buttons: [{ label: "Push", command: `/push ${channel.name}${sub ? ` ${sub}` : ""}` }] });
    return "Asked the members to push; it waits for a member to press the button.";
  },
}];

export const gitSkills: AgentSkill[] = [{
  name: "git_branches",
  description: `Shows the repository of a version control channel: where it lives, its default branch, its branches with their head commits, and its submodules. ${repoArg}`,
  args: { channel: "string", repo: "string" },
  permissions: ["read:git"], channelType: "git",
  async run(context, args) {
    const sub = subOf(args);
    const { channel, repo, where } = await repoOf(context, String(args.channel), sub);
    const branches = await context.read("git", "git_branches", { repo_id: Number(repo.id) });
    const inside = (await context.read("git", "git_repos", { channel_id: channel.id }))
      .map((r) => String(r.sub_path ?? "")).filter((path) => path && (sub ? path.startsWith(`${sub}/`) : true)).sort();
    const pinned = repo.pinned ? `, pinned at ${String(repo.pinned).slice(0, 7)}` : "";
    return `${where}: ${repo.provider} ${repo.path}${repo.url ? ` (${repo.url})` : ""}, default branch ${repo.default_branch || "unknown"}${pinned}.\nBranches: `
      + (branches.map((b) => `${b.name} at ${String(b.head).slice(0, 7)}`).join(", ") || "none imported")
      + (inside.length ? `\nSubmodules: ${inside.join(", ")}` : "");
  },
}, {
  name: "git_log",
  description: `Lists the newest imported commits of a version control channel (author, date, first line of the message). branch may be empty for all branches. Shows at most ${maxCommits}. ${repoArg}`,
  args: { channel: "string", branch: "string", repo: "string" },
  permissions: ["read:git"], channelType: "git",
  async run(context, args) {
    const { repo, where } = await repoOf(context, String(args.channel), subOf(args));
    const branch = String(args.branch ?? "").trim();
    let commits = await context.read("git", "git_commits", { repo_id: Number(repo.id) });
    if (branch) {
      const head = (await context.read("git", "git_branches", { repo_id: Number(repo.id) })).find((b) => b.name === branch)?.head;
      if (!head) throw new Error(`There is no branch '${branch}' in ${where}.`);
      const bySha = new Map(commits.map((c) => [String(c.sha), c]));
      const reachable = new Set<string>();
      const stack = [String(head)];
      while (stack.length && reachable.size < 5000) {
        const sha = stack.pop()!;
        if (reachable.has(sha) || !bySha.has(sha)) continue;
        reachable.add(sha);
        stack.push(...String(bySha.get(sha)!.parents ?? "").split(/[\s,]+/).filter(Boolean));
      }
      commits = commits.filter((c) => reachable.has(String(c.sha)));
    }
    const newest = commits.toSorted((a, b) => String(b.authored_at).localeCompare(String(a.authored_at))).slice(0, maxCommits);
    if (!newest.length) return "No commits are imported.";
    return newest.map((c) => `${String(c.sha).slice(0, 7)} ${String(c.authored_at).slice(0, 10)} ${c.author_name}: ${decodeEmoji(String(c.message)).split("\n")[0].slice(0, 100)}`).join("\n");
  },
}];
