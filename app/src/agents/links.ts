// Makes the text an agent writes carry real links: a channel written as #name becomes a link to it, so the reader
// can click through. Code spans are left alone.
import { linkUrl } from "../core/links";
import type { BotContext } from "../plugins/types";

// Mentions of people are shown as @Name unless they are in `keep`: text an agent quotes must not ping anyone.
export async function withLinks(context: BotContext, text: string, keep: number[] = []): Promise<string> {
  text = text.replace(/<@(\d+)>/g, (whole, id: string) => (keep.includes(Number(id)) ? whole : `@${context.member(Number(id)).displayName}`));
  const channels = await context.channels();
  const byName = new Map(channels.map((c) => [c.name.toLowerCase(), c.id]));
  if (!byName.size) return text;
  return text.split(/(`[^`]*`|\[[^\][]*\]\([^)]*\))/).map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/(?<![\w/&])#([\w-]+)/g, (whole, name: string) => {
      const id = byName.get(name.toLowerCase());
      return id === undefined ? whole : `[#${name}](${linkUrl({ workspaceId: context.workspaceId, channelId: id })})`;
    });
  }).join("");
}
