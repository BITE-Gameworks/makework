import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { InvalidRequest } from "./errors";

// Structured shapes have rows (diagram_rows): a UML class and its kin, a database table.
const structuredKinds = new Set(["uml-class", "uml-abstract", "uml-interface", "uml-enum", "uml-object", "uml-datatype", "db-table", "db-view", "db-junction"]);
const shapeKinds = new Set(["rect", "rounded", "ellipse", "diamond", "parallelogram", "cylinder", "document", "actor", "cloud", "note", "text", "image", "icon", "container", "swimlane", "group", ...structuredKinds]);
const rowSections = new Set(["attributes", "operations", "literals", "columns"]);
const rowFields = ["section", "z", "name", "type", "params", "value", "visibility", "marks"] as const;
const edgeKinds = new Set(["straight", "orthogonal", "curved"]);
const ports = new Set(["n", "e", "s", "w", "c"]);
const pageFields = ["name", "z", "background", "grid", "exports"] as const;
const shapeFields = ["parent_id", "kind", "x", "y", "w", "h", "rotation", "z", "text", "style", "exports"] as const;
const edgeFields = ["parent_id", "from_id", "from_port", "from_x", "from_y", "to_id", "to_port", "to_x", "to_y", "points", "kind", "start_arrow", "end_arrow", "label", "start_label", "end_label", "style", "from_row", "to_row"] as const;
// A label at each end (a multiplicity or a role): written only when set, since an older app refuses a column it
// doesn't know, and connectors without one must stay readable there.
const endLabels = ["start_label", "end_label"] as const;
const maxBatch = 500;

interface NewShape {
  ref?: string;
  parent_id?: number | null;
  parent_ref?: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation?: number;
  z?: number;
  text?: string;
  style?: string;
  exports?: string;
}

// An end without a shape (id null) stays at its x and y.
interface NewEdge {
  parent_id?: number | null;
  from_id: number | null;
  from_port: string;
  from_x?: number;
  from_y?: number;
  to_id: number | null;
  to_port: string;
  to_x?: number;
  to_y?: number;
  points?: string;
  kind?: string;
  start_arrow?: string;
  end_arrow?: string;
  label?: string;
  start_label?: string;
  end_label?: string;
  from_row?: number | null;
  to_row?: number | null;
  style?: string;
}

export const diagram: MockPlugin = {
  manifest: {
    name: "diagram",
    version: "0.1.0",
    description: "Collaborative diagrams with shapes and attached connectors.",
    tables: [
      { name: "diagram_pages", parent: null, columns: { channel_id: "bigint", name: "text", z: "decimal", background: "text", grid: "bool", exports: "text" } },
      { name: "diagram_shapes", parent: null, columns: {
        page_id: "bigint", parent_id: "bigint", kind: "text", x: "decimal", y: "decimal", w: "decimal", h: "decimal",
        rotation: "decimal", z: "decimal", text: "text", style: "text", exports: "text", deleted: "bool",
      } },
      { name: "diagram_edges", parent: null, columns: {
        page_id: "bigint", parent_id: "bigint", from_id: "bigint", from_port: "text", from_x: "decimal", from_y: "decimal",
        to_id: "bigint", to_port: "text", to_x: "decimal", to_y: "decimal", points: "text",
        kind: "text", start_arrow: "text", end_arrow: "text", label: "text", start_label: "text", end_label: "text", style: "text",
        deleted: "bool", from_row: "bigint", to_row: "bigint",
      } },
      { name: "diagram_rows", parent: null, columns: {
        shape_id: "bigint", section: "text", z: "decimal", name: "text", type: "text", params: "text", value: "text",
        visibility: "text", marks: "text", deleted: "bool",
      } },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const rows = (table: string, where: Record<string, unknown> = {}) => data.select(table, where);
    // One end of a connector as columns: on a visible shape of the page (or one of its rows), or free at a point. The
    // row column is written only when there is one, or one is taken off (`had`: the connector as it was), since an
    // older app refuses a column it doesn't know.
    const end = (edge: NewEdge, side: "from" | "to", pageId: number, had?: JsonRow): Record<string, number | string | null> => {
      const values = edge as unknown as Record<string, unknown>;
      const id = values[`${side}_id`];
      const port = String(values[`${side}_port`] ?? "c");
      if (!ports.has(port)) throw new InvalidRequest("Unknown connector port.");
      const rowId = values[`${side}_row`];
      const rowColumn = rowId != null ? { [`${side}_row`]: Number(rowId) } : had?.[`${side}_row`] != null ? { [`${side}_row`]: null } : {};
      if (rowId != null) {
        const [row] = rows("diagram_rows", { id: Number(rowId) });
        if (!row || id == null || Number(row.shape_id) !== Number(id)) throw new InvalidRequest("A connector can only end on a row of the shape it ends on.");
      }
      if (id === null || id === undefined) {
        const x = Number(values[`${side}_x`]);
        const y = Number(values[`${side}_y`]);
        if (values[`${side}_x`] == null || values[`${side}_y`] == null || !Number.isFinite(x) || !Number.isFinite(y))
          throw new InvalidRequest("A connector end without a shape needs finite x and y coordinates.");
        return { [`${side}_id`]: null, [`${side}_port`]: port, [`${side}_x`]: x, [`${side}_y`]: y };
      }
      const target = shape(id);
      if (Number(target.page_id) !== pageId || target.deleted === true)
        throw new InvalidRequest("Connector endpoints must be visible shapes on this page.");
      return { [`${side}_id`]: Number(id), [`${side}_port`]: port, [`${side}_x`]: null, [`${side}_y`]: null, ...rowColumn };
    };
    const requiredRow = (table: string, id: unknown, what: string): JsonRow => {
      const [row] = rows(table, { id: Number(id) });
      if (!row) throw new InvalidRequest(`Unknown ${what} ${id}.`);
      return row;
    };
    const list = <T>(value: unknown, what: string): T[] => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        if (Array.isArray(parsed) && parsed.length <= maxBatch) return parsed as T[];
      } catch {
        // Reported below.
      }
      throw new InvalidRequest(`'${what}' must be a JSON list of at most ${maxBatch} items.`);
    };
    const objectText = (value: unknown, what: string) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return String(value);
      } catch {
        // Reported below.
      }
      throw new InvalidRequest(`'${what}' must be a JSON object.`);
    };
    const page = (id: unknown) => requiredRow("diagram_pages", id, "page");
    const shape = (id: unknown) => requiredRow("diagram_shapes", id, "shape");
    const checkPage = (pageId: number, channelId?: number) => {
      const row = page(pageId);
      if (channelId !== undefined && Number(row.channel_id) !== channelId)
        throw new InvalidRequest("The page must belong to this channel.");
      return row;
    };
    const isContainer = (kind: unknown) => kind === "container" || kind === "swimlane" || kind === "group";
    const checkParent = (pageId: number, parentId: number | null) => {
      if (parentId === null) return;
      const parent = shape(parentId);
      if (Number(parent.page_id) !== pageId || !isContainer(parent.kind))
        throw new InvalidRequest("Only a container, swimlane or group on this page can hold shapes.");
    };
    // Connectors belong to a group on their page, or to none.
    const checkEdgeParent = (pageId: number, parentId: unknown) => {
      if (parentId === null || parentId === undefined) return null;
      const parent = shape(parentId);
      if (Number(parent.page_id) !== pageId || parent.kind !== "group") throw new InvalidRequest("Connectors can only go in a group on their page.");
      return Number(parentId);
    };
    // Export settings: a JSON list of { scale, format, suffix }.
    const exportsText = (value: unknown) => {
      const items = list<Record<string, unknown>>(value ?? "[]", "exports");
      if (items.some((item) => !item || !Number.isFinite(Number(item.scale)) || Number(item.scale) <= 0 || Number(item.scale) > 8
        || !["png", "jpg", "webp", "svg", "pdf"].includes(String(item.format)) || typeof item.suffix !== "string"))
        throw new InvalidRequest("Export settings need a scale up to 8, a format (png, jpg, webp, svg or pdf) and a suffix.");
      return JSON.stringify(items.map((item) => ({ scale: Number(item.scale), format: item.format, suffix: String(item.suffix).slice(0, 100) })));
    };
    const nextZ = (table: string, column: string, id: number) =>
      Math.max(0, ...rows(table, { [column]: id }).map((row) => Number(row.z))) + 1;
    const finite = (value: unknown, field: string) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new InvalidRequest(`'${field}' must be a finite number.`);
      return number;
    };
    const live = (table: string, where: Record<string, unknown>) =>
      rows(table, where).filter((row) => row.deleted !== true);

    onApi("list-pages", "Lists a channel's diagram pages: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The diagram channel." }],
      (r) => ({ rows: live("diagram_pages", { channel_id: r.args.channel_id }) }));

    onApi("add-page", "Adds a diagram page. Returns { id }.",
      [{ name: "channel_id", type: "bigint", description: "The diagram channel." }, { name: "name", type: "text", description: "The page name." }],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const name = String(r.args.name).trim();
        if (!name) throw new InvalidRequest("A page needs a name.");
        return { id: data.insert("diagram_pages", {
          channel_id: channelId, name, z: nextZ("diagram_pages", "channel_id", channelId), background: "", grid: true,
        }) };
      });

    onApi("update-page", "Changes a page's name, background or grid. Returns { updated }.",
      [{ name: "id", type: "bigint", description: "The page." }, { name: "changes", type: "text", description: "Page fields as JSON." }],
      (r) => {
        const current = page(r.args.id);
        let changes: Record<string, unknown>;
        try {
          changes = JSON.parse(String(r.args.changes)) as Record<string, unknown>;
        } catch {
          throw new InvalidRequest("'changes' must be a JSON object.");
        }
        const values = Object.fromEntries(pageFields.filter((field) => field in changes).map((field) => [field, changes[field]]));
        if (typeof values.name === "string" && !values.name.trim()) throw new InvalidRequest("A page needs a name.");
        if ("background" in values && values.background !== "" && !/^#[0-9a-f]{6}$/i.test(String(values.background)))
          throw new InvalidRequest("The background must be empty or #rrggbb.");
        if ("grid" in values && typeof values.grid !== "boolean") throw new InvalidRequest("'grid' must be a boolean.");
        if ("exports" in values) values.exports = exportsText(values.exports);
        return { updated: Object.keys(values).length ? data.update("diagram_pages", values, { id: current.id }) : 0 };
      });

    onApi("list-shapes", "Lists a page's shapes: { rows }.",
      [{ name: "page_id", type: "bigint", description: "The page." }],
      (r) => ({ rows: live("diagram_shapes", { page_id: r.args.page_id }) }));

    onApi("add-shapes", `Adds up to ${maxBatch} shapes (JSON list). Returns { ids }.`,
      [{ name: "page_id", type: "bigint", description: "The page." }, { name: "shapes", type: "text", description: "Shapes as JSON." }],
      (r) => {
        const pageId = Number(r.args.page_id);
        checkPage(pageId);
        const refs = new Map<string, number>();
        const ids: number[] = [];
        for (const item of list<NewShape>(r.args.shapes, "shapes")) {
          if (!shapeKinds.has(item.kind)) throw new InvalidRequest(`Unknown shape kind '${item.kind}'.`);
          const parentId = item.parent_ref !== undefined ? refs.get(item.parent_ref) : item.parent_id ?? null;
          if (item.parent_ref !== undefined && parentId === undefined) throw new InvalidRequest(`Unknown parent_ref '${item.parent_ref}'.`);
          checkParent(pageId, parentId ?? null);
          const w = finite(item.w, "w");
          const h = finite(item.h, "h");
          if (w <= 0 || h <= 0) throw new InvalidRequest("Shape width and height must be positive.");
          const id = data.insert("diagram_shapes", {
            page_id: pageId, parent_id: parentId ?? null, kind: item.kind,
            x: finite(item.x, "x"), y: finite(item.y, "y"), w, h,
            rotation: finite(item.rotation ?? 0, "rotation"), z: finite(item.z ?? nextZ("diagram_shapes", "page_id", pageId), "z"),
            text: String(item.text ?? ""), style: objectText(item.style ?? "{}", "style"), exports: exportsText(item.exports ?? "[]"), deleted: false,
          });
          if (item.ref !== undefined) refs.set(item.ref, id);
          ids.push(id);
        }
        return { ids };
      });

    onApi("update-shapes", `Changes up to ${maxBatch} shapes. Returns { updated }.`,
      [{ name: "changes", type: "text", description: "A JSON list of shape changes." }],
      (r) => {
        let updated = 0;
        for (const change of list<Record<string, unknown>>(r.args.changes, "changes")) {
          const current = shape(change.id);
          const values = Object.fromEntries(shapeFields.filter((field) => field in change).map((field) => [field, change[field]]));
          if ("parent_id" in values) {
            const parentId = values.parent_id === null ? null : Number(values.parent_id);
            checkParent(Number(current.page_id), parentId);
            for (let parent = parentId; parent !== null;) {
              const row = shape(parent);
              if (row.id === current.id) throw new InvalidRequest("A shape can't go inside itself.");
              parent = row.parent_id === null ? null : Number(row.parent_id);
            }
          }
          for (const field of ["x", "y", "w", "h", "rotation", "z"] as const) {
            if (!(field in values)) continue;
            values[field] = finite(values[field], field);
            if ((field === "w" || field === "h") && Number(values[field]) <= 0)
              throw new InvalidRequest("Shape width and height must be positive.");
          }
          if ("kind" in values && !shapeKinds.has(String(values.kind))) throw new InvalidRequest(`Unknown shape kind '${values.kind}'.`);
          if ("text" in values) values.text = String(values.text ?? "");
          if ("style" in values) values.style = objectText(values.style, "style");
          if ("exports" in values) values.exports = exportsText(values.exports);
          if (Object.keys(values).length) updated += data.update("diagram_shapes", values, { id: current.id });
        }
        return { updated };
      });

    onApi("remove-shapes", "Hides shapes so they can be restored. Returns { deleted }.",
      [{ name: "ids", type: "text", description: "A JSON list of shape ids." }],
      (r) => ({ deleted: list<number>(r.args.ids, "ids").reduce((sum, id) =>
        sum + data.update("diagram_shapes", { deleted: true }, { id: shape(id).id }), 0) }));

    onApi("restore-shapes", "Restores hidden shapes. Returns { restored }.",
      [{ name: "ids", type: "text", description: "A JSON list of shape ids." }],
      (r) => ({ restored: list<number>(r.args.ids, "ids").reduce((sum, id) =>
        sum + data.update("diagram_shapes", { deleted: false }, { id: shape(id).id }), 0) }));

    // A row's fields, checked: a known section, short texts, a known visibility.
    const rowValues = (values: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const field of rowFields) {
        if (!(field in values)) continue;
        const value = values[field];
        if (field === "z") out.z = finite(value, "z");
        else {
          const text = String(value ?? "");
          if (text.length > 2000) throw new InvalidRequest(`A row's ${field} is too long.`);
          out[field] = text;
        }
      }
      if ("section" in out && !rowSections.has(String(out.section))) throw new InvalidRequest(`Unknown row section '${out.section}'.`);
      if ("visibility" in out && !["", "+", "-", "#", "~"].includes(String(out.visibility))) throw new InvalidRequest("Unknown visibility.");
      return out;
    };
    const structured = (id: unknown) => {
      const target = shape(id);
      if (target.deleted === true || !structuredKinds.has(String(target.kind))) throw new InvalidRequest("Only a class or a table has rows.");
      return target;
    };

    onApi("list-rows", "Lists the rows of a page's classes and tables: { rows }.",
      [{ name: "page_id", type: "bigint", description: "The page." }],
      (r) => {
        const shapes = new Set(live("diagram_shapes", { page_id: r.args.page_id }).map((row) => Number(row.id)));
        return { rows: rows("diagram_rows").filter((row) => row.deleted !== true && shapes.has(Number(row.shape_id))) };
      });

    onApi("add-rows", `Adds up to ${maxBatch} rows to classes and tables (JSON list of { shape_id, section, z, name, ... }). Returns { ids }.`,
      [{ name: "rows", type: "text", description: "Rows as JSON." }],
      (r) => ({ ids: list<Record<string, unknown>>(r.args.rows, "rows").map((row) => {
        structured(row.shape_id);
        const values = rowValues({ section: "attributes", z: nextZ("diagram_rows", "shape_id", Number(row.shape_id)), ...row });
        return data.insert("diagram_rows", { shape_id: Number(row.shape_id), name: "", type: "", params: "", value: "", visibility: "", marks: "", ...values, deleted: false });
      }) }));

    onApi("update-rows", `Changes up to ${maxBatch} rows. Returns { updated }.`,
      [{ name: "changes", type: "text", description: "A JSON list of row changes ({ id, ...fields })." }],
      (r) => ({ updated: list<Record<string, unknown>>(r.args.changes, "changes").reduce((sum, change) => {
        const current = requiredRow("diagram_rows", change.id, "row");
        const values = rowValues(change);
        return Object.keys(values).length ? sum + data.update("diagram_rows", values, { id: current.id }) : sum;
      }, 0) }));

    onApi("remove-rows", "Hides rows so they can be restored. Returns { deleted }.",
      [{ name: "ids", type: "text", description: "A JSON list of row ids." }],
      (r) => ({ deleted: list<number>(r.args.ids, "ids").reduce((sum, id) =>
        sum + data.update("diagram_rows", { deleted: true }, { id: requiredRow("diagram_rows", id, "row").id }), 0) }));

    onApi("restore-rows", "Restores hidden rows. Returns { restored }.",
      [{ name: "ids", type: "text", description: "A JSON list of row ids." }],
      (r) => ({ restored: list<number>(r.args.ids, "ids").reduce((sum, id) =>
        sum + data.update("diagram_rows", { deleted: false }, { id: requiredRow("diagram_rows", id, "row").id }), 0) }));

    onApi("list-edges", "Lists a page's connectors: { rows }.",
      [{ name: "page_id", type: "bigint", description: "The page." }],
      (r) => ({ rows: live("diagram_edges", { page_id: r.args.page_id }) }));

    onApi("add-edges", `Adds up to ${maxBatch} connectors (JSON list). Returns { ids }.`,
      [{ name: "page_id", type: "bigint", description: "The page." }, { name: "edges", type: "text", description: "Connectors as JSON." }],
      (r) => {
        const pageId = Number(r.args.page_id);
        checkPage(pageId);
        const ids = list<NewEdge>(r.args.edges, "edges").map((edge) => {
          const from = end(edge, "from", pageId);
          const to = end(edge, "to", pageId);
          if (from.from_id !== null && from.from_id === to.to_id) throw new InvalidRequest("A connector can't start and end on the same shape.");
          if (!edgeKinds.has(edge.kind ?? "orthogonal")) throw new InvalidRequest(`Unknown connector kind '${edge.kind}'.`);
          const points = list<unknown>(edge.points ?? "[]", "points");
          if (points.some((point) => !point || typeof point !== "object" || !Number.isFinite(Number((point as Record<string, unknown>).x)) || !Number.isFinite(Number((point as Record<string, unknown>).y))))
            throw new InvalidRequest("Connector waypoints must have finite x and y coordinates.");
          return data.insert("diagram_edges", {
            page_id: pageId, parent_id: checkEdgeParent(pageId, edge.parent_id), ...from, ...to, points: JSON.stringify(points), kind: edge.kind ?? "orthogonal", start_arrow: edge.start_arrow ?? "",
            end_arrow: edge.end_arrow ?? "arrow", label: String(edge.label ?? ""), style: objectText(edge.style ?? "{}", "style"), deleted: false,
            ...Object.fromEntries(endLabels.filter((field) => edge[field]).map((field) => [field, String(edge[field])])),
          });
        });
        return { ids };
      });

    onApi("update-edges", `Changes up to ${maxBatch} connectors. Returns { updated }.`,
      [{ name: "changes", type: "text", description: "A JSON list of connector changes." }],
      (r) => {
        let updated = 0;
        for (const change of list<Record<string, unknown>>(r.args.changes, "changes")) {
          const current = requiredRow("diagram_edges", change.id, "connector");
          const values: Record<string, unknown> = Object.fromEntries(edgeFields.filter((field) => field in change).map((field) => [field, change[field]]));
          if ("parent_id" in values) values.parent_id = checkEdgeParent(Number(current.page_id), values.parent_id);
          for (const side of ["from", "to"] as const)
            if (edgeFields.some((field) => field.startsWith(`${side}_`) && field in values))
              Object.assign(values, end({ ...current, ...values } as unknown as NewEdge, side, Number(current.page_id), current));
          if ("kind" in values && !edgeKinds.has(String(values.kind))) throw new InvalidRequest(`Unknown connector kind '${values.kind}'.`);
          if ("points" in values) {
            const points = list<unknown>(values.points, "points");
            if (points.some((point) => !point || typeof point !== "object" || !Number.isFinite(Number((point as Record<string, unknown>).x)) || !Number.isFinite(Number((point as Record<string, unknown>).y))))
              throw new InvalidRequest("Connector waypoints must have finite x and y coordinates.");
            values.points = JSON.stringify(points);
          }
          if ("style" in values) values.style = objectText(values.style, "style");
          for (const field of endLabels) {
            if (!(field in values)) continue;
            values[field] = String(values[field] ?? "");
            if (!values[field] && current[field] == null) delete values[field];
          }
          if (Object.keys(values).length) updated += data.update("diagram_edges", values, { id: current.id });
        }
        return { updated };
      });

    onApi("remove-edges", "Hides connectors so they can be restored. Returns { deleted }.",
      [{ name: "ids", type: "text", description: "A JSON list of connector ids." }],
      (r) => ({ deleted: list<number>(r.args.ids, "ids").reduce((sum, id) =>
        sum + data.update("diagram_edges", { deleted: true }, { id: requiredRow("diagram_edges", id, "connector").id }), 0) }));

    onApi("restore-edges", "Restores hidden connectors. Returns { restored }.",
      [{ name: "ids", type: "text", description: "A JSON list of connector ids." }],
      (r) => ({ restored: list<number>(r.args.ids, "ids").reduce((sum, id) =>
        sum + data.update("diagram_edges", { deleted: false }, { id: requiredRow("diagram_edges", id, "connector").id }), 0) }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};
