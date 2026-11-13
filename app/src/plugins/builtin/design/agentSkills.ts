// Agent skills of design channels.
import { claimOrBusy } from "../../../agents/locks";
import { linkUrl } from "../../../core/links";
import { designPng } from "./agentRender";
import { findChannel, rowsOfChannels } from "../../../agents/skillKit";
import type { AgentIndexer, AgentSkill, BotContext } from "../../types";
import { addNodes, updateNodes } from "./data";
import { copyProps, pickVariant, syncInstances, variantValues } from "./components";
import { actionLabels, transitionLabels, triggerLabels } from "./prototype";
import {
  boundsOf, cornersOf, defaultProps, interaction, localTransform, solid, stroke, toNode,
  type Action, type Change, type DesignNode, type Direction, type NodeKind, type Transition, type Trigger,
} from "./model";
import { fitPaths, smoothThrough, type Anchor } from "./vector";
import { decodeEmoji } from "../../../markdown/emoji";
import { imageForModel } from "../../../agents/images";
import { llmSeesPictures } from "../../../core/llm";
import { arrange, type Arrangement } from "../canvas/arrange";
import { noteColors, noteNodes, noteSize } from "./notes";

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
export const designSkills: AgentSkill[] = [{
  name: "design_list",
  description: "Lists the layers of a design channel.",
  args: { channel: "string" },
  permissions: ["read:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const nodes = (await context.read("design", "design_nodes", { channel_id: channel.id })).filter((r) => r.deleted !== true).map((r) => toNode(r as never));
    const role = (n: DesignNode) => (n.props.main ? " (component)" : n.props.variantSet ? " (variant set)"
      : n.props.instanceOf !== null ? ` (instance of #${n.props.instanceOf})` : "");
    return nodes.length ? nodes.map((n) => `#${n.id} ${n.kind}${role(n)} "${n.name}" at ${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.width)}x${Math.round(n.height)}`).join("\n") : "The design is empty.";
  },
}, {
  name: "design_add",
  description: "Adds a layer to a design: kind rect, ellipse or text. Color is like #ff8800. For text, name is the text shown.",
  args: { channel: "string", kind: "string", name: "string", x: "number", y: "number", width: "number", height: "number", color: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const kind: NodeKind = ["rect", "ellipse", "text"].includes(lower(args.kind)) ? lower(args.kind) as NodeKind : "rect";
    const color = /^#[0-9a-f]{6}$/i.test(String(args.color).trim()) ? String(args.color).trim() : kind === "text" ? "#000000" : "#d9d9d9";
    const props = defaultProps(kind);
    props.fills = [solid(color)];
    if (kind === "text") props.text = String(args.name);
    await context.cursor(channel.id, { x: Number(args.x), y: Number(args.y) });
    await addNodes(context.write("design"), channel.id, [{
      kind, name: String(args.name).slice(0, 60), x: Number(args.x), y: Number(args.y),
      width: Math.max(8, Number(args.width) || 120), height: Math.max(8, Number(args.height) || 80), props,
    }]);
    return `Added a ${kind} "${args.name}" to #${channel.name}.`;
  },
}];


async function layers(context: BotContext, channelId: number): Promise<DesignNode[]> {
  return (await context.read("design", "design_nodes", { channel_id: channelId })).filter((r) => r.deleted !== true).map((r) => toNode(r as never));
}

// A layer by "#id" (as design_list shows it) or by its name.
function layerNamed(all: DesignNode[], ref: unknown): DesignNode {
  const text = String(ref ?? "").trim();
  const byId = /^#?(\d+)$/.exec(text);
  const found = (byId && all.find((n) => n.id === Number(byId[1]))) || all.filter((n) => lower(n.name) === lower(text));
  if (Array.isArray(found)) {
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error(`Several layers are named '${text}'. Use the #id from design_list.`);
    throw new Error(`No layer '${text}'. Layers: ${all.slice(0, 20).map((n) => `#${n.id} "${n.name}"`).join(", ") || "none"}.`);
  }
  return found;
}

// Reads the layers, claims the ones to change, applies the changes and moves the cursor to the first one.
async function change(context: BotContext, channelName: string, refs: unknown[], make: (nodes: DesignNode[], all: DesignNode[]) => Map<number, Change>) {
  const channel = await findChannel(context, channelName, "design");
  const all = await layers(context, channel.id);
  const nodes = refs.map((ref) => layerNamed(all, ref));
  for (const node of nodes) claimOrBusy(context, channel.id, node.id, `Layer "${node.name}"`);
  const changes = make(nodes, all);
  await context.cursor(channel.id, { x: nodes[0].x + nodes[0].width / 2, y: nodes[0].y + nodes[0].height / 2 });
  await updateNodes(context.write("design"), changes);
  await syncInstances(context.write("design"), channel.id);
  return { channel, nodes };
}

// Common color names, so a model can write "red" as easily as "#ff0000".
const named: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#e03131", orange: "#f08c00", yellow: "#ffd43b", green: "#2f9e44", blue: "#1c7ed6", navy: "#1b2a4a",
  sky: "#74c0fc", teal: "#0ca678", purple: "#7048e8", pink: "#e64980", brown: "#8b5e3c", gray: "#868e96", grey: "#868e96", lightgray: "#dee2e6",
  darkgray: "#343a40", gold: "#fcc419", sand: "#e9d8a6", cream: "#fff9db", silver: "#ced4da", maroon: "#7a1f2b", darkred: "#a61e4d",
  darkblue: "#1864ab", lightblue: "#a5d8ff", darkgreen: "#2b8a3e", lightgreen: "#b2f2bb", lightyellow: "#fff3bf", darkbrown: "#5c3b1e",
};
const hex = (value: unknown) => {
  const text = String(value ?? "").trim().toLowerCase();
  const plain = text.replace(/[^a-z]/g, "");
  if (named[plain]) return named[plain];
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join("")}`;
  if (!/^#[0-9a-f]{6}$/.test(text)) throw new Error(`'${value}' is not a color. Use a name like red or blue, or a code like #ff8800.`);
  return text;
};

export const designChangeSkills: AgentSkill[] = [{
  name: "design_move",
  description: "Moves a layer so its top left corner is at x, y. The layer is a name or the #id from design_list.",
  args: { channel: "string", layer: "string", x: "number", y: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n]) => new Map([[n.id, { x: Number(args.x), y: Number(args.y) }]]));
    return `Moved "${nodes[0].name}" in #${channel.name} to ${Math.round(Number(args.x))},${Math.round(Number(args.y))}.`;
  },
}, {
  name: "design_resize",
  description: "Sets the width and height of a layer. The layer is a name or the #id from design_list.",
  args: { channel: "string", layer: "string", width: "number", height: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n]) => new Map([[n.id, { width: Math.max(1, Number(args.width)), height: Math.max(1, Number(args.height)) }]]));
    return `Resized "${nodes[0].name}" in #${channel.name} to ${Math.round(Number(args.width))}x${Math.round(Number(args.height))}.`;
  },
}, {
  name: "design_set_color",
  description: "Sets the fill color of a layer (text layers: the text color). Color is like #ff8800.",
  args: { channel: "string", layer: "string", color: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const color = hex(args.color);
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n]) => {
      return new Map([[n.id, { props: { ...n.props, fills: [solid(color)] } }]]);
    });
    return `Colored "${nodes[0].name}" in #${channel.name} ${color}.`;
  },
}, {
  name: "design_align",
  description: "Aligns layers to the first one in the list. layers is names or #ids separated by commas. edge: left, right, top, bottom, center (same horizontal middle) or middle (same vertical middle).",
  args: { channel: "string", layers: "string", edge: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const edge = lower(args.edge);
    if (!["left", "right", "top", "bottom", "center", "middle"].includes(edge)) throw new Error("edge must be left, right, top, bottom, center or middle.");
    const refs = String(args.layers).split(",").map((x) => x.trim()).filter(Boolean);
    if (refs.length < 2) throw new Error("Name at least two layers, separated by commas.");
    const { channel, nodes } = await change(context, String(args.channel), refs, ([first, ...rest]) => new Map(rest.map((n): [number, Change] => [n.id,
      edge === "left" ? { x: first.x } : edge === "right" ? { x: first.x + first.width - n.width }
        : edge === "top" ? { y: first.y } : edge === "bottom" ? { y: first.y + first.height - n.height }
          : edge === "center" ? { x: first.x + (first.width - n.width) / 2 } : { y: first.y + (first.height - n.height) / 2 }])));
    return `Aligned ${nodes.length - 1} ${nodes.length === 2 ? "layer" : "layers"} to the ${edge} of "${nodes[0].name}" in #${channel.name}.`;
  },
}];


export const designIndex: AgentIndexer = {
  permissions: ["read:design"], noun: "layers",
  async items(context, channels) {
    return (await rowsOfChannels(context, "design", "design_nodes", channels)).map((r) => ({ channelId: Number(r.channel_id), id: Number(r.id), label: decodeEmoji(String(r.name ?? "")), text: String(r.kind) }));
  },
};

// ---- pen and shapes: drawing with paths. The page's y axis points down; a drawing about 400 to 800 wide fits a screen.
const pointsOf = (text: unknown): { x: number; y: number }[] => {
  const numbers = (String(text ?? "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] });
  return points;
};

const optionalColor = (value: unknown): string | null => {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || text === "none" || text === "-" ? null : hex(text);
};

async function addPath(context: BotContext, channelName: string, name: string, anchors: Anchor[], closed: boolean, line: string | null, fill: string | null, width: number) {
  const channel = await findChannel(context, channelName, "design");
  if (anchors.length < 2) throw new Error("A path needs at least two points, written like \"10,10 90,10 50,80\".");
  const fit = fitPaths([{ points: anchors, closed }]);
  if (!fit) throw new Error("That path has no size.");
  const props = {
    ...defaultProps("path"), vector: fit.vector,
    fills: closed && fill ? [solid(fill)] : [],
    strokes: line ? [stroke(line, "center", Math.max(0.5, Math.min(40, width || 2)))] : [],
  };
  await context.cursor(channel.id, { x: anchors[0].x, y: anchors[0].y });
  await addNodes(context.write("design"), channel.id, [{
    kind: "path", name: name.slice(0, 60) || "Path", x: fit.box.left, y: fit.box.top, width: Math.max(1, fit.vector.w), height: Math.max(1, fit.vector.h), props,
  }]);
  return channel;
}

export const designDrawSkills: AgentSkill[] = [{
  name: "design_draw_path",
  description: "Draws with the pen: a line or shape through points. points is x,y pairs like \"100,100 200,50 300,100\" (y grows downward). closed=1 joins the last point to the first (a filled shape); smooth=1 curves through the points. Colors are like #ff8800 or none. Use it for triangles, stars, roofs, arrows, curves and outlines.",
  args: { channel: "string", name: "string", points: "string", closed: "number", smooth: "number", line_color: "string", fill_color: "string", line_width: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const points = pointsOf(args.points);
    const closed = Number(args.closed) === 1;
    const anchors: Anchor[] = Number(args.smooth) === 1 ? smoothThrough(points, closed) : points.map((p) => ({ x: p.x, y: p.y }));
    const channel = await addPath(context, String(args.channel), String(args.name), anchors, closed, optionalColor(args.line_color), optionalColor(args.fill_color), Number(args.line_width));
    return `Drew "${args.name}" with ${points.length} points in #${channel.name}.`;
  },
}, {
  name: "design_draw_polygon",
  description: "Draws ONE regular polygon (equal sides: triangle, hexagon) or a star centered at x, y; not for rectangles, towers or roofs (use design_draw_scene for those). sides is 3 or more (3 triangle, 5 pentagon, 6 hexagon). star=1 makes a star with that many points. radius is from the center to a corner.",
  args: { channel: "string", name: "string", x: "number", y: "number", radius: "number", sides: "number", star: "number", line_color: "string", fill_color: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const sides = Math.max(3, Math.min(24, Math.round(Number(args.sides) || 3)));
    const radius = Math.max(2, Number(args.radius) || 50);
    const star = Number(args.star) === 1;
    const count = star ? sides * 2 : sides;
    const anchors: Anchor[] = Array.from({ length: count }, (_, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
      const r = star && i % 2 === 1 ? radius * 0.45 : radius;
      return { x: Number(args.x) + Math.cos(angle) * r, y: Number(args.y) + Math.sin(angle) * r };
    });
    const channel = await addPath(context, String(args.channel), String(args.name), anchors, true, optionalColor(args.line_color) ?? "#000000", optionalColor(args.fill_color), 2);
    return `Drew ${star ? `a ${sides}-point star` : `a ${sides}-sided polygon`} "${args.name}" in #${channel.name}.`;
  },
}, {
  name: "design_set_stroke",
  description: "Sets the outline of a layer: color like #ff8800 (or none to remove it) and width in pixels. The layer is a name or the #id from design_list.",
  args: { channel: "string", layer: "string", color: "string", width: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const color = optionalColor(args.color);
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n]) => new Map([[n.id, {
      props: { ...n.props, strokes: color ? [stroke(color, n.kind === "line" || n.kind === "path" ? "center" : "inside", Math.max(0.5, Math.min(40, Number(args.width) || 2)))] : [] },
    }]]));
    return `${color ? `Outlined "${nodes[0].name}" in ${color}` : `Removed the outline of "${nodes[0].name}"`} in #${channel.name}.`;
  },
}];

// ---- groups and exports
const exportFormats = ["png", "jpg", "webp", "svg", "pdf"];

export const designGroupSkills: AgentSkill[] = [{
  name: "design_group",
  description: "Wraps layers in a new group (kind group) or frame (kind frame, which can have a background and clips what sticks out) and names it. layers is names or #ids separated by commas, all at the top level or inside the same group. Group the parts of one object (a logo, a button) so they move and export together.",
  args: { channel: "string", layers: "string", name: "string", kind: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const all = await layers(context, channel.id);
    const refs = String(args.layers).split(",").map((x) => x.trim()).filter(Boolean);
    if (refs.length < 1) throw new Error("Name the layers to group, separated by commas.");
    const nodes = refs.map((ref) => layerNamed(all, ref));
    const parent = nodes[0].parentId;
    if (!nodes.every((n) => n.parentId === parent)) throw new Error("Those layers are in different groups. Pick layers inside the same group.");
    for (const n of nodes) claimOrBusy(context, channel.id, n.id, `Layer "${n.name}"`);
    const kind: NodeKind = lower(args.kind) === "frame" ? "frame" : "group";
    const boxes = nodes.map((n) => boundsOf(cornersOf(localTransform(n), n.width, n.height)));
    const box = boxes.reduce((a, b) => ({
      left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
    }), boxes[0]);
    const props = kind === "frame" ? { ...defaultProps("frame"), fills: [] } : defaultProps("group");
    const [wrapper] = await addNodes(context.write("design"), channel.id, [{
      kind, name: String(args.name).trim().slice(0, 60) || (kind === "frame" ? "Frame" : "Group"), parent_id: parent,
      x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, z: Math.max(...nodes.map((n) => n.z)), props,
    }]);
    await updateNodes(context.write("design"), new Map(nodes.toSorted((a, b) => a.z - b.z).map((n, i): [number, Change] => [n.id, { parentId: wrapper, x: n.x - box.left, y: n.y - box.top, z: i + 1 }])));
    return `Grouped ${nodes.length} ${nodes.length === 1 ? "layer" : "layers"} as ${kind} "${String(args.name).trim() || kind}" (#${wrapper}) in #${channel.name}.`;
  },
}, {
  name: "design_set_export",
  description: `Marks a layer, group or frame to be exported as a picture file. format: ${exportFormats.join(", ")}; scale 1 is the layer's size, 2 is double. A layer with an export is listed in the channel's exports and can be shown in chat.`,
  args: { channel: "string", layer: "string", format: "string", scale: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const format = exportFormats.includes(lower(args.format)) ? lower(args.format) : "png";
    const scale = Math.max(0.5, Math.min(4, Number(args.scale) || 1));
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n]) =>
      new Map([[n.id, { props: { ...n.props, exports: [{ scale, format: format as never, suffix: "" }] } }]]));
    return `"${nodes[0].name}" in #${channel.name} will export as ${format.toUpperCase()} at ${scale}x.`;
  },
}, {
  name: "design_show_in_chat",
  description: "Shows a layer, group or frame as a picture in your answer (a live export that follows later changes). Use it when asked to show, share or post a design or part of it; format is png or svg (png when unsure). The picture is added to your answer for you; do not write a link yourself.",
  args: { channel: "string", layer: "string", format: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const all = await layers(context, channel.id);
    const node = layerNamed(all, args.layer);
    const format = /svg/i.test(String(args.format)) ? "svg" as const : "png" as const;
    if (!node.props.exports.some((e) => e.format === format)) {
      claimOrBusy(context, channel.id, node.id, `Layer "${node.name}"`);
      await updateNodes(context.write("design"), new Map([[node.id, { props: { ...node.props, exports: [{ scale: 1, format, suffix: "" }, ...node.props.exports] } }]]));
    }
    const url = linkUrl({ workspaceId: context.workspaceId, channelId: channel.id, target: { kind: "export", id: node.id } });
    return { text: `"${node.name}" from #${channel.name} is shown in the answer as ${format}. That is all: reply now to finish.`, embeds: [`![${node.name.replace(/[[\]]/g, "")}](${url})`] };
  },
}];

// ---- a whole drawing in one step
const sceneHelp = "One shape per line, fields separated by | , drawn in order (first line at the bottom). Coordinates are pixels, y grows downward, a drawing about 600 wide fits. Lines: "
  + "rect|name|x|y|width|height|fill|outline|corner  ;  ellipse|name|x|y|width|height|fill|outline  ;  triangle|name|x|y|width|height|fill|outline  (pointing up, inside that box: roofs, mountains)  ;  "
  + "trapezoid|name|x|y|width|height|fill|outline|inset  (narrower at the top by inset pixels each side: towers, buckets)  ;  polygon|name|x1,y1 x2,y2 x3,y3 ...|fill|outline  (any other shape from corner points)  ;  "
  + "line|name|x1,y1 x2,y2 ...|color|width  ;  text|name|x|y|size|color|the text. Colors are names (red, white, blue, yellow, black, gray, navy, sky, green, orange, brown) or #rrggbb; use - for no outline or no fill.";

export const designSceneSkills: AgentSkill[] = [{
  name: "design_draw_scene",
  description: `Draws several shapes at once. Plan first: pick one center x (for example 300) and build the object around it, stacking parts from top to bottom so each part starts where the one above ends (its y is the y plus the height above); a tower is a trapezoid, a roof a triangle on top, a lamp a rect or ellipse between them. ${sceneHelp} Example, a house: rect|wall|100|200|200|150|sand|-|0 then polygon|roof|80,200 200,120 320,200|red|- then rect|door|180|280|40|70|brown|-|4.`,
  args: { channel: "string", shapes: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const lines = String(args.shapes).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error(`Write the shapes, one per line. ${sceneHelp}`);
    if (lines.length > 60) throw new Error("Draw at most 60 shapes at a time.");
    const num = (v: string | undefined, fallback = 0) => (Number.isFinite(Number(v)) && v !== undefined && v.trim() !== "" ? Number(v) : fallback);
    const specs: Parameters<typeof addNodes>[2] = [];
    const skipped: string[] = [];
    for (const [index, line] of lines.entries()) {
      const f = line.split("|").map((x) => x.trim());
      const kind = lower(f[0]);
      const label = `line ${index + 1} (${kind})`;
      const name = (f[1] || kind).slice(0, 60);
      try {
        if (kind === "rect" || kind === "ellipse") {
          if (f.length < 7) throw new Error(`needs ${kind}|name|x|y|width|height|fill|outline`);
          const props = defaultProps(kind);
          const fill = optionalColor(f[6]), line_ = optionalColor(f[7]);
          props.fills = fill ? [solid(fill)] : [];
          props.strokes = line_ ? [stroke(line_, "inside", 2)] : [];
          if (kind === "rect") props.radius = Math.max(0, num(f[8]));
          specs.push({ kind, name, x: num(f[2]), y: num(f[3]), width: Math.max(1, num(f[4], 50)), height: Math.max(1, num(f[5], 50)), props });
        } else if (kind === "polygon" || kind === "line" || kind === "triangle" || kind === "trapezoid") {
          // Triangles and trapezoids may also come as corner points (the polygon form), so what follows the shape is read from where it starts.
          const pointsForm = kind === "polygon" || kind === "line" || /\d\s*,\s*\d/.test(f[2] ?? "");
          const colors = pointsForm ? f.slice(3) : f.slice(6);
          const box = { x: num(f[2]), y: num(f[3]), w: Math.max(2, num(f[4], 50)), h: Math.max(2, num(f[5], 50)) };
          const inset = Math.max(0, Math.min(box.w / 2 - 1, num(colors[2], box.w / 6)));
          const points = pointsForm ? pointsOf(f[2])
            : kind === "triangle" ? [{ x: box.x + box.w / 2, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }]
              : [{ x: box.x + inset, y: box.y }, { x: box.x + box.w - inset, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
          if (points.length < 2) throw new Error("needs at least two points like 10,10 90,10 50,80");
          const closed = kind !== "line";
          const fit = fitPaths([{ points: points.map((p) => ({ x: p.x, y: p.y })), closed }])!;
          const first = optionalColor(colors[0]);
          const second = closed ? optionalColor(colors[1]) : null;
          const lineColor = closed ? second : first;
          const props = {
            ...defaultProps("path"), vector: fit.vector,
            fills: closed && first ? [solid(first)] : [],
            strokes: lineColor ? [stroke(lineColor, "center", Math.max(0.5, closed ? 2 : num(colors[1], 3)))] : [],
          };
          specs.push({ kind: "path", name, x: fit.box.left, y: fit.box.top, width: Math.max(1, fit.vector.w), height: Math.max(1, fit.vector.h), props });
        } else if (kind === "text") {
          const size = Math.max(6, Math.min(200, num(f[4], 24)));
          const props = defaultProps("text");
          props.text = f.slice(6).join("|") || name;
          props.textStyle = { ...props.textStyle, size };
          props.fills = [solid((() => { try { return optionalColor(f[5]) ?? "#000000"; } catch { return "#000000"; } })())];
          specs.push({ kind: "text", name, x: num(f[2]), y: num(f[3]), width: Math.max(20, props.text.length * size * 0.6), height: Math.round(size * 1.3), props });
        } else {
          throw new Error("starts with rect, ellipse, polygon, line or text");
        }
      } catch (e) {
        skipped.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!specs.length) throw new Error(`Nothing was drawn. ${skipped.join("; ")}. ${sceneHelp}`);
    await context.cursor(channel.id, { x: specs[0].x, y: specs[0].y });
    // A shape with the name of a layer that is already there replaces it, so a corrected drawing does not pile up copies.
    const existing = await layers(context, channel.id);
    const changes = new Map<number, Change>();
    const fresh: typeof specs = [];
    let replaced = 0;
    for (const spec of specs) {
      const same = existing.filter((n) => n.parentId === null && lower(n.name) === lower(spec.name) && n.kind === spec.kind);
      if (same.length === 1 && !changes.has(same[0].id)) {
        claimOrBusy(context, channel.id, same[0].id, `Layer "${same[0].name}"`);
        changes.set(same[0].id, { x: spec.x, y: spec.y, width: spec.width, height: spec.height, props: spec.props });
        replaced++;
      } else fresh.push(spec);
    }
    if (changes.size) await updateNodes(context.write("design"), changes);
    if (fresh.length) await addNodes(context.write("design"), channel.id, fresh);
    return `Drew ${fresh.length} new shapes${replaced ? ` and replaced ${replaced} with the same name` : ""} in #${channel.name}.${skipped.length ? ` Skipped (draw only these again): ${skipped.join("; ")}.` : ""} Use design_look to check the result.`;
  },
}, {
  name: "design_delete",
  description: "Deletes layers (names or #ids from design_list, separated by commas). Use it only when asked to remove something; a shape drawn again with the same name replaces the old one by itself, so never delete shapes just to draw them again.",
  args: { channel: "string", layers: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const all = await layers(context, channel.id);
    const refs = String(args.layers).split(",").map((x) => x.trim()).filter(Boolean);
    if (!refs.length) throw new Error("Name the layers to delete, separated by commas.");
    const nodes = [...new Map(refs.map((ref) => layerNamed(all, ref)).map((n) => [n.id, n])).values()];
    for (const n of nodes) claimOrBusy(context, channel.id, n.id, `Layer "${n.name}"`);
    await context.write("design").call("remove-nodes", { ids: JSON.stringify(nodes.map((n) => n.id)) });
    await syncInstances(context.write("design"), channel.id);
    return `Deleted ${nodes.length} ${nodes.length === 1 ? "layer" : "layers"} from #${channel.name}: ${nodes.map((n) => n.name).join(", ")}.`;
  },
}, {
  name: "design_look",
  description: "Only when asked to review or fix a drawing: shows you a picture of the whole design channel (costs a lot, do not use it after every drawing). Use it to check a drawing. Fix only what is clearly wrong by drawing that shape again with the same name (it replaces the old one); never delete a shape the user asked for.",
  args: { channel: "string" },
  permissions: ["read:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const all = await layers(context, channel.id);
    if (!all.length) return `#${channel.name} is empty.`;
    return { text: `The design in #${channel.name}: ${all.length} layers: ${all.slice(0, 40).map((n) => `${n.name} (${n.kind}) at ${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.width)}x${Math.round(n.height)}`).join("; ")}.`, images: [await designPng(all)] };
  },
}];

// ---- reference boards: pictures and notes.
const layouts: Record<string, Arrangement> = { optimal: "optimal", grid: "grid", row: "horizontal", column: "vertical" };
const pictures = (all: DesignNode[]) => all.filter((n) => n.kind === "image" && n.url).sort((a, b) => a.z - b.z);

export const designBoardSkills: AgentSkill[] = [{
  name: "design_arrange",
  description: "Arranges layers of a design neatly without overlap: layout optimal (packed tight), grid, row or column. layers is names or #ids separated by commas; leave it empty for every picture on the page.",
  args: { channel: "string", layers: "string", layout: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const how = layouts[lower(args.layout)];
    if (!how) throw new Error("The layout must be optimal, grid, row or column.");
    const channel = await findChannel(context, String(args.channel), "design");
    let refs: unknown[] = String(args.layers ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!refs.length) refs = pictures(await layers(context, channel.id)).filter((n) => n.parentId === null).map((n) => `#${n.id}`);
    if (refs.length < 2) throw new Error("Arranging needs at least two layers (or two pictures on the page).");
    const { nodes } = await change(context, String(args.channel), refs, (picked) => {
      if (new Set(picked.map((n) => n.parentId)).size > 1) throw new Error("Arrange layers that are in the same frame or group.");
      const places = arrange(picked.map((n) => ({ id: n.id, left: n.x, top: n.y, width: n.width, height: n.height })), how);
      return new Map([...places].map(([id, p]): [number, Change] => [id, { x: p.left, y: p.top }]));
    });
    return `Arranged ${nodes.length} layers in #${channel.name} (${lower(args.layout)}).`;
  },
}, {
  name: "design_add_note",
  description: "Adds a sticky note with text to a design, its top left corner at x, y. color is a name like yellow or blue, or a code like #ffe58f; empty for yellow.",
  args: { channel: "string", text: "string", x: "number", y: "number", color: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const color = String(args.color ?? "").trim() ? hex(args.color) : noteColors[0];
    const text = String(args.text ?? "");
    const x = Number(args.x) || 0;
    const y = Number(args.y) || 0;
    await context.cursor(channel.id, { x: x + noteSize.width / 2, y: y + noteSize.height / 2 });
    const name = `Note: ${text.split(/\s+/).slice(0, 4).join(" ")}`.slice(0, 60);
    await addNodes(context.write("design"), channel.id, noteNodes(name, null, { x, y, ...noteSize, rotation: 0 }, text, color));
    return `Added a note to #${channel.name}.`;
  },
}, {
  name: "design_look_picture",
  description: "Looks at one picture layer of a design (by its #id or name) and shows it to you.",
  args: { channel: "string", layer: "string" },
  permissions: ["read:design"], channelType: "design",
  async run(context, args, env) {
    if (!(await llmSeesPictures(env.server))) throw new Error("The model on this server can't see pictures.");
    const channel = await findChannel(context, String(args.channel), "design");
    const node = layerNamed(pictures(await layers(context, channel.id)), args.layer);
    await context.cursor(channel.id, { x: node.x + node.width / 2, y: node.y + node.height / 2 });
    return { text: `Here is #${node.id} ${node.name}.`, images: [await imageForModel(node.url!, "", node.thumb, env.imageSide)] };
  },
}, {
  name: "design_look_pictures",
  description: "Looks at up to six picture layers of a design at once and shows them to you, bottom layer first.",
  args: { channel: "string" },
  permissions: ["read:design"], channelType: "design",
  async run(context, args, env) {
    if (!(await llmSeesPictures(env.server))) throw new Error("The model on this server can't see pictures.");
    const channel = await findChannel(context, String(args.channel), "design");
    const shown = pictures(await layers(context, channel.id)).slice(0, 6);
    if (!shown.length) return `#${channel.name} has no pictures.`;
    const side = Math.max(192, Math.round(env.imageSide * 0.6));
    const images: string[] = [];
    for (const node of shown) {
      await context.cursor(channel.id, { x: node.x + node.width / 2, y: node.y + node.height / 2 }, 150);
      images.push(await imageForModel(node.url!, "", node.thumb, side));
    }
    return { text: `The ${shown.length} pictures in order: ${shown.map((n, i) => `${i + 1}. #${n.id} ${n.name}`).join("; ")}.`, images };
  },
}];

// ---- components and prototype links.
const pickFrom = <T extends string>(labels: Record<T, string>, value: unknown, fallback: T): T => {
  const text = lower(value).replace(/[\s_]+/g, "-");
  const keys = Object.keys(labels) as T[];
  return keys.find((k) => k === text || lower(labels[k]).replace(/\s+/g, "-") === text) ?? fallback;
};

export const designComponentSkills: AgentSkill[] = [{
  name: "design_make_component",
  description: "Makes a frame (name or #id from design_list) a reusable component. Its instances follow every change made to it.",
  args: { channel: "string", layer: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n]) => {
      if (n.kind !== "frame") throw new Error(`"${n.name}" is a ${n.kind}; only frames can be components. Use design_group with kind frame first.`);
      if (n.props.instanceOf !== null) throw new Error(`"${n.name}" is an instance; it can't be a component.`);
      return new Map([[n.id, { props: { ...n.props, main: true } }]]);
    });
    return `"${nodes[0].name}" is now a component in #${channel.name}. Add copies with design_add_instance.`;
  },
}, {
  name: "design_add_instance",
  description: "Places an instance (a linked copy) of a component at x,y (its top left). It follows the component's later changes.",
  args: { channel: "string", component: "string", x: "number", y: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const channel = await findChannel(context, String(args.channel), "design");
    const all = await layers(context, channel.id);
    let main = layerNamed(all, args.component);
    if (main.props.variantSet) main = all.filter((n) => n.parentId === main.id && n.props.main).sort((a, b) => a.z - b.z)[0] ?? main;
    if (!main.props.main) throw new Error(`"${main.name}" isn't a component. Make it one with design_make_component.`);
    const x = Number(args.x) || 0;
    const y = Number(args.y) || 0;
    await context.cursor(channel.id, { x, y });
    const [id] = await addNodes(context.write("design"), channel.id, [{
      kind: "frame", name: main.name, x, y, width: main.width, height: main.height, props: copyProps(main.props, null, main.id),
    }]);
    await syncInstances(context.write("design"), channel.id);
    return `Added an instance of "${main.name}" (#${id}) to #${channel.name}.`;
  },
}, {
  name: "design_set_variant",
  description: "Switches an instance of a component with variants to the variant with property=value (like State=Hover).",
  args: { channel: "string", instance: "string", property: "string", value: "string" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    let picked = "";
    const { channel } = await change(context, String(args.channel), [args.instance], ([n], all) => {
      const main = all.find((m) => m.id === n.props.instanceOf);
      if (!main) throw new Error(`"${n.name}" isn't an instance of a component.`);
      const variants = all.filter((m) => m.parentId === main.parentId && m.props.main);
      const target = pickVariant(variants, main.name, String(args.property).trim(), String(args.value).trim());
      if (target === null) {
        const known = variants.map((v) => v.name).join("; ");
        throw new Error(`No variant has ${args.property}=${args.value}. Variants: ${known}.`);
      }
      picked = all.find((m) => m.id === target)!.name;
      return new Map([[n.id, { props: { ...n.props, instanceOf: target } }]]);
    });
    return `The instance in #${channel.name} now shows ${Object.keys(variantValues(picked)).length ? picked : `"${picked}"`}.`;
  },
}, {
  name: "design_set_interaction",
  description: `Sets what a layer does in play mode (replacing what it did). trigger: ${Object.values(triggerLabels).join(", ")}. ` +
    `action: ${Object.values(actionLabels).join(", ")}, or none to remove. target: the frame to go to or open, or the variant to change to. ` +
    `animation: ${Object.values(transitionLabels).join(", ")}. direction: left, right, up or down. duration in ms.`,
  args: { channel: "string", layer: "string", trigger: "string", action: "string", target: "string", animation: "string", direction: "string", duration: "number" },
  permissions: ["read:design", "write:design"], channelType: "design",
  async run(context, args) {
    const none = lower(args.action) === "none";
    const { channel, nodes } = await change(context, String(args.channel), [args.layer], ([n], all) => {
      if (none) return new Map([[n.id, { props: { ...n.props, interactions: [] } }]]);
      const action = pickFrom<Action>(actionLabels, args.action, "navigate");
      const target = action === "back" || action === "close" ? null : layerNamed(all, args.target);
      if (target && (action === "navigate" || action === "overlay") && (target.kind !== "frame" || target.parentId !== null))
        throw new Error(`"${target.name}" isn't a frame on the page; play mode goes to page-level frames.`);
      if (target && action === "change-to" && !target.props.main) throw new Error(`"${target.name}" isn't a variant of a component.`);
      const direction = (["left", "right", "up", "down"] as Direction[]).find((d) => d === lower(args.direction)) ?? "left";
      const it = {
        ...interaction(target?.id ?? null), action, direction,
        trigger: pickFrom<Trigger>(triggerLabels, args.trigger, "click"),
        transition: pickFrom<Transition>(transitionLabels, args.animation, action === "change-to" ? "smart" : "instant"),
        duration: Number(args.duration) > 0 ? Number(args.duration) : 300,
      };
      return new Map([[n.id, { props: { ...n.props, interactions: [it] } }]]);
    });
    return none ? `"${nodes[0].name}" does nothing in play mode now.` : `Set what "${nodes[0].name}" does in play mode in #${channel.name}.`;
  },
}];
