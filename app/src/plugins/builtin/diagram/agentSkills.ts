// Agent skills of diagram channels.
import { findChannel } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";
import { addEdges, addShapes, defaultEdgeStyle } from "./data";
import { presets } from "./ends";
import { toShape } from "./model";
import { decodeEmoji } from "../../../markdown/emoji";

const shapeKinds = ["rect", "rounded", "ellipse", "diamond", "parallelogram", "cylinder", "document", "actor", "cloud", "note", "text"];
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
async function page(context: BotContext, channelId: number, create: boolean): Promise<number | null> {
  const pages = (await context.read("diagram", "diagram_pages", { channel_id: channelId })).sort((a, b) => Number(a.z) - Number(b.z));
  if (pages[0]) return Number(pages[0].id);
  if (!create) return null;
  return (await context.write("diagram").call<{ id: number }>("add-page", { channel_id: channelId, name: "Page 1" })).id;
}

export const diagramSkills: AgentSkill[] = [{
  name: "diagram_list",
  description: "Lists the shapes on the first page of a diagram channel.",
  args: { channel: "string" },
  permissions: ["read:diagram"], channelType: "diagram",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "diagram");
    const pageId = await page(context, channel.id, false);
    if (pageId === null) return "The diagram is empty.";
    const shapes = (await context.read("diagram", "diagram_shapes", { page_id: pageId })).filter((r) => r.deleted !== true).map((r) => toShape(r as never));
    return shapes.length ? shapes.map((s) => `${s.kind} "${s.text}" at ${Math.round(s.x)},${Math.round(s.y)}`).join("\n") : "The diagram is empty.";
  },
}, {
  name: "diagram_add_shape",
  description: `Adds a shape with a label to a diagram. Kinds: ${shapeKinds.join(", ")}. x and y are the top left corner, about 200 apart looks neat.`,
  args: { channel: "string", kind: "string", text: "string", x: "number", y: "number" },
  permissions: ["read:diagram", "write:diagram"], channelType: "diagram",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "diagram");
    const kind = shapeKinds.includes(lower(args.kind)) ? lower(args.kind) : "rect";
    const pageId = (await page(context, channel.id, true))!;
    await context.cursor(channel.id, { x: Number(args.x), y: Number(args.y) });
    await addShapes(context.write("diagram"), pageId, [{ kind: kind as never, x: Number(args.x), y: Number(args.y), w: 160, h: 72, text: String(args.text) }]);
    return `Added a ${kind} "${args.text}" to #${channel.name}.`;
  },
}, {
  name: "diagram_connect",
  description: "Draws a connector between two shapes of a diagram, found by their labels. kind: \"\" for a plain arrow, or "
    + `${presets.map((preset) => `${preset.id} (${preset.label})`).join(", ")}. start_label and end_label: the multiplicity or role at each end ("1", "0..*"), "" for none.`,
  args: { channel: "string", from: "string", to: "string", label: "string", kind: "string", start_label: "string", end_label: "string" },
  permissions: ["read:diagram", "write:diagram"], channelType: "diagram",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "diagram");
    const pageId = await page(context, channel.id, false);
    const shapes = pageId === null ? [] : (await context.read("diagram", "diagram_shapes", { page_id: pageId })).filter((r) => r.deleted !== true).map((r) => toShape(r as never));
    const named = (label: unknown) => shapes.find((s) => lower(s.text) === lower(label)) ?? shapes.find((s) => lower(s.text).includes(lower(label)));
    const from = named(args.from);
    const to = named(args.to);
    if (!from || !to) throw new Error(`Shape not found: '${!from ? args.from : args.to}'. Shapes: ${shapes.map((s) => `"${s.text}"`).join(", ") || "none"}.`);
    const kind = String(args.kind ?? "").trim();
    const preset = presets.find((item) => item.id === kind);
    if (kind && !preset) throw new Error(`Unknown connector kind '${kind}'. Kinds: ${presets.map((item) => item.id).join(", ")}.`);
    await addEdges(context.write("diagram"), pageId!, [{
      from_id: from.id, from_port: "c", to_id: to.id, to_port: "c", label: String(args.label ?? ""),
      start_label: String(args.start_label ?? ""), end_label: String(args.end_label ?? ""),
      ...(preset ? { start_arrow: preset.start, end_arrow: preset.end, style: { ...defaultEdgeStyle(), dash: preset.dash } } : {}),
    }]);
    return `Connected "${from.text}" to "${to.text}"${preset ? ` (${preset.label.toLowerCase()})` : ""}.`;
  },
}];


export const diagramIndex: AgentIndexer = {
  permissions: ["read:diagram"], noun: "shapes",
  async items(context, channels) {
    const ids = new Set(channels.map((c) => c.id));
    const pages = new Map((await context.read("diagram", "diagram_pages")).filter((p) => ids.has(Number(p.channel_id))).map((p) => [Number(p.id), Number(p.channel_id)]));
    return (await context.read("diagram", "diagram_shapes")).filter((r) => r.deleted !== true && pages.has(Number(r.page_id)))
      .map((r) => ({ channelId: pages.get(Number(r.page_id))!, id: Number(r.id), label: decodeEmoji(String(r.text ?? "")) || String(r.kind), text: "shape" }));
  },
};
