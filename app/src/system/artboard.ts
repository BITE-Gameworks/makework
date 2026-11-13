// Artboards (like BeeRef): images, notes and drawings placed freely on an endless canvas.
// Images travel as data URLs until file storage exists. Items from before 1.1.0 have no kind and are images.
import type { MockPlugin } from "./backend";
import { InvalidRequest } from "./errors";

export const artboard: MockPlugin = {
  manifest: {
    name: "artboard",
    version: "1.1.0",
    description: "Artboards: images, notes and drawings arranged on an endless canvas.",
    tables: [
      {
        name: "artboard_items", parent: null,
        columns: {
          channel_id: "bigint", name: "text", mime: "text", url: "text", thumb: "text", width: "int", height: "int",
          x: "decimal", y: "decimal", scale: "decimal", rotation: "decimal", flip: "bool", z: "int",
          author_id: "bigint", created_at: "timestamp", deleted: "bool",
          kind: "text", text: "text", color: "text", stroke: "decimal", paths: "text",
        },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const item = (id: unknown) => {
      const [row] = data.select("artboard_items", { id: id as number });
      if (!row) throw new InvalidRequest(`Unknown item ${id}`);
      return row;
    };
    const top = (channelId: unknown) =>
      Math.max(0, ...data.select("artboard_items", { channel_id: channelId as number }).map((i) => Number(i.z)));

    onApi("list-items", "Lists a board's items, back to front: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The board's channel." }],
      (r) => ({
        rows: data.select("artboard_items", { channel_id: r.args.channel_id }).filter((i) => i.deleted !== true)
          .sort((a, b) => Number(a.z) - Number(b.z)),
      }));

    onApi("add-item", "Adds an image on top, centered on x, y; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The board's channel." },
        { name: "name", type: "text", description: "File name." },
        { name: "mime", type: "text", description: "Media type." },
        { name: "url", type: "text", description: "The image, as a URL." },
        { name: "width", type: "int", description: "Image width in px." },
        { name: "height", type: "int", description: "Image height in px." },
        { name: "thumb", type: "text", required: false, description: "A small preview image (data URL) for images." },
        { name: "x", type: "decimal", description: "Center, board units." },
        { name: "y", type: "decimal", description: "Center, board units." },
        { name: "scale", type: "decimal", required: false, description: "Size factor, 1 by default." },
      ],
      (r) => ({
        id: data.insert("artboard_items", {
          ...r.args, scale: r.args.scale ?? 1, rotation: 0, flip: false, z: top(r.args.channel_id) + 1, deleted: false,
          author_id: r.userId, created_at: new Date().toISOString(),
        }),
      }));

    const checkSize = (r: { args: Record<string, unknown> }) => {
      if (!(Number(r.args.width) > 0) || !(Number(r.args.height) > 0)) throw new InvalidRequest("'width' and 'height' must be above 0.");
    };
    const ofKind = (id: unknown, kind: string) => {
      const row = item(id);
      if (row.kind !== kind) throw new InvalidRequest(`That item is not a ${kind}.`);
      return row;
    };

    onApi("add-note", "Adds a note on top, centered on x, y; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The board's channel." },
        { name: "text", type: "text", required: false, description: "What the note says." },
        { name: "color", type: "text", required: false, description: "A CSS color for the note; empty for the default." },
        { name: "width", type: "int", description: "Note width in board units." },
        { name: "height", type: "int", description: "Note height in board units." },
        { name: "x", type: "decimal", description: "Center, board units." },
        { name: "y", type: "decimal", description: "Center, board units." },
      ],
      (r) => {
        checkSize(r);
        return {
          id: data.insert("artboard_items", {
            ...r.args, kind: "note", name: "Note", mime: "", url: "", text: r.args.text ?? "", color: r.args.color ?? "",
            scale: 1, rotation: 0, flip: false, z: top(r.args.channel_id) + 1, deleted: false,
            author_id: r.userId, created_at: new Date().toISOString(),
          }),
        };
      });

    onApi("edit-note", "Sets a note's text and color; returns { updated }.",
      [
        { name: "item_id", type: "bigint", description: "The note." },
        { name: "text", type: "text", description: "What the note says." },
        { name: "color", type: "text", description: "A CSS color for the note; empty for the default." },
      ],
      (r) => ({ updated: data.update("artboard_items", { text: r.args.text, color: r.args.color }, { id: ofKind(r.args.item_id, "note").id }) }));

    onApi("add-drawing", "Adds a drawn line on top; returns its id. `paths` is the drawing as JSON, in a box of width x height.",
      [
        { name: "channel_id", type: "bigint", description: "The board's channel." },
        { name: "paths", type: "text", description: "The drawn paths, JSON." },
        { name: "color", type: "text", required: false, description: "A CSS color for the line; empty for the theme's text color." },
        { name: "stroke", type: "decimal", description: "Line width in board units." },
        { name: "width", type: "int", description: "Drawing width in board units." },
        { name: "height", type: "int", description: "Drawing height in board units." },
        { name: "x", type: "decimal", description: "Center, board units." },
        { name: "y", type: "decimal", description: "Center, board units." },
      ],
      (r) => {
        checkSize(r);
        if (!(Number(r.args.stroke) > 0)) throw new InvalidRequest("'stroke' must be above 0.");
        return {
          id: data.insert("artboard_items", {
            ...r.args, kind: "drawing", name: "Drawing", mime: "", url: "", color: r.args.color ?? "",
            scale: 1, rotation: 0, flip: false, z: top(r.args.channel_id) + 1, deleted: false,
            author_id: r.userId, created_at: new Date().toISOString(),
          }),
        };
      });

    onApi("style-drawing", "Sets a drawing's color and line width; returns { updated }.",
      [
        { name: "item_id", type: "bigint", description: "The drawing." },
        { name: "color", type: "text", description: "A CSS color for the line; empty for the theme's text color." },
        { name: "stroke", type: "decimal", description: "Line width in board units." },
      ],
      (r) => {
        if (!(Number(r.args.stroke) > 0)) throw new InvalidRequest("'stroke' must be above 0.");
        return { updated: data.update("artboard_items", { color: r.args.color, stroke: r.args.stroke }, { id: ofKind(r.args.item_id, "drawing").id }) };
      });

    onApi("place-item", "Sets where an item is and how it is shown; returns { updated }.",
      [
        { name: "item_id", type: "bigint", description: "The item." },
        { name: "x", type: "decimal", description: "Center, board units." },
        { name: "y", type: "decimal", description: "Center, board units." },
        { name: "scale", type: "decimal", description: "Size factor." },
        { name: "rotation", type: "decimal", description: "Degrees, clockwise." },
        { name: "flip", type: "bool", description: "Mirrored horizontally." },
      ],
      (r) => {
        item(r.args.item_id);
        if (Number(r.args.scale) <= 0) throw new InvalidRequest("'scale' must be above 0.");
        const { item_id, ...values } = r.args;
        return { updated: data.update("artboard_items", values, { id: item_id }) };
      });

    onApi("rename-item", "Renames an item; returns { updated }.",
      [
        { name: "item_id", type: "bigint", description: "The item." },
        { name: "name", type: "text", description: "The new name." },
      ],
      (r) => ({ updated: data.update("artboard_items", { name: r.args.name }, { id: item(r.args.item_id).id }) }));

    onApi("raise-item", "Puts an item on top of the others; returns { z }.",
      [{ name: "item_id", type: "bigint", description: "The item." }],
      (r) => {
        const row = item(r.args.item_id);
        const z = top(row.channel_id);
        if (Number(row.z) === z) return { z };
        data.update("artboard_items", { z: z + 1 }, { id: row.id });
        return { z: z + 1 };
      });

    // Deleting only hides the item, so undo can bring it back with the same id.
    onApi("remove-item", "Deletes an item (restore-item undoes it); returns { deleted }.",
      [{ name: "item_id", type: "bigint", description: "The item." }],
      (r) => ({ deleted: data.update("artboard_items", { deleted: true }, { id: item(r.args.item_id).id }) }));

    onApi("restore-item", "Brings back a deleted item; returns { restored }.",
      [{ name: "item_id", type: "bigint", description: "The item." }],
      (r) => ({ restored: data.update("artboard_items", { deleted: false }, { id: item(r.args.item_id).id }) }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};
