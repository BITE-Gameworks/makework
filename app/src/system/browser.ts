// Shared browser channels: the page the channel is on, its history and its bookmarks. The page is written only once
// it settles, and everything live (clicks, keys, scrolling) goes between members directly.
import type { MockPlugin } from "./backend";
import { InvalidRequest } from "./errors";

const webUrl = (value: unknown): string => {
  const url = String(value ?? "").trim();
  if (!/^https?:\/\//i.test(url) || url.length > 4096) throw new InvalidRequest("Only http and https addresses work here.");
  return url;
};
const extensionId = (value: unknown): string => {
  const id = String(value ?? "").trim();
  if (!/^[a-p]{32}$/.test(id)) throw new InvalidRequest("Use a Chrome Web Store extension id.");
  return id;
};
// A channel keeps this many history entries; older ones are dropped as new pages are visited.
const historyLimit = 300;

export const browser: MockPlugin = {
  manifest: {
    name: "browser",
    version: "1.0.0",
    description: "A web browser the members of a channel use together: its current page, history and bookmarks.",
    tables: [
      {
        name: "browser_pages", parent: null,
        columns: { channel_id: "bigint", url: "text", title: "text", changed_by: "bigint", changed_at: "timestamp" },
      },
      {
        name: "browser_history", parent: null,
        columns: { channel_id: "bigint", url: "text", title: "text", author_id: "bigint", visited_at: "timestamp" },
      },
      {
        name: "browser_bookmarks", parent: null,
        columns: {
          channel_id: "bigint", url: "text", title: "text", z: "decimal",
          author_id: "bigint", created_at: "timestamp", deleted: "bool",
        },
      },
      {
        // Each desktop fetches the package from the Chrome Web Store. The workspace only keeps the shared choice.
        name: "browser_extensions", parent: null,
        columns: {
          extension_id: "text", name: "text", version: "text", author_id: "bigint", created_at: "timestamp", deleted: "bool",
        },
      },
      {
        name: "browser_channel_extensions", parent: null,
        columns: { channel_id: "bigint", extension_id: "text", enabled: "bool" },
      },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const bookmark = (id: unknown) => {
      const [row] = data.select("browser_bookmarks", { id: id as number });
      if (!row) throw new InvalidRequest(`Unknown bookmark ${id}`);
      return row;
    };

    onApi("get-page", "The page a browser channel is on: { url, title } or { url: null }.",
      [{ name: "channel_id", type: "bigint", description: "The browser channel." }],
      (r) => {
        const [row] = data.select("browser_pages", { channel_id: r.args.channel_id });
        return row ? { url: row.url, title: row.title } : { url: null, title: null };
      });

    onApi("set-page", "Sets the page a browser channel is on; returns { changed }.",
      [
        { name: "channel_id", type: "bigint", description: "The browser channel." },
        { name: "url", type: "text", description: "An http or https address." },
        { name: "title", type: "text", required: false, description: "The page's title." },
      ],
      (r) => {
        const url = webUrl(r.args.url);
        const title = String(r.args.title ?? "").slice(0, 300);
        const [row] = data.select("browser_pages", { channel_id: r.args.channel_id });
        if (row?.url === url && row.title === title) return { changed: false };
        const values = { url, title, changed_by: r.userId, changed_at: new Date().toISOString() };
        if (row) data.update("browser_pages", values, { id: row.id });
        else data.insert("browser_pages", { channel_id: r.args.channel_id, ...values });
        const history = data.select("browser_history", { channel_id: r.args.channel_id });
        const last = history.at(-1);
        if (last?.url === url) {
          if (last.title !== title) data.update("browser_history", { title }, { id: last.id });
        } else {
          data.insert("browser_history", { channel_id: r.args.channel_id, url, title, author_id: r.userId, visited_at: values.changed_at });
          for (const old of history.slice(0, Math.max(0, history.length + 1 - historyLimit))) data.delete("browser_history", { id: old.id });
        }
        return { changed: true };
      });

    onApi("clear-page", "Closes the page of a browser channel; returns { cleared }.",
      [{ name: "channel_id", type: "bigint", description: "The browser channel." }],
      (r) => ({ cleared: data.delete("browser_pages", { channel_id: r.args.channel_id }) > 0 }));

    onApi("list-history", "Lists the pages a browser channel visited, newest first: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The browser channel." }],
      (r) => ({ rows: data.select("browser_history", { channel_id: r.args.channel_id }).reverse() }));

    onApi("clear-history", "Deletes a browser channel's history; returns { deleted }.",
      [{ name: "channel_id", type: "bigint", description: "The browser channel." }],
      (r) => ({ deleted: data.delete("browser_history", { channel_id: r.args.channel_id }) }));

    onApi("list-bookmarks", "Lists a browser channel's bookmarks in order: { rows }.",
      [{ name: "channel_id", type: "bigint", description: "The browser channel." }],
      (r) => ({
        rows: data.select("browser_bookmarks", { channel_id: r.args.channel_id }).filter((b) => b.deleted !== true)
          .sort((a, b) => Number(a.z) - Number(b.z)),
      }));

    onApi("add-bookmark", "Adds a bookmark at the end; returns its id.",
      [
        { name: "channel_id", type: "bigint", description: "The browser channel." },
        { name: "url", type: "text", description: "An http or https address." },
        { name: "title", type: "text", required: false, description: "The name shown." },
      ],
      (r) => {
        const z = Math.max(0, ...data.select("browser_bookmarks", { channel_id: r.args.channel_id }).map((b) => Number(b.z))) + 1;
        return {
          id: data.insert("browser_bookmarks", {
            channel_id: r.args.channel_id, url: webUrl(r.args.url), title: String(r.args.title ?? "").slice(0, 300), z,
            author_id: r.userId, created_at: new Date().toISOString(), deleted: false,
          }),
        };
      });

    onApi("rename-bookmark", "Renames a bookmark; returns { updated }.",
      [
        { name: "bookmark_id", type: "bigint", description: "The bookmark." },
        { name: "title", type: "text", description: "The new name." },
      ],
      (r) => ({ updated: data.update("browser_bookmarks", { title: String(r.args.title).slice(0, 300) }, { id: bookmark(r.args.bookmark_id).id }) }));

    // Deleting only hides the bookmark, so undo can bring it back with the same id.
    onApi("remove-bookmark", "Deletes a bookmark (restore-bookmark undoes it); returns { deleted }.",
      [{ name: "bookmark_id", type: "bigint", description: "The bookmark." }],
      (r) => ({ deleted: data.update("browser_bookmarks", { deleted: true }, { id: bookmark(r.args.bookmark_id).id }) }));

    onApi("restore-bookmark", "Brings back a deleted bookmark; returns { restored }.",
      [{ name: "bookmark_id", type: "bigint", description: "The bookmark." }],
      (r) => ({ restored: data.update("browser_bookmarks", { deleted: false }, { id: bookmark(r.args.bookmark_id).id }) }));

    const extension = (id: unknown) => {
      const extensionId_ = extensionId(id);
      const row = data.select("browser_extensions", { extension_id: extensionId_ }).find((item) => item.deleted !== true);
      if (!row) throw new InvalidRequest("This Chrome Web Store extension is not installed in the workspace.");
      return row;
    };

    onApi("list-extensions", "Lists Chrome Web Store extensions installed in this workspace.", [],
      () => ({ rows: data.select("browser_extensions", {}).filter((row) => row.deleted !== true) }));

    onApi("install-extension", "Installs a Chrome Web Store extension in this workspace.",
      [
        { name: "extension_id", type: "text", description: "The 32-character Chrome Web Store extension id." },
        { name: "name", type: "text", description: "The extension name from its manifest." },
        { name: "version", type: "text", description: "The extension version from its manifest." },
      ],
      (r) => {
        const id = extensionId(r.args.extension_id);
        const name = String(r.args.name ?? "").trim().slice(0, 200);
        const version = String(r.args.version ?? "").trim().slice(0, 100);
        if (!name || !version) throw new InvalidRequest("The extension name and version are required.");
        const [existing] = data.select("browser_extensions", { extension_id: id });
        if (existing && existing.deleted !== true) throw new InvalidRequest("That extension is already installed in this workspace.");
        const values = { name, version, author_id: r.userId, created_at: new Date().toISOString(), deleted: false };
        if (existing) return { restored: data.update("browser_extensions", values, { id: existing.id }) };
        return { id: data.insert("browser_extensions", { extension_id: id, ...values }) };
      });

    onApi("remove-extension", "Removes a Chrome Web Store extension from this workspace and disables it in its channels.",
      [{ name: "extension_id", type: "text" }],
      (r) => {
        const row = extension(r.args.extension_id);
        data.update("browser_channel_extensions", { enabled: false }, { extension_id: row.extension_id });
        return { removed: data.update("browser_extensions", { deleted: true }, { id: row.id }) };
      });

    onApi("set-channel-extension", "Enables or disables a workspace extension in one browser channel.",
      [
        { name: "channel_id", type: "bigint", description: "The browser channel." },
        { name: "extension_id", type: "text", description: "The installed Chrome Web Store extension." },
        { name: "enabled", type: "bool" },
      ],
      (r) => {
        const extensionId_ = String(extension(r.args.extension_id).extension_id);
        const [existing] = data.select("browser_channel_extensions", { channel_id: r.args.channel_id, extension_id: extensionId_ });
        if (existing) return { updated: data.update("browser_channel_extensions", { enabled: r.args.enabled }, { id: existing.id }) };
        return { id: data.insert("browser_channel_extensions", { channel_id: r.args.channel_id, extension_id: extensionId_, enabled: r.args.enabled }) };
      });

    onApi("list-channel-extensions", "Lists extension enablement for a browser channel.",
      [{ name: "channel_id", type: "bigint" }],
      (r) => ({ rows: data.select("browser_channel_extensions", { channel_id: r.args.channel_id }) }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};
