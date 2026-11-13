// Docs channels, a tree of markdown pages. Pages hold sub-pages through parent_id.
// A page's text is a Yjs document kept as updates (base64), so members can type at once and every copy merges to
// the same text; body is a plain copy of the latest text for lists, search and exports.
import type { MockPlugin } from "./backend";
import type { JsonRow } from "./data";
import { idList, InvalidRequest } from "./errors";

export const docs: MockPlugin = {
  manifest: {
    name: "docs",
    version: "1.0.0",
    description: "Docs: markdown pages in a tree.",
    tables: [
      {
        name: "docs_pages", parent: null,
        columns: {
          channel_id: "bigint", parent_id: "bigint", title: "text", body: "text", z: "decimal",
          author_id: "bigint", created_at: "timestamp", updated_by: "bigint", updated_at: "timestamp", deleted: "bool",
        },
      },
      {
        name: "docs_updates", parent: null,
        columns: { channel_id: "bigint", page_id: "bigint", data: "text", author_id: "bigint", created_at: "timestamp" },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const page = (id: unknown): JsonRow => {
      const [row] = data.select("docs_pages", { id: Number(id) });
      if (!row) throw new InvalidRequest(`Unknown page ${id}`);
      return row;
    };
    const title = (v: unknown) => {
      const t = String(v ?? "").trim();
      if (!t || t.length > 200) throw new InvalidRequest("Page titles are 1 to 200 characters.");
      return t;
    };
    const checkParent = (channelId: number, parentId: number | null, pageId?: number) => {
      for (let p = parentId; p !== null; p = page(p).parent_id === null ? null : Number(page(p).parent_id)) {
        if (Number(page(p).channel_id) !== channelId) throw new InvalidRequest("A page's parent must be in the same channel.");
        if (p === pageId) throw new InvalidRequest("A page can't go inside itself.");
      }
    };
    const top = (channelId: number, parentId: number | null) =>
      Math.max(0, ...data.select("docs_pages", { channel_id: channelId, parent_id: parentId }).map((p) => Number(p.z)));

    onApi("list-pages", "Lists a channel's pages without their text: { rows } (id, parent_id, title, z, updated_by, updated_at).",
      [{ name: "channel_id", type: "bigint", description: "The docs channel." }],
      (r) => ({
        rows: data.select("docs_pages", { channel_id: Number(r.args.channel_id) }).filter((p) => p.deleted !== true)
          .map(({ body: _body, ...rest }) => rest),
      }));

    onApi("get-page", "One page with its text: { page }.",
      [{ name: "page_id", type: "bigint", description: "The page." }],
      (r) => ({ page: page(r.args.page_id) }));

    onApi("add-page", "Adds a page at the end of its parent (or the top level); returns { id }.",
      [
        { name: "channel_id", type: "bigint", description: "The docs channel." },
        { name: "parent_id", type: "bigint", required: false, description: "The page it goes in; none for the top level." },
        { name: "title", type: "text", description: "The title." },
        { name: "body", type: "text", required: false, description: "Markdown." },
      ],
      (r) => {
        const channelId = Number(r.args.channel_id);
        const parentId = r.args.parent_id == null ? null : Number(r.args.parent_id);
        checkParent(channelId, parentId);
        const now = new Date().toISOString();
        return {
          id: data.insert("docs_pages", {
            channel_id: channelId, parent_id: parentId, title: title(r.args.title), body: r.args.body ?? "",
            z: top(channelId, parentId) + 1, author_id: r.userId, created_at: now, updated_by: r.userId, updated_at: now, deleted: false,
          }),
        };
      });

    onApi("update-page", "Changes a page's title or text; returns { updated }.",
      [
        { name: "page_id", type: "bigint", description: "The page." },
        { name: "title", type: "text", required: false, description: "The new title." },
        { name: "body", type: "text", required: false, description: "The new markdown." },
      ],
      (r) => {
        const row = page(r.args.page_id);
        const values: Record<string, unknown> = { updated_by: r.userId, updated_at: new Date().toISOString() };
        if (r.args.title != null) values.title = title(r.args.title);
        if (r.args.body != null) values.body = r.args.body;
        return { updated: data.update("docs_pages", values, { id: row.id }) };
      });

    onApi("move-page", "Puts a page in another parent (or the top level) at position z; returns { updated }.",
      [
        { name: "page_id", type: "bigint", description: "The page." },
        { name: "parent_id", type: "bigint", required: false, description: "The new parent; none for the top level." },
        { name: "z", type: "decimal", description: "Order among its siblings." },
      ],
      (r) => {
        const row = page(r.args.page_id);
        const parentId = r.args.parent_id == null ? null : Number(r.args.parent_id);
        checkParent(Number(row.channel_id), parentId, row.id);
        return { updated: data.update("docs_pages", { parent_id: parentId, z: r.args.z }, { id: row.id }) };
      });

    // Deleting only hides pages, so undo can bring them back with the same ids.
    onApi("remove-pages", "Deletes pages (JSON list of ids; restore-pages undoes it). Returns { deleted }.",
      [{ name: "ids", type: "text", description: "The pages, as JSON text." }],
      (r) => ({ deleted: idList(r.args.ids, "ids").reduce((n, id) => n + data.update("docs_pages", { deleted: true }, { id: page(id).id }), 0) }));

    onApi("restore-pages", "Brings back deleted pages (JSON list of ids). Returns { restored }.",
      [{ name: "ids", type: "text", description: "The pages, as JSON text." }],
      (r) => ({ restored: idList(r.args.ids, "ids").reduce((n, id) => n + data.update("docs_pages", { deleted: false }, { id: page(id).id }), 0) }));

    onApi("list-updates", "A page's text updates, oldest first: { rows } (id, data).",
      [{ name: "page_id", type: "bigint", description: "The page." }],
      (r) => ({ rows: data.select("docs_updates", { page_id: Number(r.args.page_id) }).map((u) => ({ id: u.id, data: u.data })) }));

    onApi("add-update", "Adds a text update to a page, and its text now as the plain copy; returns { id }.",
      [
        { name: "page_id", type: "bigint", description: "The page." },
        { name: "data", type: "text", description: "A Yjs update, base64." },
        { name: "body", type: "text", required: false, description: "The page's whole text after it." },
        { name: "replaces", type: "text", required: false, description: "JSON list of update ids this one contains, removed." },
      ],
      (r) => {
        const row = page(r.args.page_id);
        if (!/^[A-Za-z0-9+/=]+$/.test(String(r.args.data))) throw new InvalidRequest("'data' must be base64.");
        const now = new Date().toISOString();
        const id = data.insert("docs_updates", { channel_id: row.channel_id, page_id: row.id, data: r.args.data, author_id: r.userId, created_at: now });
        if (r.args.replaces != null)
          for (const old of idList(r.args.replaces, "replaces")) data.delete("docs_updates", { id: old, page_id: row.id });
        const values: Record<string, unknown> = { updated_by: r.userId, updated_at: now };
        if (r.args.body != null) values.body = r.args.body;
        data.update("docs_pages", values, { id: row.id });
        return { id };
      });

    onApiRead((r) => data.select(r.table, r.where));
  },
};
