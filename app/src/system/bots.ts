import type { MockPlugin } from "./backend";
import { botUsername } from "../core/botName";
import { InvalidRequest } from "./errors";

const botType = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// A bot's memory (keys and values together).
export const memoryLimit = 64 * 1024;
const statuses = new Set(["enabled", "disabled"]);
const funnyNames = ["Waffle", "Biscuit", "Pickle", "Noodle", "Muffin", "Gizmo", "Sprout", "Pogo", "Zigzag", "Button"];
const defaultNickname = (id: number) => `${funnyNames[Math.abs(id) % funnyNames.length]} ${100 + (Math.abs(id) % 900)}`;

export const bots: MockPlugin = {
  manifest: {
    name: "bots",
    version: "0.1.0",
    description: "Workspace bots and the member whose devices run them.",
    tables: [{
      name: "bots_bots", parent: null,
      columns: {
        user_id: "bigint", type: "text", username: "text", bot_number: "int", nickname: "text", config: "text", created_by: "bigint",
        // lease_until and log are no longer written (running and logs stay on the devices); kept for old history.
        host: "bigint", lease_until: "timestamp", enabled: "bool", status: "text", log: "text",
      },
    }, {
      name: "bots_credentials", parent: null,
      columns: { name: "text", created_by: "bigint" },
    }, {
      name: "bots_credential_shares", parent: "bots_credentials",
      columns: { credential_id: "bigint", user_id: "bigint", sealed: "text" },
    }, {
      name: "bots_memory", parent: null,
      columns: { bot_id: "bigint", key: "text", value: "text" },
    }, {
      // Workspace-wide defaults for agents (for example "maxSteps"), set by members who manage bots.
      name: "bots_defaults", parent: null,
      columns: { key: "text", value: "text" },
    }, {
      // The workspace index agents keep: a short summary and tags per channel, page or note. channel_id is null for
      // notes that belong to no channel; source_hash tells when the summary is stale.
      name: "bots_context", parent: null,
      columns: { bot_id: "bigint", channel_id: "bigint", kind: "text", ref: "text", title: "text", summary: "text", tags: "text", source_hash: "text" },
    }],
  },

  register({ data, onApi, onApiRead }) {
    const get = (id: unknown) => {
      const [row] = data.select("bots_bots", { id });
      if (!row) throw new InvalidRequest(`Unknown bot ${id}.`);
      return row;
    };
    const cleanType = (value: unknown) => {
      const type = String(value ?? "").trim().toLowerCase();
      if (!botType.test(type)) throw new InvalidRequest("That bot type is not valid.");
      return type;
    };
    const cleanConfig = (value: unknown) => {
      try {
        const parsed = JSON.parse(String(value ?? "{}"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return JSON.stringify(parsed);
      } catch {
        throw new InvalidRequest("Bot settings must be a JSON object.");
      }
    };

    onApi("create", "Creates a bot registration. The profile is added by the host after this succeeds.", [
      { name: "user_id", type: "bigint" }, { name: "type", type: "text" }, { name: "nickname", type: "text" },
      { name: "config", type: "text", required: false }, { name: "host", type: "bigint", required: false },
    ], (r) => {
      const userId = Number(r.args.user_id);
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new InvalidRequest("That bot account is not valid.");
      if (data.select("bots_bots", { user_id: userId }).length) throw new InvalidRequest("That bot already exists.");
      const nickname = String(r.args.nickname ?? "").trim().slice(0, 48) || defaultNickname(userId);
      const type = cleanType(r.args.type);
      const siblings = data.select("bots_bots", { type });
      const botNumber = siblings.reduce((max, row, index) => Math.max(max, Number(row.bot_number) || index + 1), 0) + 1;
      const username = botUsername(type);
      return { id: data.insert("bots_bots", {
        user_id: userId, type, username, bot_number: botNumber, nickname, config: cleanConfig(r.args.config),
        created_by: r.userId, host: Number(r.args.host ?? r.userId), lease_until: null, enabled: true, status: "enabled", log: "",
      }), nickname, username, bot_number: botNumber };
    });

    onApi("update", "Changes a bot's nickname, settings, host or enabled state.", [
      { name: "id", type: "bigint" }, { name: "nickname", type: "text", required: false },
      { name: "config", type: "text", required: false }, { name: "host", type: "bigint", required: false },
      { name: "enabled", type: "bool", required: false },
    ], (r) => {
      const row = get(r.args.id);
      const values: Record<string, unknown> = {};
      if (r.args.nickname !== null && r.args.nickname !== undefined) {
        values.nickname = String(r.args.nickname).trim().slice(0, 48) || defaultNickname(Number(row.user_id));
      }
      if (r.args.config !== null && r.args.config !== undefined) values.config = cleanConfig(r.args.config);
      if (r.args.host !== null && r.args.host !== undefined) values.host = Number(r.args.host);
      if (r.args.enabled !== null && r.args.enabled !== undefined) values.enabled = r.args.enabled === true;
      if (Object.keys(values).length === 0) return { updated: false };
      return { updated: data.update("bots_bots", values, { id: row.id }) > 0 };
    });

    onApi("set-status", "Enables or disables a bot without deleting its history.", [
      { name: "id", type: "bigint" }, { name: "status", type: "text" },
    ], (r) => {
      const row = get(r.args.id);
      const status = String(r.args.status);
      if (!statuses.has(status)) throw new InvalidRequest("Bot status must be enabled or disabled.");
      return { updated: data.update("bots_bots", { status, enabled: status === "enabled" }, { id: row.id }) > 0 };
    });

    onApi("remove", "Removes a bot registration; its member profile is retained for history.", [
      { name: "id", type: "bigint" },
    ], (r) => {
      const id = get(r.args.id).id;
      data.delete("bots_memory", { bot_id: id });
      data.delete("bots_context", { bot_id: id });
      return { removed: data.delete("bots_bots", { id }) > 0 };
    });

    const memoryRows = (botId: unknown) => data.select("bots_memory", { bot_id: botId as number });
    const sizeOf = (row: Record<string, unknown>) => String(row.key ?? "").length + String(row.value ?? "").length;

    onApi("memory-set", "Stores a value in a bot's memory (up to 64 KB per bot).", [
      { name: "bot_id", type: "bigint" }, { name: "key", type: "text" }, { name: "value", type: "text" },
    ], (r) => {
      const bot = get(r.args.bot_id);
      const key = String(r.args.key ?? "").slice(0, 120);
      const value = String(r.args.value ?? "");
      if (!key) throw new InvalidRequest("A memory needs a key.");
      const rows = memoryRows(bot.id);
      const old = rows.find((row) => row.key === key);
      const total = rows.reduce((sum, row) => sum + sizeOf(row), 0) - (old ? sizeOf(old) : 0) + key.length + value.length;
      if (total > memoryLimit) throw new InvalidRequest("The bot's memory is full.");
      if (old) data.update("bots_memory", { value }, { id: old.id });
      else data.insert("bots_memory", { bot_id: bot.id, key, value });
      return { size: total };
    });

    onApi("memory-delete", "Removes one value from a bot's memory.", [
      { name: "bot_id", type: "bigint" }, { name: "key", type: "text" },
    ], (r) => ({ removed: data.delete("bots_memory", { bot_id: get(r.args.bot_id).id, key: String(r.args.key) }) > 0 }));

    onApi("memory-clear", "Empties a bot's memory.", [{ name: "bot_id", type: "bigint" }],
      (r) => ({ removed: data.delete("bots_memory", { bot_id: get(r.args.bot_id).id }) }));

    onApi("set-default", "Sets a workspace-wide default for agents (an empty value removes it).", [
      { name: "key", type: "text" }, { name: "value", type: "text" },
    ], (r) => {
      const key = String(r.args.key ?? "").slice(0, 60);
      const value = String(r.args.value ?? "").slice(0, 200);
      if (!/^[a-zA-Z][\w-]*$/.test(key)) throw new InvalidRequest("That default's name is not valid.");
      const old = data.select("bots_defaults", { key })[0];
      if (!value) return { removed: old ? data.delete("bots_defaults", { id: old.id }) : 0 };
      if (old) data.update("bots_defaults", { value }, { id: old.id });
      else data.insert("bots_defaults", { key, value });
      return { set: true };
    });

    const contextRows = 3000;
    onApi("context-set", "Writes (or replaces) an entry of the workspace index: a short summary and tags.", [
      { name: "bot_id", type: "bigint" }, { name: "ref", type: "text" }, { name: "kind", type: "text" }, { name: "title", type: "text" },
      { name: "summary", type: "text" }, { name: "tags", type: "text", required: false }, { name: "channel_id", type: "bigint", required: false },
      { name: "source_hash", type: "text", required: false },
    ], (r) => {
      const bot = get(r.args.bot_id);
      const ref = String(r.args.ref ?? "").slice(0, 120);
      if (!ref) throw new InvalidRequest("An index entry needs a reference.");
      const channelId = r.args.channel_id === null || r.args.channel_id === undefined ? null : Number(r.args.channel_id);
      const values = {
        bot_id: bot.id, channel_id: channelId, kind: String(r.args.kind ?? "").slice(0, 24), ref,
        title: String(r.args.title ?? "").slice(0, 160), summary: String(r.args.summary ?? "").slice(0, 700),
        tags: String(r.args.tags ?? "").slice(0, 200), source_hash: String(r.args.source_hash ?? "").slice(0, 24),
      };
      const old = data.select("bots_context", { ref }).find((row) => row.channel_id === channelId);
      if (old) {
        data.update("bots_context", values, { id: old.id });
        return { id: old.id };
      }
      if (data.select("bots_context").length >= contextRows) throw new InvalidRequest("The workspace index is full.");
      return { id: data.insert("bots_context", values) };
    });

    onApi("context-delete", "Removes entries of the workspace index by reference.", [
      { name: "ref", type: "text" },
    ], (r) => ({ removed: data.delete("bots_context", { ref: String(r.args.ref) }) }));

    onApi("context-clear", "Empties the workspace index entries one bot wrote.", [{ name: "bot_id", type: "bigint" }],
      (r) => ({ removed: data.delete("bots_context", { bot_id: get(r.args.bot_id).id }) }));

    const cleanShares = (value: unknown): { user_id: number; sealed: string }[] => {
      try {
        const list = JSON.parse(String(value ?? "[]"));
        if (!Array.isArray(list) || list.length === 0) throw new Error("not a list with entries");
        return list.map((s) => {
          if (!Number.isSafeInteger(s?.user_id) || typeof s?.sealed !== "string") throw new Error("not a share");
          return { user_id: s.user_id, sealed: s.sealed };
        });
      } catch {
        throw new InvalidRequest("Shares must be a JSON list of { user_id, sealed }.");
      }
    };
    const credential = (id: unknown) => {
      const [row] = data.select("bots_credentials", { id });
      if (!row) throw new InvalidRequest(`Unknown credential ${id}.`);
      return row;
    };

    onApi("credential-create", "Stores a credential: its name and the secret sealed to each holder. Returns { id }.", [
      { name: "name", type: "text" }, { name: "shares", type: "text" },
    ], (r) => {
      const name = String(r.args.name ?? "").trim().slice(0, 64);
      if (!name) throw new InvalidRequest("A credential needs a name.");
      const id = data.insert("bots_credentials", { name, created_by: r.userId });
      for (const share of cleanShares(r.args.shares)) data.insert("bots_credential_shares", { credential_id: id, ...share });
      return { id };
    });

    onApi("credential-replace", "Replaces a credential's secret: new shares for every holder.", [
      { name: "id", type: "bigint" }, { name: "shares", type: "text" },
    ], (r) => {
      const row = credential(r.args.id);
      data.delete("bots_credential_shares", { credential_id: row.id });
      for (const share of cleanShares(r.args.shares)) data.insert("bots_credential_shares", { credential_id: row.id, ...share });
      return { updated: true };
    });

    onApi("credential-share", "Gives another holder a credential the signed-in member can read.", [
      { name: "id", type: "bigint" }, { name: "user_id", type: "bigint" }, { name: "sealed", type: "text" },
    ], (r) => ({ id: data.insert("bots_credential_shares", { credential_id: credential(r.args.id).id, user_id: r.args.user_id, sealed: r.args.sealed }) }));

    onApi("credential-remove", "Deletes a credential and its shares.", [{ name: "id", type: "bigint" }], (r) => {
      const row = credential(r.args.id);
      data.delete("bots_credential_shares", { credential_id: row.id });
      return { removed: data.delete("bots_credentials", { id: row.id }) > 0 };
    });

    onApiRead((r) => data.select(r.table, r.where));
  },
};
