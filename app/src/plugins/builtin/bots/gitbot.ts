import { gitbotLook, butlerName } from "./identity";
import type { BotContext, BotType } from "../../types";

const maxShown = 15;
const showInAnnouncement = 3;
// A larger batch is an import of history, not a push.
const pushLimit = 50;

type Commit = { sha: string; author: string; message: string; at: string; repoId: number };

const toCommit = (row: Record<string, unknown>): Commit => ({
  sha: String(row.sha), author: String(row.author_name ?? ""), message: String(row.message ?? "").split("\n")[0],
  at: String(row.authored_at ?? ""), repoId: Number(row.repo_id),
});

const line = (c: Commit) => `- \`${c.sha.slice(0, 7)}\` ${c.message} (${c.author})`;

// The repo of the channel the command came from, else the only repo (or the first one).
async function repoFor(context: BotContext, channelId: number): Promise<Record<string, unknown> | null> {
  const repos = await context.read("git", "git_repos");
  return repos.find((repo) => Number(repo.channel_id) === channelId) ?? repos[0] ?? null;
}

export const gitbot: BotType = {
  look: gitbotLook,
  randomName: butlerName,
  label: "Git-bot",
  description: "Announces new commits and shows recent ones.",
  permissions: ["read:git"],
  settings: {
    announce: { label: "Announce pushes in (empty: off)", type: "channel" },
  },
  commands: {
    commits: {
      usage: "/commits [n]", help: "Shows the latest commit messages (5 by default, up to 15).",
      run: async (context, call) => {
        const repo = await repoFor(context, call.message.channelId);
        if (!repo) return "No repository has been imported yet.";
        const wanted = Math.min(maxShown, Math.max(1, Number(call.words[0]) || 5));
        const rows = await context.read("git", "git_commits", { repo_id: Number(repo.id) });
        const latest = rows.map(toCommit).sort((a, b) => b.at.localeCompare(a.at)).slice(0, wanted);
        return latest.length ? `**Latest in ${String(repo.path)}**\n${latest.map(line).join("\n")}` : "That repository has no commits yet.";
      },
    },
    branches: {
      usage: "/branches", help: "Lists the branches and where they point.",
      run: async (context, call) => {
        const repo = await repoFor(context, call.message.channelId);
        if (!repo) return "No repository has been imported yet.";
        const rows = await context.read("git", "git_branches", { repo_id: Number(repo.id) });
        const names = rows.map((b) => `- ${String(b.name)}${b.name === repo.default_branch ? " (default)" : ""} \`${String(b.head).slice(0, 7)}\``);
        return names.length ? `**Branches of ${String(repo.path)}**\n${names.slice(0, 20).join("\n")}` : "No branches.";
      },
    },
  },
  start(context) {
    const channel = Number(context.bot.config.announce ?? 0);
    if (!(channel > 0)) return;
    return context.onEvent("git", async (event) => {
      if (event.table !== "git_commits" || event.change !== "insert" || event.ids.length > pushLimit) return;
      try {
        const rows = (await Promise.all(event.ids.map((id) => context.read("git", "git_commits", { id })))).flat().map(toCommit);
        if (!rows.length || !context.inChannel(channel)) return;
        const recent = rows.toSorted((a, b) => b.at.localeCompare(a.at));
        const authors = [...new Set(recent.map((c) => c.author))];
        const more = recent.length > showInAnnouncement ? `\n- and ${recent.length - showInAnnouncement} more` : "";
        await context.send(channel, `**${authors.join(", ")} pushed ${recent.length} commit${recent.length === 1 ? "" : "s"}**\n${recent.slice(0, showInAnnouncement).map(line).join("\n")}${more}`);
      } catch (e) {
        await context.log(`Announcement failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  },
};
