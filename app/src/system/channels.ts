// A workspace's name, icon, categories and channels. A channel's type is the
// name of the plugin that backs it (chat, voice, tasks, ...).
import type { MockPlugin } from "./backend";
import { parseDeclared } from "./declared";
import { InvalidRequest } from "./errors";

const channelName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pluginId = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const channels: MockPlugin = {
  manifest: {
    name: "channels",
    version: "1.0.0",
    description: "The workspace's categories and channels.",
    tables: [
      {
        name: "channels_workspace", parent: null,
        // welcome_channel_id: the chat channel where new members are greeted; none when empty.
        columns: { name: "text", short: "text", color: "text", icon: "text", welcome_channel_id: "bigint" },
      },
      { name: "channels_categories", parent: null, columns: { name: "text", position: "int" } },
      {
        name: "channels_channels", parent: "channels_categories",
        columns: { category_id: "bigint", name: "text", type: "text", position: "int", slow_mode: "int" },
      },
      {
        // Who sees a channel or category and who may change things in it (p2p/visibility.ts). target: "channel" |
        // "category"; subject: "role" | "member"; visible and edit: true, false, or null to leave it to others.
        name: "channels_visibility", parent: null,
        columns: { target: "text", target_id: "bigint", subject: "text", subject_id: "bigint", visible: "bool", edit: "bool" },
      },
      {
        // The plugins installed for this workspace (Part 2): one row per plugin, with its resolved declared data
        // manifest (as JSON text) and its .mwp package as a content reference. Its table schema is fixed after
        // registration; compatible package updates may replace the version, manifest and package.
        name: "channels_plugins", parent: null,
        columns: { plugin_id: "text", version: "text", manifest: "text", package: "text" },
      },
      {
        // Runtime state is separate from the immutable plugin registration so old data remains replayable.
        name: "channels_plugin_state", parent: null,
        columns: { plugin_id: "text", status: "text" },
      },
    ],
  },

  register({ data, onApi, onApiRead, onApiInsert, onApiUpdate, onApiDelete }) {
    onApi("add-channel", "Adds a channel at the end of a category; returns its id.",
      [
        { name: "category_id", type: "bigint", description: "The id of the category." },
        { name: "name", type: "text", description: "Lowercase a-z, digits and '-', up to 64 characters." },
        { name: "type", type: "text", description: "The plugin that backs the channel, e.g. chat." },
      ],
      (r) => {
        const name = String(r.args.name);
        if (!channelName.test(name)) throw new InvalidRequest("Channel names use lowercase a-z, digits and '-'.");
        if (data.select("channels_categories", { id: r.args.category_id }).length === 0)
          throw new InvalidRequest(`Unknown category ${r.args.category_id}`);
        const siblings = data.select("channels_channels", { category_id: r.args.category_id });
        if (siblings.some((c) => c.name === name)) throw new InvalidRequest(`'${name}' already exists in this category.`);
        const position = Math.max(0, ...siblings.map((c) => Number(c.position))) + 1;
        return { id: data.insert("channels_channels", { category_id: r.args.category_id, name, type: r.args.type, position }) };
      });

    // Adds the data side of an installed plugin. The package (a mwc: content reference) and the resolved declared
    // manifest (JSON) come with it; the policy checks the same things on every commit, including that the plugin's
    // data name doesn't shadow a built-in system plugin.
    onApi("add-plugin", "Adds an installed plugin's declared data tables to this workspace; returns its row id.",
      [
        { name: "plugin_id", type: "text", description: "The installed plugin's id." },
        { name: "version", type: "text", description: "The plugin's version." },
        { name: "manifest", type: "text", description: "The plugin's declared data manifest, as JSON." },
        { name: "package", type: "text", description: "The plugin's .mwp package for the workspace (a mwc: reference)." },
      ],
      (r) => {
        const id = String(r.args.plugin_id);
        if (!pluginId.test(id)) throw new InvalidRequest("plugin_id uses lowercase a-z, digits, '.' and '-'.");
        if (!String(r.args.version)) throw new InvalidRequest("The plugin's version is required.");
        if (data.select("channels_plugins", { plugin_id: id }).length > 0)
          throw new InvalidRequest(`'${id}' is already in this workspace.`);
        const declared = parseDeclared(String(r.args.manifest));
        for (const row of data.select("channels_plugins"))
          if (parseDeclared(String(row.manifest)).name === declared.name)
            throw new InvalidRequest(`'${declared.name}' is already in this workspace.`);
        return { id: data.insert("channels_plugins", {
          plugin_id: id, version: r.args.version, manifest: r.args.manifest, package: r.args.package,
        }) };
      });

    onApi("set-plugin-state", "Enables, disables or removes a registered plugin for the whole workspace; removal retains its data and history.",
      [
        { name: "plugin_id", type: "text" },
        { name: "status", type: "text", description: "enabled, disabled or removed." },
      ],
      (r) => {
        const id = String(r.args.plugin_id);
        if (!data.select("channels_plugins", { plugin_id: id }).length)
          throw new InvalidRequest(`'${id}' is not registered in this workspace.`);
        const status = String(r.args.status);
        if (!["enabled", "disabled", "removed"].includes(status))
          throw new InvalidRequest("Plugin status must be enabled, disabled or removed.");
        const [existing] = data.select("channels_plugin_state", { plugin_id: id });
        if (existing) return { updated: data.update("channels_plugin_state", { status }, { id: existing.id }) };
        return { id: data.insert("channels_plugin_state", { plugin_id: id, status }) };
      });

    onApi("update-plugin", "Replaces a registered plugin package with a newer version using the same declared data schema.",
      [
        { name: "plugin_id", type: "text" },
        { name: "version", type: "text" },
        { name: "manifest", type: "text" },
        { name: "package", type: "text" },
      ],
      (r) => {
        const id = String(r.args.plugin_id);
        const [existing] = data.select("channels_plugins", { plugin_id: id });
        if (!existing) throw new InvalidRequest(`'${id}' is not registered in this workspace.`);
        return { updated: data.update("channels_plugins", {
          version: r.args.version, manifest: r.args.manifest, package: r.args.package,
        }, { id: existing.id }) };
      });

    onApi("add-category", "Adds a category at the end; returns its id.",
      [{ name: "name", type: "text", description: "Up to 64 characters." }],
      (r) => {
        const name = String(r.args.name).trim();
        if (!name || name.length > 64) throw new InvalidRequest("Category names are 1 to 64 characters.");
        const position = Math.max(-1, ...data.select("channels_categories").map((c) => Number(c.position))) + 1;
        return { id: data.insert("channels_categories", { name, position }) };
      });

    onApi("rename-channel", "Renames a channel; returns { updated }.",
      [
        { name: "channel_id", type: "bigint", description: "The channel." },
        { name: "name", type: "text", description: "Lowercase a-z, digits and '-', up to 64 characters." },
      ],
      (r) => {
        const name = String(r.args.name);
        if (!channelName.test(name)) throw new InvalidRequest("Channel names use lowercase a-z, digits and '-'.");
        const [channel] = data.select("channels_channels", { id: r.args.channel_id });
        if (!channel) throw new InvalidRequest(`Unknown channel ${r.args.channel_id}`);
        if (data.select("channels_channels", { category_id: channel.category_id }).some((c) => c.name === name && c.id !== channel.id))
          throw new InvalidRequest(`'${name}' already exists in this category.`);
        return { updated: data.update("channels_channels", { name }, { id: channel.id }) };
      });

    onApi("set-slow-mode", "Sets the seconds a member without Manage messages must wait between messages (0 turns it off).",
      [
        { name: "channel_id", type: "bigint", description: "The channel." },
        { name: "seconds", type: "int", description: "0 to 86400." },
      ],
      (r) => {
        const seconds = Math.floor(Number(r.args.seconds));
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) throw new InvalidRequest("Slow mode is 0 to 86400 seconds.");
        return { updated: data.update("channels_channels", { slow_mode: seconds }, { id: r.args.channel_id }) };
      });

    onApi("rename-category", "Renames a category; returns { updated }.",
      [
        { name: "category_id", type: "bigint", description: "The category." },
        { name: "name", type: "text", description: "Up to 64 characters." },
      ],
      (r) => {
        const name = String(r.args.name).trim();
        if (!name || name.length > 64) throw new InvalidRequest("Category names are 1 to 64 characters.");
        return { updated: data.update("channels_categories", { name }, { id: r.args.category_id }) };
      });

    onApi("move-channel", "Moves a channel before another one, or to the end of a category; returns { moved }.",
      [
        { name: "channel_id", type: "bigint", description: "The channel." },
        { name: "category_id", type: "bigint", description: "The category it goes into." },
        { name: "before_id", type: "bigint", required: false, description: "The channel it goes before; none for the end." },
      ],
      (r) => {
        const [channel] = data.select("channels_channels", { id: r.args.channel_id });
        if (!channel) throw new InvalidRequest(`Unknown channel ${r.args.channel_id}`);
        const categoryId = Number(r.args.category_id);
        if (data.select("channels_categories", { id: categoryId }).length === 0) throw new InvalidRequest(`Unknown category ${categoryId}`);
        const siblings = data.select("channels_channels", { category_id: categoryId })
          .filter((c) => c.id !== channel.id)
          .sort((a, b) => Number(a.position) - Number(b.position) || a.id - b.id);
        if (siblings.some((c) => c.name === channel.name)) throw new InvalidRequest(`'${channel.name}' already exists in that category.`);
        const at = r.args.before_id == null ? -1 : siblings.findIndex((c) => c.id === Number(r.args.before_id));
        siblings.splice(at < 0 ? siblings.length : at, 0, channel);
        siblings.forEach((c, i) => {
          const changed = c.id === channel.id ? { category_id: categoryId, position: i + 1 } : { position: i + 1 };
          if (c.id === channel.id || Number(c.position) !== i + 1) data.update("channels_channels", changed, { id: c.id });
        });
        return { moved: true };
      });

    // The channel's own data stays in its plugin's tables (and in the workspace's history).
    onApi("delete-channel", "Removes a channel from the list; returns { deleted }.",
      [{ name: "channel_id", type: "bigint", description: "The channel." }],
      (r) => ({ deleted: data.delete("channels_channels", { id: r.args.channel_id }) > 0 }));

    onApi("delete-category", "Removes a category and every channel in it; returns { deleted } (channels removed).",
      [{ name: "category_id", type: "bigint", description: "The category." }],
      (r) => {
        const deleted = data.delete("channels_channels", { category_id: r.args.category_id });
        data.delete("channels_categories", { id: r.args.category_id });
        return { deleted };
      });

    // One setting of a rule; the rule goes once neither setting is left.
    const setRule = (args: Record<string, unknown>, field: "visible" | "edit", value: unknown) => {
      const { target, target_id, subject, subject_id } = args;
      if (target !== "channel" && target !== "category") throw new InvalidRequest("'target' is 'channel' or 'category'.");
      if (subject !== "role" && subject !== "member") throw new InvalidRequest("'subject' is 'role' or 'member'.");
      const table = target === "channel" ? "channels_channels" : "channels_categories";
      if (data.select(table, { id: target_id as number }).length === 0) throw new InvalidRequest(`Unknown ${target} ${target_id}`);
      const key = { target, target_id: target_id as number, subject, subject_id: subject_id as number };
      const [existing] = data.select("channels_visibility", key);
      const next = value === true || value === false ? value : null;
      if (!existing) {
        if (next === null) return { changed: false };
        data.insert("channels_visibility", { ...key, visible: null, edit: null, [field]: next });
        return { changed: true };
      }
      if ((existing[field] ?? null) === next) return { changed: false };
      const other = field === "visible" ? "edit" : "visible";
      if (next === null && typeof existing[other] !== "boolean") data.delete("channels_visibility", { id: existing.id });
      else data.update("channels_visibility", { [field]: next }, { id: existing.id });
      return { changed: true };
    };
    const ruleArgs = [
      { name: "target", type: "text" as const, description: "'channel' or 'category'." },
      { name: "target_id", type: "bigint" as const, description: "The channel or category." },
      { name: "subject", type: "text" as const, description: "'role' or 'member'." },
      { name: "subject_id", type: "bigint" as const, description: "The role, or the member's user id." },
    ];

    onApi("set-visibility", "Shows or hides a channel or category for a role or member, or leaves it to other rules with visible null; returns { changed }.",
      [...ruleArgs, { name: "visible", type: "bool", required: false, description: "true shows, false hides, none removes this setting." }],
      (r) => setRule(r.args, "visible", r.args.visible));

    onApi("set-edit", "Lets a role or member change things in a channel or category, or makes it read-only for them, or leaves it to other rules with edit null; returns { changed }.",
      [...ruleArgs, { name: "edit", type: "bool", required: false, description: "true allows, false makes it read-only, none removes this setting." }],
      (r) => setRule(r.args, "edit", r.args.edit));

    onApiRead((r) => data.select(r.table, r.where));
    onApiInsert((r) => data.insert(r.table, r.values));
    onApiUpdate((r) => data.update(r.table, r.values, r.where));
    onApiDelete((r) => data.delete(r.table, r.where));
  },
};
