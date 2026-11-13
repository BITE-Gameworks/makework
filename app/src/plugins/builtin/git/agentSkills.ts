// Agent skills of version control channels: reading the history, and working in the local copy on this device (desktop).
import { decodeEmoji } from "../../../markdown/emoji";
import { findChannel } from "../../../agents/skillKit";
import type { AgentSkill, BotContext } from "../../types";
import { desktop } from "../../../core/desktop";
import { pullMessage, pushMessage } from "./actions";
import { localFolder } from "./data";
import { gitCall } from "./local";

const maxCommits = 30;

async function repoOf(context: BotContext, name: string) {
  const channel = await findChannel(context, name, "git");
  const [repo] = await context.read("git", "git_repos", { channel_id: channel.id });
  if (!repo) throw new Error(`#${channel.name} has no repository connected.`);
  return { channel, repo };
}

// The working copy on this device that a git channel was linked to (the host's own; the bot works in it).
async function copyOf(context: BotContext, name: string) {
  const channel = await findChannel(context, name, "git");
  const git = desktop?.git;
  if (!git) throw new Error("Changing a local copy needs the desktop app on the device that runs this agent.");
  const folder = localFolder(context.workspaceId, channel.id);
  if (!folder) throw new Error(`#${channel.name} is not linked to a folder on this device. A member has to use "Use my local copy..." in that channel first.`);
  return { channel, git, folder };
}

const diffChars = 3500;

// Pushing sends work to a shared remote with the host's sign-in, so it is done by a member pressing a button.
// Talking to the remote goes through gitCall, which tells main whose sign-in each folder uses (its channel's host
// connection); reading and committing in the folder doesn't need it.
export async function pushLocal(context: BotContext, name: string): Promise<string> {
  const { channel, folder } = await copyOf(context, name);
  return pushMessage(await gitCall((git) => git.push(folder))).text.replace(/^/, `#${channel.name}: `);
}

export const localGitSkills: AgentSkill[] = [{
  name: "git_changes",
  description: "Shows the uncommitted changes in the local copy of a version control channel (files and what changed) and the latest commit messages, so you can write a fitting commit message.",
  args: { channel: "string" },
  permissions: ["read:git"], channelType: "git",
  async run(context, args) {
    const { channel, git, folder } = await copyOf(context, String(args.channel));
    const [state, recent] = await Promise.all([git.status(folder), git.graph(folder, { max: 5 }).catch(() => null)]);
    if (!state.files.length) return `#${channel.name} (${state.branch ?? "no branch"}): no uncommitted changes.`;
    let patches = "";
    for (const file of state.files.slice(0, 8)) {
      if (patches.length > diffChars) break;
      const diff = await git.workingDiff(folder, file.path).catch(() => null);
      patches += `\n--- ${file.kind} ${file.path}\n${(diff?.patch ?? "").slice(0, 900)}`;
    }
    const last = recent ? `\nRecent commit messages:\n${recent.commits.map((c) => `- ${c.message.split("\n")[0]}`).join("\n")}` : "";
    return `#${channel.name} on ${state.branch ?? "no branch"}: ${state.files.length} changed ${state.files.length === 1 ? "file" : "files"}: ${state.files.map((f) => `${f.kind} ${f.path}`).join(", ")}${last}${patches}`;
  },
}, {
  name: "git_commit",
  description: "Commits all uncommitted changes of the local copy with a message you write: a short subject line (under 70 characters, like the recent ones), optionally a blank line and details. Look at git_changes first.",
  args: { channel: "string", message: "string" },
  permissions: ["read:git", "write:git"], channelType: "git",
  async run(context, args) {
    const message = String(args.message).trim();
    if (!message) throw new Error("A commit needs a message.");
    const { channel, git, folder } = await copyOf(context, String(args.channel));
    const state = await git.status(folder);
    const paths = state.files.filter((f) => f.kind !== "conflicted").map((f) => f.path);
    if (!paths.length) return "There is nothing to commit.";
    const result = await git.commit(folder, { paths, message });
    if (!result.ok) return result.reason === "mass-delete" ? `Not committed: it would delete ${result.deleted} of ${result.total} files. A member must commit that in the git channel.` : "Nothing to commit.";
    return `Committed ${result.sha.slice(0, 7)} in #${channel.name}: ${message.split("\n")[0]}`;
  },
}, {
  name: "git_pull",
  description: "Pulls new commits from the remote into the local copy's current branch (only when it merges cleanly and nothing is uncommitted).",
  args: { channel: "string" },
  permissions: ["read:git", "write:git"], channelType: "git",
  async run(context, args) {
    const { channel, folder } = await copyOf(context, String(args.channel));
    await gitCall((git) => git.fetch(folder));
    const m = pullMessage(await gitCall((git) => git.merge(folder)));
    // Agents never choose what code to keep; a member resolves the conflicts in the channel.
    const resolve = m.resolve ? " A member can resolve the conflicts in the channel (Resolve conflicts)." : "";
    return `#${channel.name}: ${m.text}${m.list?.length ? ` ${m.list.join(", ")}` : ""}${resolve}`;
  },
}, {
  name: "git_push",
  description: "Asks the members to push the current branch: posts a message with a Push button. Agents never push by themselves; a member presses the button. Commit first.",
  args: { channel: "string" },
  permissions: ["read:git", "write:git"], channelType: "git",
  async run(context, args, env) {
    const { channel, folder } = await copyOf(context, String(args.channel));
    const check = await gitCall((git) => git.pushCheck(folder));
    if (check.state === "up-to-date") return `Nothing to push in #${channel.name}.`;
    if (check.state === "behind" || check.state === "diverged") return `The remote has ${check.behind} new commits #${channel.name} lacks. Pull first.`;
    if (check.uncommitted.length) return `${check.uncommitted.length} changed files are not committed yet; commit them first if they belong in the push.`;
    if (env.channelId === undefined) throw new Error("There is no chat to ask in.");
    await context.post(env.channelId, `Ready to push ${check.ahead || "the"} ${check.ahead === 1 ? "commit" : "commits"} on \`${check.branch}\` of #${channel.name}:\n${check.outgoing.slice(0, 8).map((c) => `- ${c.subject}`).join("\n")}`,
      { threadId: env.threadId ?? null, buttons: [{ label: "Push", command: `/push ${channel.name}` }] });
    return "Asked the members to push; it waits for a member to press the button.";
  },
}];

export const gitSkills: AgentSkill[] = [{
  name: "git_branches",
  description: "Shows the repository of a version control channel: where it lives, its default branch and its branches with their head commits.",
  args: { channel: "string" },
  permissions: ["read:git"], channelType: "git",
  async run(context, args) {
    const { channel, repo } = await repoOf(context, String(args.channel));
    const branches = await context.read("git", "git_branches", { repo_id: Number(repo.id) });
    return `#${channel.name}: ${repo.provider} ${repo.path}${repo.url ? ` (${repo.url})` : ""}, default branch ${repo.default_branch || "unknown"}.\nBranches: `
      + (branches.map((b) => `${b.name} at ${String(b.head).slice(0, 7)}`).join(", ") || "none imported");
  },
}, {
  name: "git_log",
  description: `Lists the newest imported commits of a version control channel (author, date, first line of the message). branch may be empty for all branches. Shows at most ${maxCommits}.`,
  args: { channel: "string", branch: "string" },
  permissions: ["read:git"], channelType: "git",
  async run(context, args) {
    const { channel, repo } = await repoOf(context, String(args.channel));
    const branch = String(args.branch ?? "").trim();
    let commits = await context.read("git", "git_commits", { repo_id: Number(repo.id) });
    if (branch) {
      const head = (await context.read("git", "git_branches", { repo_id: Number(repo.id) })).find((b) => b.name === branch)?.head;
      if (!head) throw new Error(`There is no branch '${branch}' in #${channel.name}.`);
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
