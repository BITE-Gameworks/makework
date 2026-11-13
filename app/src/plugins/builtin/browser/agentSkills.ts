// Agent skills of shared browser channels.
import { findChannel } from "../../../agents/skillKit";
import type { AgentSkill } from "../../types";

export const browserSkills: AgentSkill[] = [{
  name: "browser_page",
  description: "Says which page a shared browser channel is on and lists its bookmarks.",
  args: { channel: "string" },
  permissions: ["read:browser"], channelType: "browser",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "browser");
    const [page] = await context.read("browser", "browser_pages", { channel_id: channel.id });
    const marks = (await context.read("browser", "browser_bookmarks", { channel_id: channel.id })).filter((b) => b.deleted !== true).sort((a, b) => Number(a.z) - Number(b.z));
    return `#${channel.name} is on ${page?.url ? `${page.title ? `"${page.title}" ` : ""}${page.url}` : "no page"}.\nBookmarks: ${marks.map((b) => `${b.title || b.url} (${b.url})`).join(", ") || "none"}.`;
  },
}, {
  name: "browser_open",
  description: "Sends a shared browser channel to a web address (http or https). Everyone looking at the channel sees the page change.",
  args: { channel: "string", url: "string" },
  permissions: ["read:browser", "write:browser"], channelType: "browser",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "browser");
    await context.write("browser").call("set-page", { channel_id: channel.id, url: String(args.url).trim() });
    return `#${channel.name} now shows ${String(args.url).trim()}.`;
  },
}, {
  name: "browser_bookmark",
  description: "Adds a bookmark to a shared browser channel.",
  args: { channel: "string", url: "string", title: "string" },
  permissions: ["read:browser", "write:browser"], channelType: "browser",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "browser");
    await context.write("browser").call("add-bookmark", { channel_id: channel.id, url: String(args.url).trim(), title: String(args.title) });
    return `Bookmarked ${String(args.title) || String(args.url)} in #${channel.name}.`;
  },
}];
