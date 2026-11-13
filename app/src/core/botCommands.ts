// Commands for bots: "@bot /name args" in a message. The runner (core/bots.ts) and the composer's suggestions share
// this parsing and the list of what each bot offers.
import { cleanBotUsername } from "./botName";
import type { Row } from "../p2p/permissions";
import { botTypeFor } from "../plugins/registry";
import type { BotCommandCall } from "../plugins/types";

export function botPermissionLabel(permission: string): string {
  if (permission === "memory") return "Keep its own data";
  if (permission === "presence") return "See who is online";
  if (permission === "web") return "Search the web and read public pages";
  if (permission === "voice") return "Join voice channels and play sound and pictures in calls";
  if (permission === "spawn") return "Create helper bots";
  if (permission === "write:git") return "Commit and pull in its host's local git copy (pushing needs a member's button)";
  if (permission.startsWith("write:")) return `Change ${permission.slice(6)} data as the bot`;
  return `Read ${permission.slice(5)} data`;
}

export interface ParsedCommand { name: string; args: string }

// The command a message gives this bot: the bot is @ed and the rest starts with "/name". `null` when the bot isn't
// mentioned; an empty name for a bare mention.
export function parseBotCommand(body: string, botUserId: number): ParsedCommand | null {
  const mention = `<@${botUserId}>`;
  if (!body.includes(mention)) return null;
  const rest = body.split(mention).join(" ").trim();
  const match = /^\/([a-z0-9_-]+)\b([\s\S]*)$/i.exec(rest);
  return match ? { name: match[1].toLowerCase(), args: match[2].trim() } : { name: "", args: rest };
}

export function commandArgs(args: string): Pick<BotCommandCall, "args" | "words" | "mentioned"> {
  return {
    args,
    words: args.split(/\s+/).filter(Boolean),
    mentioned: [...args.matchAll(/<@(\d+)>/g)].map((m) => Number(m[1])),
  };
}

export interface BotCommandEntry { botId: number; handle: string; nickname: string; name: string; usage: string; help: string }

// What the enabled bots of a workspace offer, for suggestions while typing "/".
export function commandsOf(rows: Row[]): BotCommandEntry[] {
  return rows.filter((row) => row.status === "enabled").flatMap((row) => {
    const commands = botTypeFor(String(row.type))?.type.commands ?? {};
    return Object.entries(commands).map(([name, c]) => ({
      botId: Number(row.user_id), handle: `${cleanBotUsername(String(row.username))}#${String(row.bot_number)}`, nickname: String(row.nickname),
      name, usage: c.usage, help: c.help,
    }));
  });
}

// Permissions an admin approved when adding the bot (settings key `_permissions`).
export function grantedPermissions(config: Record<string, unknown>): string[] {
  return Array.isArray(config._permissions) ? config._permissions.map(String) : [];
}
