// Design documents. Every layer is a row; frames hold other layers through parent_id.
// Positions are the unrotated box's top left in the parent's coordinates, rotation turns it around its center.
import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { InvalidRequest } from "./errors";

export const designKinds = ["frame", "group", "rect", "ellipse", "line", "text", "image", "svg", "path"];
const containers = new Set(["frame", "group"]);
const editable = ["parent_id", "name", "z", "x", "y", "width", "height", "rotation", "props"] as const;
const maxBatch = 500;

interface NewNode {
  ref?: string;
  parent_id?: number | null;
  parent_ref?: string;
  kind: string;
  name: string;
  z?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  props?: string;
  url?: string | null;
  thumb?: string | null;
}

export const design: MockPlugin = {
  manifest: {
    name: "design",
    version: "1.0.0",
    description: "Design documents: frames, shapes, text and images on an endless canvas.",
    tables: [
      {
        name: "design_nodes", parent: null,
        columns: {
          channel_id: "bigint", parent_id: "bigint", kind: "text", name: "text", z: "decimal",
          x: "decimal", y: "decimal", width: "decimal", height: "decimal", rotation: "decimal",
          props: "text", url: "text", thumb: "text",
          author_id: "bigint", created_at: "timestamp", deleted: "bool",
        },
      },
      // The page's settings: background is "" for the app theme's, #rrggbb, or "ref:<color id>" for a palette color;
      // palette_id the palette everyone sees (none: the first).
      {
        name: "design_pages", parent: null,
        columns: { channel_id: "bigint", name: "text", background: "text", z: "decimal", palette_id: "bigint" },
      },
      // Named colors that layers can use, and palettes that give each color a value.
      {
        name: "design_colors", parent: null,
        columns: { channel_id: "bigint", name: "text", z: "decimal", deleted: "bool" },
      },
      {
        name: "design_palettes", parent: null,
        columns: { channel_id: "bigint", name: "text", z: "decimal", deleted: "bool" },
      },
      {
        name: "design_color_values", parent: null,
        columns: { channel_id: "bigint", palette_id: "bigint", color_id: "bigint", value: "text" },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const node = (id: unknown): JsonRow => {
      const [row] = data.select("design_nodes", { id: Number(id) });
      if (!row) throw new InvalidRequest(`Unknown layer ${id}`);
      return row;
    };
    const list = <T>(text: unknown, what: string): T[] => {
      try {
        const value: unknown = JSON.parse(String(text));
        if (Array.isArray(value)) {
          if (value.length > maxBatch) throw new InvalidRequest(`At most ${maxBatch} at a time.`);
          return value as T[];
        }
      } catch (e) {
        if (e instanceof InvalidRequest) throw e;
      }
      throw new InvalidRequest(`'${what}' must be a JSON list.`);
    };
    const checkProps = (props: unknown) => {
      if (props === undefined) return;
      try {
        const value: unknown = JSON.parse(String(props));
        if (value && typeof value === "object" && !Array.isArray(value)) return;
      } catch {
        // Reported below.
      }
      throw new InvalidRequest("'props' must be a JSON object.");
    };
    const checkParent = (channelId: number, parentId: number | null) => {
      if (parentId === null) return;
      const parent = node(parentId);
      if (Number(parent.channel_id) !== channelId) throw new InvalidRequest("A layer's parent must be in the same document.");
      if (!containers.has(String(parent.kind))) throw new InvalidRequest("Only frames and groups can hold other layers.");
    };
    const top = (channelId: number, parentId: number | null) =>
      Math.max(0, ...data.select("design_nodes", { channel_id: channelId, parent_id: parentId }).map((n) => Number(n.z)));

    onApi("list-nodes", "Lists a document's layers: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The design channel." }],
      (r) => ({ rows: data.select("design_nodes", { channel_id: r.args.channel_id }).filter((n) => n.deleted !== true) }));

    onApi("add-nodes", `Adds up to ${maxBatch} layers (JSON list of { ref?, parent_id? or parent_ref?, kind, name, x, y, width, height, rotation?, z?, props?, url?, thumb? }). ` +
      "parent_ref names an earlier layer of the same list by its ref. Returns { ids } in order.",
      [
        { name: "channel_id", type: "bigint", description: "The design channel." },
        { name: "nodes", type: "text", description: "The layers, as JSON text." },
      ],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const refs = new Map<string, number>();
        const ids: number[] = [];
        for (const n of list<NewNode>(r.args.nodes, "nodes")) {
          if (!designKinds.includes(n.kind)) throw new InvalidRequest(`Unknown layer kind '${n.kind}'.`);
          const parentId = n.parent_ref !== undefined ? refs.get(n.parent_ref) ?? null : n.parent_id ?? null;
          if (n.parent_ref !== undefined && parentId === null) throw new InvalidRequest(`Unknown parent_ref '${n.parent_ref}'.`);
          checkParent(channelId, parentId);
          checkProps(n.props);
          const id = data.insert("design_nodes", {
            channel_id: channelId, parent_id: parentId, kind: n.kind, name: n.name, z: n.z ?? top(channelId, parentId) + 1,
            x: n.x, y: n.y, width: n.width, height: n.height, rotation: n.rotation ?? 0, props: n.props ?? "{}",
            url: n.url ?? null, thumb: n.thumb ?? null, author_id: r.userId, created_at: new Date().toISOString(), deleted: false,
          });
          if (n.ref !== undefined) refs.set(n.ref, id);
          ids.push(id);
        }
        return { ids };
      });

    onApi("update-nodes", `Changes up to ${maxBatch} layers (JSON list of { id, and any of ${editable.join(", ")} }). Returns { updated }.`,
      [{ name: "changes", type: "text", description: "The changes, as JSON text." }],
      (r) => {
        let updated = 0;
        for (const change of list<Record<string, unknown>>(r.args.changes, "changes")) {
          const row = node(change.id);
          const values = Object.fromEntries(editable.filter((k) => k in change).map((k) => [k, change[k]]));
          if ("parent_id" in values) {
            const parentId = values.parent_id === null ? null : Number(values.parent_id);
            checkParent(Number(row.channel_id), parentId);
            for (let p = parentId; p !== null; p = node(p).parent_id === null ? null : Number(node(p).parent_id))
              if (p === row.id) throw new InvalidRequest("A layer can't go inside itself.");
          }
          checkProps(values.props);
          if (Object.keys(values).length) updated += data.update("design_nodes", values, { id: row.id });
        }
        return { updated };
      });

    // Deleting only hides layers, so undo can bring them back with the same ids.
    onApi("remove-nodes", "Deletes layers (JSON list of ids; restore-nodes undoes it). Returns { deleted }.",
      [{ name: "ids", type: "text", description: "The layers, as JSON text." }],
      (r) => ({
        deleted: list<number>(r.args.ids, "ids").reduce((n, id) => n + data.update("design_nodes", { deleted: true }, { id: node(id).id }), 0),
      }));

    onApi("restore-nodes", "Brings back deleted layers (JSON list of ids). Returns { restored }.",
      [{ name: "ids", type: "text", description: "The layers, as JSON text." }],
      (r) => ({
        restored: list<number>(r.args.ids, "ids").reduce((n, id) => n + data.update("design_nodes", { deleted: false }, { id: node(id).id }), 0),
      }));

    const channelArg = { name: "channel_id", type: "bigint", description: "The design channel." } as const;
    const hex = (v: unknown) => {
      if (!/^#[0-9a-f]{6}$/i.test(String(v))) throw new InvalidRequest("A color must look like #1e1e1e.");
      return String(v).toLowerCase();
    };
    const own = (table: string, id: unknown, what: string) => {
      const [row] = data.select(table, { id: Number(id) });
      if (!row) throw new InvalidRequest(`Unknown ${what} ${id}`);
      return row;
    };
    const live = (table: string, channelId: unknown) =>
      data.select(table, { channel_id: Number(channelId) }).filter((r) => r.deleted !== true);
    const setValue = (channelId: number, paletteId: number, colorId: number, value: string) => {
      const [row] = data.select("design_color_values", { palette_id: paletteId, color_id: colorId });
      if (row) data.update("design_color_values", { value }, { id: row.id });
      else data.insert("design_color_values", { channel_id: channelId, palette_id: paletteId, color_id: colorId, value });
    };
    const nextZ = (table: string, channelId: number) => Math.max(0, ...data.select(table, { channel_id: channelId }).map((r) => Number(r.z))) + 1;

    onApi("get-page", "The document's page settings: { page } (null until something was set).",
      [channelArg],
      (r) => ({ page: data.select("design_pages", { channel_id: Number(r.args.channel_id) })[0] ?? null }));

    onApi("set-palette", "Shows a palette's colors for everyone in the document. Returns { id }.",
      [channelArg, { name: "palette_id", type: "bigint", description: "The palette." }],
      (r) => {
        const channelId = Number(r.args.channel_id);
        own("design_palettes", r.args.palette_id, "palette");
        const [page] = data.select("design_pages", { channel_id: channelId });
        if (page) {
          data.update("design_pages", { palette_id: r.args.palette_id }, { id: page.id });
          return { id: page.id };
        }
        return { id: data.insert("design_pages", { channel_id: channelId, name: "Page 1", background: "", z: 1, palette_id: r.args.palette_id }) };
      });

    onApi("set-page", "Sets the page background: '' for the theme's, #rrggbb, or ref:<color id>. Returns { id }.",
      [channelArg, { name: "background", type: "text", required: false, description: "The background." }],
      (r) => {
        const background = String(r.args.background ?? "");
        if (background && !/^#[0-9a-f]{6}$/i.test(background) && !/^ref:\d+$/.test(background))
          throw new InvalidRequest("The background must be '', #rrggbb or ref:<color id>.");
        const channelId = Number(r.args.channel_id);
        const [page] = data.select("design_pages", { channel_id: channelId });
        if (page) {
          data.update("design_pages", { background }, { id: page.id });
          return { id: page.id };
        }
        return { id: data.insert("design_pages", { channel_id: channelId, name: "Page 1", background, z: 1, palette_id: null }) };
      });

    onApi("list-palettes", "The document's colors, palettes and each palette's values: { colors, palettes, values }.",
      [channelArg],
      (r) => ({
        colors: live("design_colors", r.args.channel_id),
        palettes: live("design_palettes", r.args.channel_id),
        values: data.select("design_color_values", { channel_id: Number(r.args.channel_id) }),
      }));

    onApi("add-color", "Adds a named color with the same value in every palette (and a first palette if there is none). Returns { id }.",
      [channelArg, { name: "name", type: "text", description: "The color's name." }, { name: "value", type: "text", description: "#rrggbb." }],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const value = hex(r.args.value);
        if (live("design_palettes", channelId).length === 0)
          data.insert("design_palettes", { channel_id: channelId, name: "Palette 1", z: 1, deleted: false });
        const id = data.insert("design_colors", { channel_id: channelId, name: r.args.name, z: nextZ("design_colors", channelId), deleted: false });
        for (const p of live("design_palettes", channelId)) setValue(channelId, p.id, id, value);
        return { id };
      });

    onApi("add-palette", "Adds a palette, starting with another palette's values (or the first one's). Returns { id }.",
      [channelArg, { name: "name", type: "text", description: "The palette's name." },
        { name: "copy_from", type: "bigint", required: false, description: "The palette to copy values from." }],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const source = r.args.copy_from ?? live("design_palettes", channelId)[0]?.id ?? null;
        const id = data.insert("design_palettes", { channel_id: channelId, name: r.args.name, z: nextZ("design_palettes", channelId), deleted: false });
        if (source !== null)
          for (const v of data.select("design_color_values", { palette_id: Number(source) })) setValue(channelId, id, Number(v.color_id), String(v.value));
        return { id };
      });

    onApi("set-color", "Sets a color's value in one palette. Returns { set: true }.",
      [{ name: "palette_id", type: "bigint", description: "The palette." }, { name: "color_id", type: "bigint", description: "The color." },
        { name: "value", type: "text", description: "#rrggbb." }],
      (r) => {
        const palette = own("design_palettes", r.args.palette_id, "palette");
        own("design_colors", r.args.color_id, "color");
        setValue(Number(palette.channel_id), palette.id, Number(r.args.color_id), hex(r.args.value));
        return { set: true };
      });

    for (const [table, what] of [["design_colors", "color"], ["design_palettes", "palette"]] as const) {
      onApi(`rename-${what}`, `Renames a ${what}. Returns { updated }.`,
        [{ name: "id", type: "bigint", description: `The ${what}.` }, { name: "name", type: "text", description: "The new name." }],
        (r) => ({ updated: data.update(table, { name: r.args.name }, { id: own(table, r.args.id, what).id }) }));
      onApi(`move-${what}`, `Moves a ${what} in its list (lower z first). Returns { updated }.`,
        [{ name: "id", type: "bigint", description: `The ${what}.` }, { name: "z", type: "decimal", description: "The new place." }],
        (r) => ({ updated: data.update(table, { z: Number(r.args.z) }, { id: own(table, r.args.id, what).id }) }));
      onApi(`remove-${what}`, `Deletes a ${what} (restore-${what} undoes it). Returns { deleted }.`,
        [{ name: "id", type: "bigint", description: `The ${what}.` }],
        (r) => ({ deleted: data.update(table, { deleted: true }, { id: own(table, r.args.id, what).id }) }));
      onApi(`restore-${what}`, `Brings back a deleted ${what}. Returns { restored }.`,
        [{ name: "id", type: "bigint", description: `The ${what}.` }],
        (r) => ({ restored: data.update(table, { deleted: false }, { id: own(table, r.args.id, what).id }) }));
    }

    onApiRead((r) => data.select(r.table, r.where));
  },
};
