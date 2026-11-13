// Roles with permissions, who has which role, and bans. Who may change these is decided
// by the workspace's policy (p2p/policy.ts), checked by every member; the functions here only shape the changes.
import type { MockPlugin } from "./backend";
import { InvalidRequest } from "./errors";
import { defaultPermissions, isMuteKind, isPermission } from "../p2p/permissions";

export const roles: MockPlugin = {
  manifest: {
    name: "roles",
    version: "1.0.0",
    description: "Roles, their permissions and members, bans and mutes.",
    tables: [
      {
        name: "roles_roles", parent: null,
        // position: higher is more important; @everyone (everyone: true) is 0. permissions: names joined by ",".
        // channels: whether it sees channels without visibility rules, "show" or "hide"; "" is like @everyone.
        // guest: the Guest role, which members who joined with a guest invite have instead of @everyone's permissions.
        columns: {
          name: "text", color: "text", position: "decimal", permissions: "text", everyone: "bool", mentionable: "bool", channels: "text", guest: "bool",
        },
      },
      { name: "roles_members", parent: "roles_roles", columns: { role_id: "bigint", user_id: "bigint" } },
      // name: theirs when banned, since a ban also removes their profile.
      { name: "roles_bans", parent: null, columns: { user_id: "bigint", name: "text", reason: "text", banned_by: "bigint", created_at: "timestamp" } },
      // kind: "voice" (nobody hears them in calls) or "chat" (no messages, reactions, votes or comments).
      { name: "roles_mutes", parent: null, columns: { user_id: "bigint", kind: "text", muted_by: "bigint", created_at: "timestamp" } },
    ],
  },

  register({ data, onApi, onApiRead }) {
    const role = (id: unknown) => {
      const [row] = data.select("roles_roles", { id });
      if (!row) throw new InvalidRequest(`Unknown role ${id}`);
      return row;
    };
    const cleanPermissions = (text: unknown) => {
      const names = String(text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      const unknown = names.find((p) => !isPermission(p));
      if (unknown) throw new InvalidRequest(`Unknown permission '${unknown}'.`);
      return [...new Set(names)].join(",");
    };
    const others = () => data.select("roles_roles").filter((r) => !r.everyone).sort((a, b) => Number(a.position) - Number(b.position));

    onApi("ensure-everyone", "Adds the @everyone role with the default permissions if the workspace has none; returns { id }.", [],
      () => {
        const [existing] = data.select("roles_roles", { everyone: true });
        if (existing) return { id: existing.id };
        return { id: data.insert("roles_roles", {
          name: "everyone", color: "", position: 0, permissions: defaultPermissions.join(","), everyone: true, mentionable: false,
        }) };
      });

    // Made with the first guest invite, by whoever may create invites.
    onApi("ensure-guest-role", "Adds the Guest role (Send messages) below every other role if the workspace has none; returns { id }.", [],
      () => {
        const [existing] = data.select("roles_roles", { guest: true });
        if (existing) return { id: existing.id };
        const lowest = others()[0];
        return { id: data.insert("roles_roles", {
          name: "Guest", color: "", position: lowest ? Number(lowest.position) / 2 : 1, permissions: "send_messages",
          everyone: false, mentionable: false, channels: "", guest: true,
        }) };
      });

    onApi("create-role", "Adds a role below every other role (above @everyone); returns its id.", [
      { name: "name", type: "text" },
      { name: "color", type: "text", required: false },
      { name: "permissions", type: "text", required: false, description: "Permission names joined by ','." },
    ], (r) => {
      const name = String(r.args.name).trim();
      if (!name) throw new InvalidRequest("A role needs a name.");
      const lowest = others()[0];
      const position = lowest ? Number(lowest.position) / 2 : 1024;
      return { id: data.insert("roles_roles", {
        name, color: r.args.color ?? "", position, permissions: cleanPermissions(r.args.permissions), everyone: false, mentionable: false,
      }) };
    });

    onApi("edit-role", "Sets a role's name, color, permissions, whether anyone may mention it and whether it sees channels without visibility rules; returns { updated }.", [
      { name: "id", type: "bigint" },
      { name: "name", type: "text" },
      { name: "color", type: "text", required: false },
      { name: "permissions", type: "text", required: false },
      { name: "mentionable", type: "bool", required: false },
      { name: "channels", type: "text", required: false, description: "'show', 'hide', or '' (like @everyone); unchanged when left out." },
    ], (r) => {
      const row = role(r.args.id);
      const name = row.everyone ? "everyone" : String(r.args.name).trim();
      if (!name) throw new InvalidRequest("A role needs a name.");
      const channels = r.args.channels ?? row.channels ?? "";
      if (!["", "show", "hide"].includes(String(channels))) throw new InvalidRequest("'channels' is 'show', 'hide' or ''.");
      return { updated: data.update("roles_roles", {
        name, color: r.args.color ?? "", permissions: cleanPermissions(r.args.permissions), mentionable: r.args.mentionable ?? false, channels,
      }, { id: row.id }) };
    });

    onApi("move-role", "Moves a role directly below another role, or to the top without below_id; returns { updated }.", [
      { name: "id", type: "bigint" },
      { name: "below_id", type: "bigint", required: false },
    ], (r) => {
      const row = role(r.args.id);
      if (row.everyone) throw new InvalidRequest("@everyone always stays at the bottom.");
      const list = others().filter((x) => x.id !== row.id).reverse();
      let position: number;
      if (r.args.below_id === null) position = list.length > 0 ? Number(list[0].position) + 1024 : 1024;
      else {
        const index = list.findIndex((x) => x.id === r.args.below_id);
        if (index < 0) throw new InvalidRequest(`Unknown role ${r.args.below_id}`);
        const above = Number(list[index].position);
        const below = list[index + 1] ? Number(list[index + 1].position) : 0;
        position = (above + below) / 2;
      }
      return { updated: data.update("roles_roles", { position }, { id: row.id }) };
    });

    onApi("delete-role", "Deletes a role and takes it off everyone; returns { deleted }.", [{ name: "id", type: "bigint" }], (r) => {
      const row = role(r.args.id);
      if (row.everyone) throw new InvalidRequest("@everyone can't be deleted.");
      for (const m of data.select("roles_members", { role_id: row.id })) data.delete("roles_members", { id: m.id });
      return { deleted: data.delete("roles_roles", { id: row.id }) > 0 };
    });

    onApi("assign-role", "Gives a member a role, or takes it away with remove: true; returns { changed }.", [
      { name: "user_id", type: "bigint" },
      { name: "role_id", type: "bigint" },
      { name: "remove", type: "bool", required: false },
    ], (r) => {
      const row = role(r.args.role_id);
      if (row.everyone) throw new InvalidRequest("Everyone has @everyone.");
      const existing = data.select("roles_members", { role_id: row.id, user_id: r.args.user_id });
      if (r.args.remove) return { changed: existing.length > 0 && data.delete("roles_members", { role_id: row.id, user_id: r.args.user_id }) > 0 };
      if (existing.length > 0) return { changed: false };
      data.insert("roles_members", { role_id: row.id, user_id: r.args.user_id });
      return { changed: true };
    });

    onApi("ban", "Bans a member: their changes from now on are refused by everyone. Returns { banned }.", [
      { name: "user_id", type: "bigint" },
      { name: "name", type: "text", required: false, description: "Their display name, kept with the ban." },
      { name: "reason", type: "text", required: false },
    ], (r) => {
      if (data.select("roles_bans", { user_id: r.args.user_id }).length > 0) return { banned: false };
      data.insert("roles_bans", {
        user_id: r.args.user_id, name: String(r.args.name ?? "").slice(0, 64), reason: r.args.reason ?? "", banned_by: r.userId,
        created_at: new Date().toISOString(),
      });
      return { banned: true };
    });

    onApi("kick", "Takes all of a member's roles away, as part of kicking them (members.kick removes the profile). Returns { removed }.", [
      { name: "user_id", type: "bigint" },
    ], (r) => ({ removed: data.delete("roles_members", { user_id: r.args.user_id }) }));

    onApi("unban", "Lifts a ban; returns { unbanned }.", [{ name: "user_id", type: "bigint" }], (r) =>
      ({ unbanned: data.delete("roles_bans", { user_id: r.args.user_id }) > 0 }));

    onApi("mute", "Mutes a member in calls (kind voice) or in chat (kind chat) until unmuted. Returns { muted }.", [
      { name: "user_id", type: "bigint" },
      { name: "kind", type: "text" },
    ], (r) => {
      if (!isMuteKind(r.args.kind)) throw new InvalidRequest("kind must be voice or chat.");
      if (data.select("roles_mutes", { user_id: r.args.user_id, kind: r.args.kind }).length > 0) return { muted: false };
      data.insert("roles_mutes", { user_id: r.args.user_id, kind: r.args.kind, muted_by: r.userId, created_at: new Date().toISOString() });
      return { muted: true };
    });

    onApi("unmute", "Lifts a voice or chat mute; returns { unmuted }.", [
      { name: "user_id", type: "bigint" },
      { name: "kind", type: "text" },
    ], (r) => ({ unmuted: data.delete("roles_mutes", { user_id: r.args.user_id, kind: r.args.kind }) > 0 }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};
