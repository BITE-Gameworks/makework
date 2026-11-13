// What an agent can do in a workspace: typed functions the model picks from. The model names a tool and fills its
// arguments (forced to match the schema); code does the lookups and the arithmetic. Each skill needs the bot
// permissions it lists, so an admin decides what an agent may touch.
import { isScratchpadName } from "./scratchpad";
import type { BotContext } from "../plugins/types";

export type { AgentSkill, SkillEnv, SkillResult } from "../plugins/types";

export type Channel = { id: number; name: string; type: string };

// What each channel type holds, for the prompt: the model picks tools by what a channel is for.
export const channelTypeHints: Record<string, string> = {
  chat: "messages", files: "files and folders of any kind", code: "source code files", docs: "pages of text", tasks: "a task board",
  sheets: "spreadsheets", design: "vector design layers", diagram: "diagrams of shapes and connectors",
  git: "a git repository", browser: "a shared web browser", voice: "voice calls",
};

// The bot scratchpad category when the bot may make channels in it: a channel type the workspace lacks can be made there.
export async function scratchpadFor(context: BotContext): Promise<{ id: number; name: string } | null> {
  if (!context.granted("read:channels") || !context.granted("write:channels")) return null;
  const found = (await context.read("channels", "channels_categories").catch(() => [])).find((c) => isScratchpadName(String(c.name)));
  return found ? { id: Number(found.id), name: String(found.name) } : null;
}

// A channel of this type in the scratchpad category: the first one there, or a new one named after the type.
async function scratchpadChannelOf(context: BotContext, type: string): Promise<Channel | null> {
  const category = await scratchpadFor(context);
  if (!category || !(type in channelTypeHints)) return null;
  const existing = (await context.channels()).find((c) => c.type === type && c.category === category.name);
  if (existing) return existing;
  await context.write("channels").call("add-channel", { category_id: category.id, name: type, type });
  return (await context.channels()).find((c) => c.type === type && c.category === category.name) ?? null;
}

const clean = (name: string) => name.trim().replace(/^#/, "").toLowerCase();

// Names that only say which kind of channel ("", "files", "the files channel"), not one channel in particular.
function namesKind(name: string, type: string): boolean {
  const kind = type.replace(/s$/, "");
  return new RegExp(String.raw`^((the|a|my|our)\s+)?(${kind}s?(\s+channel)?)?$`).test(clean(name));
}

// A channel by name. With a type it must be one of that type; when the name only says the kind ("the files
// channel") and the workspace has just one of that type, that one is meant. A specific name that isn't there is
// never taken to mean some other channel.
export async function findChannel(context: BotContext, name: string, type?: string): Promise<Channel> {
  const everything = await context.channels();
  const ofType = everything.filter((c) => !type || c.type === type);
  const found = ofType.filter((c) => clean(c.name) === clean(name));
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new Error(`There are several channels named '${name}'.`);
  const wrong = type ? everything.find((c) => clean(c.name) === clean(name)) : undefined;
  if (wrong) throw new Error(`#${wrong.name} is a ${wrong.type} channel, not a ${type} channel. ${type} channels: ${ofType.map((c) => `#${c.name}`).join(", ") || "none"}.`);
  if (type && ofType.length === 1 && namesKind(name, type)) return ofType[0];
  if (type && ofType.length === 0) {
    const made = await scratchpadChannelOf(context, type);
    if (made) return made;
  }
  throw new Error(`No ${type ?? ""} channel named '${name}'. ${type ? `${type} channels` : "Channels"}: ${ofType.map((c) => `#${c.name}`).join(", ") || "none"}.`);
}

export const clip = (text: string, max = 3000) => (text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]` : text);

// Skills that only look: their results are not echoed in the status note (only what was asked), so reading a
// whole workspace does not fill the chat.
export const isLookup = (name: string): boolean =>
  /(_list|_read|_look|_look_all|_page|_changes|_log|_branches|_overview)$|^(search|recall|web_search|web_read|chat_read|files_read_text|code_read_file)$/.test(name);

// The rows of a table that belong to some channels, not deleted or archived: one read for all of them.
export async function rowsOfChannels(context: BotContext, plugin: string, table: string, channels: { id: number }[]): Promise<Record<string, unknown>[]> {
  const ids = new Set(channels.map((c) => c.id));
  return (await context.read(plugin, table)).filter((r) => r.deleted !== true && !r.archived_at && ids.has(Number(r.channel_id)));
}
