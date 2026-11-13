// Setting up a workspace as a tool: make channels and categories, rename them. The policy checks the bot's own roles
// for managing channels, so the permission only lets the admin allow it.
import { channelTypeHints, type AgentSkill } from "./skillKit";
import type { BotContext } from "../plugins/types";
import { trimChars } from "../core/text";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const slug = (name: string) => trimChars(name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-").slice(0, 64);

type Category = { id: number; name: string };

async function categories(context: BotContext): Promise<Category[]> {
  return (await context.read("channels", "channels_categories")).sort((a, b) => Number(a.position) - Number(b.position))
    .map((r) => ({ id: Number(r.id), name: String(r.name) }));
}

// The named category (made when it does not exist yet); without a name the first one, or a new "General".
async function categoryFor(context: BotContext, name: string): Promise<Category> {
  const all = await categories(context);
  const wanted = name.trim();
  const found = wanted ? all.find((c) => lower(c.name) === lower(wanted)) : all[0];
  if (found) return found;
  const created = wanted || "General";
  const { id } = await context.write("channels").call<{ id: number }>("add-category", { name: created });
  return { id, name: created };
}

export const channelSkills: AgentSkill[] = [{
  name: "channels_create",
  description: `Creates a channel of a type (${Object.keys(channelTypeHints).join(", ")}) in a category. The category is made if it does not exist; empty means the first one.`,
  args: { name: "string", type: "string", category: "string" },
  permissions: ["read:channels", "write:channels"],
  async run(context, args) {
    const name = slug(String(args.name));
    const type = lower(args.type);
    if (!name) throw new Error("A channel needs a name.");
    if (!(type in channelTypeHints)) throw new Error(`There is no channel type '${args.type}'. Types: ${Object.keys(channelTypeHints).join(", ")}.`);
    const category = await categoryFor(context, String(args.category));
    const existing = (await context.channels()).some((c) => c.name === name && lower(c.category) === lower(category.name));
    if (existing) return `#${name} already exists in ${category.name}.`;
    await context.write("channels").call("add-channel", { category_id: category.id, name, type });
    return `Created the ${type} channel #${name} in ${category.name}.`;
  },
}, {
  name: "channels_create_category",
  description: "Creates a category (a group of channels). Nothing happens if it exists.",
  args: { name: "string" },
  permissions: ["read:channels", "write:channels"],
  async run(context, args) {
    const name = String(args.name).trim();
    if (!name) throw new Error("A category needs a name.");
    if ((await categories(context)).some((c) => lower(c.name) === lower(name))) return `The category ${name} already exists.`;
    await context.write("channels").call("add-category", { name });
    return `Created the category ${name}.`;
  },
}, {
  name: "channels_rename",
  description: "Renames a channel.",
  args: { channel: "string", name: "string" },
  permissions: ["read:channels", "write:channels"],
  async run(context, args) {
    const from = slug(String(args.channel));
    const matches = (await context.channels()).filter((c) => c.name === from);
    if (matches.length !== 1) throw new Error(matches.length ? `There are several channels named '${args.channel}'.` : `No channel named '${args.channel}'.`);
    const name = slug(String(args.name));
    if (!name) throw new Error("A channel needs a name.");
    await context.write("channels").call("rename-channel", { channel_id: matches[0].id, name });
    return `Renamed #${from} to #${name}.`;
  },
}];
