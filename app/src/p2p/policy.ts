// Who may change what in a serverless workspace. Checked for every change of every commit, against the tables as
// they were at that commit's place in the log, by every member. Tables without a rule are the owner's only.
import type { ApiValue } from "../api/types";
import type { PolicyContext, Policy } from "./ledger";
import { epochsOf, mayRead, mayReadChannel } from "./chatKeys";
import { channelPermissions, isMuteKind, kickedBy, permissionInfo, parsePermissions, roleTablesFrom, standing, type Permission, type RoleTables, type Row, type Standing } from "./permissions";
import { inviteOpen, inviteTokenKey, inviteUseText, inviteUseTextV2, inviteUses, validInviteTokenKey, verifyInviteProof } from "./invite";
import { accountIdOf } from "../core/identity";
import { pagePathRule, validPagePath } from "../system/nodes";
import { emojiNameProblem } from "../markdown/emoji";
import { emojiRowProblem } from "../system/emoji";
import { isSealed } from "../dm/crypto";
import { userNumberOf } from "./log";
import { canEditIn, canSee, hidesByDefault } from "./visibility";
import { parseDeclared, sameDeclaredSchema, type DeclaredManifest } from "../system/declared";
import { plugins as serverPlugins } from "./plugins";
import { botParent } from "../core/botConfig";

// Converted servers start with the owner's import of the old data; members replaying the log still need it.
const importAction = "workspace.import";
// A channel imported from a .zip (core/channelArchive.ts) keeps its rows' original authors.
export const channelImportAction = "channels.import-channel";

// The owner moving a member to another account (core/memberMove.ts): their rows change hands in several commits.
export const memberMoveAction = "members.move-member";

type Rule = (c: PolicyContext, me: Standing, roles: RoleTables) => string | null;

export const workspacePolicy: Policy = (c) => {
  if (c.action === importAction) return c.author === c.owner ? null : "Only the owner can import the workspace's data.";
  const roles = roleTables(c);
  const me = standing(roles, c.author, c.owner);
  if (me.banned) return "You are banned from this workspace.";
  if (c.op.ext === "members" && c.op.table === "members_snapshots" && c.action !== "workspace.snapshot")
    return "Snapshot records can only be added by a snapshot commit.";
  if (c.action === "workspace.snapshot") {
    if (c.op.ext !== "members" || c.op.table !== "members_snapshots" || c.op.kind !== "insert")
      return "A snapshot commit only adds its signed snapshot record.";
    return me.owner || (!removed(c) && me.permissions.has("manage_history")) ? null : need(me, "manage_history");
  }
  if (c.action === channelImportAction) return channelImport(c, me);
  if (c.action === memberMoveAction) return me.owner ? memberMove(c) : "Only the owner can move a member to another account.";
  if (c.op.ext === "channels" && c.op.table === "channels_plugins") {
    const invalid = validatePluginRegistration(c);
    if (invalid) return invalid;
  }
  if (c.op.ext === "channels" && c.op.table === "channels_plugin_state") {
    const invalid = validatePluginState(c);
    if (invalid) return invalid;
  }
  if (c.op.ext === "emoji" && c.op.table === "emoji_emojis") {
    const invalid = validateEmoji(c);
    if (invalid) return invalid;
  }
  if (me.owner) return null;
  if (removed(c)) return "You were removed from this workspace. Join again with an invite.";
  const channel = channelOf(c);
  const hidden = channel ? hiddenChannel(c, roles, channel) : null;
  if (hidden) return hidden;
  if (c.op.ext === "sheets") {
    const op = c.op;
    const sheet = op.table === "sheets_sheets"
      ? c.before ?? c.after
      : op.table === "sheets_cells" || op.table === "sheets_rules"
        ? c.rows("sheets", "sheets_sheets").find((row) => Number(row.id) === Number((c.after ?? c.before)?.sheet_id))
        : undefined;
    if (sheet?.locked === true) {
      const unlock = op.table === "sheets_sheets" && op.kind === "update"
        && c.before?.locked === true && c.after?.locked === false;
      if (!unlock || !me.permissions.has("manage_channels"))
        return unlock ? "Only a workspace manager can unlock a locked sheet." : "This sheet is locked.";
      return fixed(c, "channel_id");
    }
  }
  const rule = rules[`${c.op.ext}/${c.op.table}`];
  if (rule) return rule(c, channel ? inChannel(c, roles, me, channel) : me, roles);
  const declaredRule = declared(c, channel, channel ? inChannel(c, roles, me, channel) : me);
  return declaredRule === undefined ? `Only the owner can change ${c.op.table}.` : declaredRule;
};

// Rows that belong to a channel through another row, and the column that names it.
export const rowParents: Record<string, { ext: string; table: string; column: string }> = {
  "chat/chat_reactions": { ext: "chat", table: "chat_messages", column: "message_id" },
  "chat/chat_attachments": { ext: "chat", table: "chat_messages", column: "message_id" },
  "chat/chat_polls": { ext: "chat", table: "chat_messages", column: "message_id" },
  "chat/chat_poll_options": { ext: "chat", table: "chat_messages", column: "message_id" },
  "chat/chat_poll_votes": { ext: "chat", table: "chat_poll_options", column: "option_id" },
  "chat/chat_pins": { ext: "chat", table: "chat_messages", column: "message_id" },
  "tasks/tasks_task_tags": { ext: "tasks", table: "tasks_tasks", column: "task_id" },
  "tasks/tasks_assignees": { ext: "tasks", table: "tasks_tasks", column: "task_id" },
  "tasks/tasks_comments": { ext: "tasks", table: "tasks_tasks", column: "task_id" },
  "tasks/tasks_reactions": { ext: "tasks", table: "tasks_tasks", column: "task_id" },
  "tasks/tasks_dependencies": { ext: "tasks", table: "tasks_tasks", column: "task_id" },
  "tasks/tasks_history": { ext: "tasks", table: "tasks_tasks", column: "task_id" },
  "git/git_branches": { ext: "git", table: "git_repos", column: "repo_id" },
  "git/git_commits": { ext: "git", table: "git_repos", column: "repo_id" },
  "diagram/diagram_shapes": { ext: "diagram", table: "diagram_pages", column: "page_id" },
  "diagram/diagram_edges": { ext: "diagram", table: "diagram_pages", column: "page_id" },
  "diagram/diagram_rows": { ext: "diagram", table: "diagram_shapes", column: "shape_id" },
  "sheets/sheets_cells": { ext: "sheets", table: "sheets_sheets", column: "sheet_id" },
  "sheets/sheets_rules": { ext: "sheets", table: "sheets_sheets", column: "sheet_id" },
  "watch/watch_items": { ext: "watch", table: "watch_parties", column: "party_id" },
  "watch/watch_guests": { ext: "watch", table: "watch_parties", column: "party_id" },
};

// The channel a changed row is in (its own channel_id, else its parent's), or null for server-wide rows.
function channelOf(c: PolicyContext): Row | null {
  if (c.op.ext === "channels") return null;
  let ext = c.op.ext;
  let table = c.op.table;
  let row = c.after ?? c.before;
  for (let depth = 0; row && depth < 4; depth++) {
    if (typeof row.channel_id === "number") return c.rows("channels", "channels_channels", { id: row.channel_id })[0] ?? null;
    const parent = rowParents[`${ext}/${table}`];
    if (!parent || typeof row[parent.column] !== "number") return null;
    row = c.rows(parent.ext, parent.table, { id: row[parent.column] as number })[0];
    ext = parent.ext;
    table = parent.table;
  }
  return null;
}

// A channel's edit rule (p2p/visibility.ts) gives or takes "Edit content" and "Send messages" there.
function inChannel(c: PolicyContext, roles: RoleTables, me: Standing, channel: Row, user = c.author): Standing {
  const rules = c.rows("channels", "channels_visibility");
  const edit = canEditIn(rules, roles, c.owner, user, { channelId: channel.id, categoryId: channel.category_id as number });
  if (edit === undefined) return me;
  const permissions = new Set(me.permissions);
  for (const p of channelPermissions) {
    if (edit) permissions.add(p);
    else permissions.delete(p);
  }
  return { ...me, permissions };
}

// Adds a channel with its rows as their original authors wrote them, and profiles for authors who have none here.
// Only for those who may manage channels; it can't change anything that exists.
function channelImport(c: PolicyContext, me: Standing): string | null {
  if (!me.owner && !me.permissions.has("manage_channels")) return need(me, "manage_channels");
  if (c.op.kind !== "insert") return "An import only adds things.";
  if (c.op.ext === "members")
    return c.rows("members", "members_profiles", { user_id: c.after!.user_id as number }).length > 0 ? "That member already has a profile." : null;
  if (c.op.ext === "roles" || (c.op.ext === "channels" && c.op.table !== "channels_channels")) return "An import only adds a channel.";
  return null;
}

// The move's record names a real member to move to, never the owner; the owner may change the rest anyway.
function memberMove(c: PolicyContext): string | null {
  if (c.op.ext !== "members" || c.op.table !== "members_moves") return null;
  if (c.op.kind !== "insert") return "Moves can't be changed.";
  const { from_id: from, to_id: to } = c.after!;
  if (from === c.owner) return "The owner can't be moved.";
  if (from === to) return "That is the same member.";
  if (c.rows("members", "members_profiles", { user_id: to as number }).length === 0) return "The new account must join the workspace first.";
  if (c.rows("members", "members_moves", { from_id: from as number }).length > 0) return "That member was already moved.";
  return null;
}

// A kicked member (a kick row and no profile) may only add their own profile again, which is joining again.
function removed(c: PolicyContext): boolean {
  if (c.op.ext === "members" && c.op.table === "members_profiles" && c.op.kind === "insert") return false;
  return kickedBy((plugin, table, where) => c.rows(plugin, table, where), c.author) !== null;
}

// Changes to rows of a channel the author can't see are refused.
function hiddenChannel(c: PolicyContext, roles: RoleTables, channel: Row, user = c.author): string | null {
  const visibility = c.rows("channels", "channels_visibility");
  if (visibility.length === 0 && !hidesByDefault(roles)) return null;
  const target = { channelId: channel.id, categoryId: channel.category_id as number };
  return canSee(visibility, roles, c.owner, user, target) ? null : "You can't see that channel.";
}

function roleTables(c: PolicyContext): RoleTables {
  return roleTablesFrom((plugin, table) => c.rows(plugin, table));
}

const rowsOf = (c: PolicyContext) => (plugin: string, table: string, where?: Record<string, ApiValue>) => c.rows(plugin, table, where) as Row[];

// How far a row's own time may be from its commit's, where it matters (guests' joins, chat keys).
export const clockSlackMs = 10 * 60_000;

const need = (me: Standing, permission: Permission) =>
  me.permissions.has(permission) ? null : `You need the "${permissionInfo[permission].label}" permission.`;

// Columns that name who made a row: set to the author on insert, never changed after.
function authored(c: PolicyContext, column: string): string | null {
  if (c.op.kind === "insert" && c.after![column] !== c.author) return "You can only add things as yourself.";
  if (c.op.kind === "update" && c.after![column] !== c.before![column]) return `${column} can't be changed.`;
  return null;
}

// A node's invite page path, or none (rows from before it have none).
function validPage(page: unknown): boolean {
  return page == null || validPagePath(page);
}

function fixed(c: PolicyContext, ...columns: string[]): string | null {
  if (c.op.kind !== "update") return null;
  const changed = columns.find((column) => c.after![column] !== c.before![column]);
  return changed ? `${changed} can't be changed.` : null;
}

const first = (...checks: (() => string | null)[]) => {
  for (const check of checks) {
    const reason = check();
    if (reason) return reason;
  }
  return null;
};

// Kicking takes away a member's profile and roles. Banning does too, so "Ban members" may also remove the banned.
function kick(c: PolicyContext, me: Standing, roles: RoleTables, userId: unknown): string | null {
  const target = standing(roles, Number(userId), c.owner);
  return first(
    () => (target.banned && me.permissions.has("ban_members") ? null : need(me, "kick_members")),
    () => (target.owner ? "The owner can't be kicked." : null),
    () => (target.highest >= me.highest ? "You can only kick members below your highest role." : null),
  );
}

// Your own row, or anyone's with the permission.
function ownOr(c: PolicyContext, me: Standing, owner: unknown, permission: Permission): string | null {
  return owner === c.author ? null : need(me, permission);
}

function messageAuthor(c: PolicyContext, messageId: unknown): unknown {
  return c.rows("chat", "chat_messages", { id: messageId as number })[0]?.author_id ?? null;
}

const pluginId = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const contentRef = /^mwc:[0-9a-f]{64}$/;
const declaredName = /^[a-z_][a-z0-9_]{0,62}$/;

// Keep the workspace's plugin table declarations structurally safe for every member, including the owner. The
// table schema must not change in-place because signed table operations replay against the declaration.
function validatePluginRegistration(c: PolicyContext): string | null {
  const row = c.after ?? c.before!;
  if (c.op.kind === "insert") {
    if (!pluginId.test(String(row.plugin_id ?? ""))) return "plugin_id uses lowercase a-z, digits, '.' and '-'.";
    if (typeof row.version !== "string" || row.version.length === 0) return "The plugin needs a version.";
    if (!contentRef.test(String(row.package ?? ""))) return "The package must be a content reference (mwc:...).";
    let manifest: DeclaredManifest;
    try {
      manifest = parseDeclared(String(row.manifest ?? ""));
    } catch (e) {
      return (e as Error).message;
    }
    if (manifest.version !== row.version) return "The plugin version must match its declared manifest.";
    if (!declaredName.test(manifest.name)) return "The plugin needs a valid channel type name.";
    if (serverPlugins.some((p) => p.manifest.name === manifest.name))
      return `'${manifest.name}' is a built-in system plugin.`;
    const prefix = `${String(row.plugin_id).replace(/[.-]/g, "_")}_`;
    if (manifest.tables.some((t) => !t.name.startsWith(prefix)))
      return `Each table name must start with '${prefix}'.`;
    for (const existing of c.rows("channels", "channels_plugins")) {
      try {
        if (existing.plugin_id === row.plugin_id || parseDeclared(String(existing.manifest)).name === manifest.name)
          return "That plugin or channel type is already in this workspace.";
      } catch {
        if (existing.plugin_id === row.plugin_id) return "That plugin is already in this workspace.";
      }
    }
    return null;
  }
  if (c.op.kind === "update") {
    if (c.before!.plugin_id !== c.after!.plugin_id) return "plugin_id can't be changed.";
    if (typeof row.version !== "string" || !row.version) return "The plugin needs a version.";
    if (!contentRef.test(String(row.package ?? ""))) return "The package must be a content reference (mwc:...).";
    let previous: DeclaredManifest;
    let next: DeclaredManifest;
    try {
      previous = parseDeclared(String(c.before!.manifest ?? ""));
      next = parseDeclared(String(row.manifest ?? ""));
    } catch (e) {
      return (e as Error).message;
    }
    if (!sameDeclaredSchema(previous, next))
      return "Plugin updates must keep the workspace's declared data schema unchanged.";
    if (next.version !== row.version) return "The plugin version must match its declared manifest.";
    if (compareVersions(String(row.version), String(c.before!.version ?? "")) <= 0)
      return "A plugin update must use a newer version.";
    return null;
  }
  if (c.op.kind === "delete") return "Plugin registrations are part of the signed history and can't be removed.";
  return null;
}

function validatePluginState(c: PolicyContext): string | null {
  if (c.op.kind === "delete") return "Plugin state is retained in workspace history.";
  const row = c.after!;
  if (typeof row.plugin_id !== "string" || !pluginId.test(row.plugin_id))
    return "plugin_id uses lowercase a-z, digits, '.' and '-'.";
  if (!["enabled", "disabled", "removed"].includes(String(row.status)))
    return "Plugin status must be enabled, disabled or removed.";
  if (!c.rows("channels", "channels_plugins", { plugin_id: row.plugin_id }).length)
    return "That plugin is not registered in this workspace.";
  if (c.op.kind === "update" && c.before!.plugin_id !== row.plugin_id)
    return "plugin_id can't be changed.";
  return null;
}

// Custom emoji are validated for everyone, including the owner, so every member replays the same safe rows.
function validateEmoji(c: PolicyContext): string | null {
  if (c.op.kind === "insert") {
    const row = c.after!;
    if (row.author_id !== c.author) return "You can only add things as yourself.";
    const problem = emojiNameProblem(String(row.name ?? ""));
    if (problem) return problem;
    const bad = emojiRowProblem(row);
    if (bad) return bad;
    if (c.rows("emoji", "emoji_emojis", { name: row.name as string }).length > 0)
      return "An emoji with that name already exists, or its name is still reserved.";
    return null;
  }
  if (c.op.kind === "update") {
    const changed = Object.keys(c.after ?? c.before ?? {}).filter((column) => c.before?.[column] !== c.after?.[column]);
    return changed.length === 1 && changed[0] === "deleted" && typeof c.after!.deleted === "boolean"
      ? null
      : "Only whether an emoji is removed can change.";
  }
  return "Emoji rows stay in workspace history and can't be deleted.";
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return match && { parts: match[1].split(".").map(Number), prerelease: match[2]?.split(".") ?? null };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return left === right ? 0 : 1;
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const difference = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const av = a.prerelease[i];
    const bv = b.prerelease[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Math.sign(Number(av) - Number(bv));
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

// A declared table of an installed plugin: the workspace's channels_plugins row decides who may change it. Tables
// of a channel need "Edit content" there and must live in a channel of the plugin's type; rows with an authored
// column are added by their author; owned rows change only by their author or with "Manage messages". Channel-wide
// tables have no channel, so nothing but the owner can change them. Returns undefined when the table is not one of
// a plugin's (the fallback "owner only" message is used then).
function declared(c: PolicyContext, channel: Row | null, me: Standing): string | null | undefined {
  for (const row of c.rows("channels", "channels_plugins")) {
    let manifest: DeclaredManifest;
    try {
      manifest = parseDeclared(String(row.manifest ?? ""));
    } catch {
      continue;
    }
    const table = manifest.tables.find((t) => t.name === c.op.table);
    if (!table) continue;
    if (!table.channel) return "That table belongs to a plugin; only the owner can change it.";
    if (channel?.type !== manifest.name) return `That table belongs to a '${manifest.name}' channel.`;
    return first(
      () => need(me, "edit_content"),
      () => fixed(c, "channel_id"),
      () => (table.owned && c.op.kind !== "insert" ? ownOr(c, me, c.creator(c.op.ext, c.op.table, c.before!.id), "manage_messages") : null),
      () => (table.authored ? authored(c, table.authored) : null),
    );
  }
  return undefined;
}

const content: Rule = (_c, me) => need(me, "edit_content");
const authoredContent: Rule = (c, me) => first(() => need(me, "edit_content"), () => authored(c, "author_id"));
// Code run configurations and release build configurations also name who changed them last, which members see
// before running someone else's commands.
const runConfig: Rule = (c, me, roles) => first(() => authoredContent(c, me, roles), () => (c.after && c.after.updated_by !== c.author ? "You can only change things as yourself." : null));

// A user's own mark on something (reaction, vote): add and remove your own; remove others' with manage_messages.
const userMark: Rule = (c, me) => {
  const row = c.after ?? c.before!;
  if (c.op.kind === "delete") return ownOr(c, me, row.user_id, "manage_messages");
  return first(() => need(me, "send_messages"), () => authored(c, "user_id"));
};

// Parts of a chat message (attachments, polls, poll answers): its author's, or anyone's with manage_messages.
const messagePart: Rule = (c, me) => {
  const row = c.after ?? c.before!;
  const author = messageAuthor(c, row.message_id);
  if (c.op.kind === "insert") return first(() => need(me, "send_messages"), () => (author === c.author ? null : "Not your message."));
  return first(() => fixed(c, "message_id"), () => ownOr(c, me, author, "manage_messages"));
};

// A channel's slow mode: a member without Manage messages waits that many seconds between their messages. Notes the
// app posts for them (join, leave) are not limited.
function slowMode(c: PolicyContext, me: Standing, channel: Row | null): string | null {
  const seconds = Number(channel?.slow_mode ?? 0);
  if (!(seconds > 0) || c.after?.kind !== "message" || need(me, "manage_messages") === null) return null;
  const at = Date.parse(String(c.after.created_at));
  const last = c.rows("chat", "chat_messages", { channel_id: c.after.channel_id, author_id: c.after.author_id })
    .filter((m) => m.kind === "message" && m.id !== c.after!.id)
    .reduce((latest, m) => Math.max(latest, Date.parse(String(m.created_at)) || 0), 0);
  return at - last < seconds * 1000 ? `Slow mode: wait ${Math.ceil((seconds * 1000 - (at - last)) / 1000)} s before the next message.` : null;
}

// A leader bot passes a role it holds on to its own helpers (config `_parent`), so they can do what it can.
const givesToHelper = (c: PolicyContext, row: Row, roles: RoleTables): boolean => {
  const helper = c.rows("bots", "bots_bots", { user_id: row.user_id as number })[0];
  return botParent(helper) === c.author && roles.members.some((m) => m.user_id === c.author && m.role_id === row.role_id);
};

const rules: Record<string, Rule> = {
  "channels/channels_workspace": (_c, me) => need(me, "manage_workspace"),
  "channels/channels_categories": (_c, me) => need(me, "manage_channels"),
  "channels/channels_channels": (c, me) => first(
    () => need(me, "manage_channels"),
    () => {
      if (c.op.kind !== "insert") return null;
      for (const plugin of c.rows("channels", "channels_plugins")) {
        try {
          if (parseDeclared(String(plugin.manifest)).name !== c.after!.type) continue;
          const state = c.rows("channels", "channels_plugin_state", { plugin_id: plugin.plugin_id })[0];
          return state && state.status !== "enabled" ? "This plugin is disabled or removed in this workspace." : null;
        } catch {
          continue;
        }
      }
      return null;
    },
  ),
  "channels/channels_visibility": (_c, me) => need(me, "manage_channels"),
  "channels/channels_plugins": (_c, me) => need(me, "manage_plugins"),
  "channels/channels_plugin_state": (_c, me) => need(me, "manage_plugins"),
  "emoji/emoji_emojis": (_c, me) => need(me, "manage_emojis"),

  "members/members_kicks": (c, me, roles) => {
    if (c.op.kind !== "insert") return "Kicks can't be changed.";
    return first(() => authored(c, "kicked_by"), () => kick(c, me, roles, c.after!.user_id));
  },
  "members/members_profiles": (c, me, roles) => {
    if (c.after?.bot === true || c.before?.bot === true) return need(me, "manage_bots");
    if (c.op.kind === "delete" && c.before!.user_id !== c.author) return kick(c, me, roles, c.before!.user_id);
    if (c.before && c.before.user_id !== c.author) return "You can only change your own profile.";
    if (c.after && c.after.user_id !== c.author) return "You can only change your own profile.";
    if (c.after && (c.after.key_x != null || c.after.key_y != null) && (typeof c.after.key_x !== "string" || typeof c.after.key_y !== "string"
      || userNumberOf(accountIdOf({ x: c.after.key_x, y: c.after.key_y })) !== c.author)) return "A profile can only name its owner's key.";
    // A node a member with Manage nodes added (nodes_nodes) is part of the workspace without an invite.
    if (c.op.kind === "insert" && c.rows("members", "members_invites").length > 0
      && c.rows("members", "members_invite_uses", { user_id: c.author }).length === 0
      && !c.rows("nodes", "nodes_nodes", { user_id: c.author }).some((row) => row.status === "authorized"))
      return "Join with a valid workspace invite.";
    return null;
  },
  "members/members_invites": (c, me) => {
    if (c.op.kind === "insert") {
      const row = c.after!;
      if (!me.permissions.has("manage_invites")) return need(me, "manage_invites");
      if (row.created_by !== c.author) return "You can only create invites as yourself.";
      if (typeof row.token_key !== "string" || !validInviteTokenKey(row.token_key))
        return "That invite token is invalid.";
      if (typeof row.sealed_token !== "string" || row.sealed_token.length > 4096) return "The invite secret must be sealed.";
      try {
        const sealed: unknown = JSON.parse(row.sealed_token);
        if (!isSealed(sealed) || typeof sealed.from !== "string" || typeof sealed.to !== "string"
          || sealed.from !== sealed.to || userNumberOf(sealed.to) !== c.author)
          return "The invite secret must be sealed to its creator.";
      } catch {
        return "The invite secret must be sealed to its creator.";
      }
      if (typeof row.label !== "string" || row.label.length > 64 || row.uses !== 0 || row.revoked !== false)
        return "That invite is malformed.";
      // A public invite's token is readable (it is on the nodes' invite pages): it must be this invite's.
      if (row.public_token != null && row.public_token !== ""
        && (typeof row.public_token !== "string" || inviteTokenKey(row.public_token) !== row.token_key))
        return "That invite's public token doesn't match it.";
      return null;
    }
    if (c.op.kind === "delete") {
      const before = c.before!;
      // Judged at the commit's time, never the clock: every member replays this commit to the same verdict.
      const joins = c.rows("members", "members_invite_joins", { invite_id: before.id }).length;
      if (inviteOpen(before, joins, c.time))
        return "Only a closed invite (revoked, expired or used up) can be permanently deleted.";
      return need(me, "manage_invites");
    }
    const before = c.before!;
    const after = c.after!;
    const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
    if (changed.length === 1 && changed[0] === "revoked" && before.revoked === false && after.revoked === true)
      return need(me, "manage_invites");
    if (changed.length === 1 && changed[0] === "uses" && Number(after.uses) === Number(before.uses) + 1) {
      const use = c.rows("members", "members_invite_uses", {
        invite_id: before.id, user_id: c.author, token_key: before.token_key, uses: before.uses,
      })[0];
      return use ? null : "An invite can only be consumed while joining with it.";
    }
    return "Invite details can't be changed.";
  },
  "members/members_invite_uses": (c) => {
    if (c.op.kind === "insert") {
      const row = c.after!;
      const invite = c.rows("members", "members_invites", { id: row.invite_id as number })[0];
      if (row.user_id !== c.author) return "You can only use an invite to join as yourself.";
      if (!invite || invite.revoked === true || invite.token_key !== row.token_key) return "That invite is no longer valid.";
      if (c.rows("members", "members_profiles", { user_id: c.author }).length > 0) return "You are already a workspace member.";
      // One use at a time: it is removed once the profile is in, after which the member can't use an invite again.
      if (c.rows("members", "members_invite_uses", { invite_id: invite.id, user_id: c.author }).length > 0)
        return "That invite is already being used.";
      const joins = c.rows("members", "members_invite_joins", { invite_id: invite.id }).length;
      if (inviteUses(invite, joins) >= Number(invite.max_uses ?? Infinity)) return "That invite reached its use limit.";
      // v1 (before 2026-10-16): the proof names the use count, and the count goes up in the same commit.
      if (row.uses != null) {
        if (Number(row.uses) !== Number(invite.uses)
          || !verifyInviteProof(String(invite.token_key), inviteUseText(Number(invite.id), c.author, Number(row.uses)), String(row.proof)))
          return "That invite use isn't authorized.";
        return null;
      }
      if (!verifyInviteProof(String(invite.token_key), inviteUseTextV2(Number(invite.id), c.author), String(row.proof)))
        return "That invite use isn't authorized.";
      return null;
    }
    if (c.op.kind === "delete" && c.before!.user_id === c.author
      && c.rows("members", "members_profiles", { user_id: c.author }).length > 0) return null;
    return "Invite uses can't be changed.";
  },
  // A join counted against its invite's limit: one per signed use, by the joiner, kept for good.
  "members/members_invite_joins": (c) => {
    if (c.op.kind !== "insert") return "Invite joins can't be changed.";
    const row = c.after!;
    if (row.user_id !== c.author) return "You can only join as yourself.";
    const use = c.rows("members", "members_invite_uses", { id: row.use_id as number })[0];
    if (!use || use.user_id !== c.author || use.invite_id !== row.invite_id) return "A join needs a signed use of its invite.";
    if (c.rows("members", "members_invite_joins", { use_id: row.use_id as number }).length > 0) return "That use already counted.";
    // A guest can't read chat from before they joined, so their join time must be when it happened.
    const invite = c.rows("members", "members_invites", { id: row.invite_id as number })[0];
    if (invite?.guest === true && !(Math.abs(Date.parse(String(row.joined_at)) - c.time) <= clockSlackMs))
      return "A guest's join must carry the time it happened.";
    return null;
  },
  "members/members_promotions": (c, me, roles) => {
    if (c.op.kind !== "insert") return "Promotions can't be changed.";
    const row = c.after!;
    if (row.promoted_by !== c.author) return "You can only promote as yourself.";
    if (!(Math.abs(Date.parse(String(row.created_at)) - c.time) <= clockSlackMs)) return "A promotion must carry the time it happened.";
    if (!roles.guests?.has(Number(row.user_id))) return "Only guests can be made full members.";
    return need(me, "manage_roles");
  },
  "members/members_rotations": (c, me) => {
    if (c.op.kind !== "insert") return "Secret rotations can't be changed.";
    if (!me.owner && !me.permissions.has("manage_invites")
      && !me.permissions.has("kick_members") && !me.permissions.has("ban_members"))
      return need(me, "manage_invites");
    const previous = c.rows("members", "members_rotations").reduce((max, row) => Math.max(max, Number(row.generation)), 0);
    if (c.after!.created_by !== c.author || Number(c.after!.generation) !== previous + 1)
      return "A secret rotation must be the next generation and authored by you.";
    return null;
  },
  "members/members_secrets": (c) => {
    if (c.op.kind !== "insert") return "Encrypted workspace secrets can't be changed.";
    const row = c.after!;
    const rotation = c.rows("members", "members_rotations", { generation: row.generation, created_by: c.author })[0];
    if (!rotation || !Number.isSafeInteger(Number(row.user_id)) || typeof row.sealed !== "string" || row.sealed.length > 4096)
      return "That encrypted workspace secret is invalid.";
    const banned = c.rows("roles", "roles_bans", { user_id: row.user_id as number }).length > 0;
    const profile = c.rows("members", "members_profiles", { user_id: row.user_id as number }).length > 0;
    const node = c.rows("nodes", "nodes_nodes", { user_id: row.user_id as number }).some((item) => item.status === "authorized");
    if (banned || (!profile && !node && row.user_id !== c.owner)) return "Only current members can receive a workspace secret.";
    if (c.rows("members", "members_secrets", { user_id: row.user_id as number, generation: row.generation }).length > 0)
      return "A member already has a secret for this generation.";
    try {
      const sealed: unknown = JSON.parse(row.sealed);
      if (!isSealed(sealed) || typeof sealed.from !== "string" || typeof sealed.to !== "string"
        || userNumberOf(sealed.from) !== c.author || userNumberOf(sealed.to) !== Number(row.user_id))
        return "The workspace secret must be sealed to its recipient.";
    } catch {
      return "The workspace secret must be sealed to its recipient.";
    }
    return null;
  },
  // Secrets for bots. Each is sealed to one recipient (a member who may store credentials, or an authorized node), by
  // the member who writes the share, so the workspace log never holds one in the clear.
  "bots/bots_credentials": (c, me) => first(
    () => need(me, "store_credentials"),
    () => fixed(c, "created_by"),
    () => (c.op.kind === "insert" ? authored(c, "created_by") : null),
    () => (c.op.kind === "insert" && c.rows("bots", "bots_credentials", { name: c.after!.name as string }).length > 0 ? "A credential with that name exists." : null),
  ),
  "bots/bots_credential_shares": (c, me, roles) => {
    const denied = need(me, "store_credentials");
    if (denied) return denied;
    if (c.op.kind === "delete") return null;
    if (c.op.kind !== "insert") return "A credential share can't be changed; replace it.";
    const row = c.after!;
    if (c.rows("bots", "bots_credentials", { id: row.credential_id as number }).length === 0) return "That credential doesn't exist.";
    if (c.rows("bots", "bots_credential_shares", { credential_id: row.credential_id as number, user_id: row.user_id as number }).length > 0)
      return "That member already has this credential.";
    const user = Number(row.user_id);
    const node = c.rows("nodes", "nodes_nodes", { user_id: user }).some((item) => item.status === "authorized");
    if (!node && !standing(roles, user, c.owner).permissions.has("store_credentials")) return "Only members who store credentials, and nodes, can hold them.";
    if (typeof row.sealed !== "string" || row.sealed.length > 4096) return "The credential must be sealed to its holder.";
    try {
      const sealed: unknown = JSON.parse(row.sealed);
      if (!isSealed(sealed) || userNumberOf(sealed.from) !== c.author || userNumberOf(sealed.to) !== user)
        return "The credential must be sealed to its holder.";
    } catch {
      return "The credential must be sealed to its holder.";
    }
    return null;
  },
  "bots/bots_bots": (c, me) => {
    if (c.op.kind === "update" && c.before?.host === c.author) {
      const changed = Object.keys(c.after ?? {}).filter((key) => c.before?.[key] !== c.after?.[key]);
      if (changed.every((key) => key === "host" || key === "lease_until" || key === "log")) return null;
    }
    return need(me, "manage_bots");
  },

  // A bot's host and anyone managing bots may write its memory.
  "bots/bots_memory": (c, me) => {
    const row = c.after ?? c.before!;
    const bot = c.rows("bots", "bots_bots", { id: row.bot_id })[0];
    if (bot && bot.host === c.author) return null;
    return need(me, "manage_bots");
  },

  // Workspace-wide agent defaults.
  "bots/bots_defaults": (_c, me) => need(me, "manage_bots"),

  // The workspace index: written by the bot's host, cleaned up by anyone managing bots.
  "bots/bots_context": (c, me) => {
    const row = c.after ?? c.before!;
    const bot = c.rows("bots", "bots_bots", { id: row.bot_id })[0];
    if (bot && bot.host === c.author) return null;
    return need(me, "manage_bots");
  },

  "roles/roles_roles": (c, me) => {
    const before = c.before;
    const after = c.after;
    // The Guest role comes with the first guest invite: whoever may make invites adds it, with Send messages at most.
    if (c.op.kind === "insert" && after!.guest === true) {
      if (c.rows("roles", "roles_roles", { guest: true }).length > 0) return "There is already a Guest role.";
      if (!me.permissions.has("manage_roles") && !me.permissions.has("manage_invites")) return need(me, "manage_invites");
      if (after!.everyone === true || parsePermissions(after!.permissions).some((p) => p !== "send_messages"))
        return "A new Guest role may only have Send messages.";
      return Number(after!.position) < me.highest ? null : "You can only change roles below your highest role.";
    }
    return first(
      () => need(me, "manage_roles"),
      () => fixed(c, "everyone", "guest"),
      () => (c.op.kind === "delete" && before!.everyone ? "@everyone can't be deleted." : null),
      () => (c.op.kind === "insert" && after!.everyone && c.rows("roles", "roles_roles", { everyone: true }).length > 0
        ? "There is already an @everyone role." : null),
      () => [before, after].some((r) => r && !r.everyone && Number(r.position) >= me.highest)
        ? "You can only change roles below your highest role." : null,
      () => {
        const had = new Set(before ? parsePermissions(before.permissions) : []);
        const added = after ? parsePermissions(after.permissions).filter((p) => !had.has(p)) : [];
        const missing = added.find((p) => !me.permissions.has(p));
        return missing ? `You can't give the "${permissionInfo[missing].label}" permission; you don't have it.` : null;
      },
    );
  },

  "roles/roles_members": (c, me, roles) => {
    const row = c.after ?? c.before!;
    if (c.op.kind === "delete" && !me.permissions.has("manage_roles") && (me.permissions.has("kick_members") || me.permissions.has("ban_members")))
      return kick(c, me, roles, row.user_id);
    const role = c.rows("roles", "roles_roles", { id: row.role_id as number })[0];
    if (c.op.kind === "insert" && role && !role.everyone && givesToHelper(c, row, roles)) return fixed(c, "role_id", "user_id");
    return first(
      () => need(me, "manage_roles"),
      () => fixed(c, "role_id", "user_id"),
      () => (c.op.kind === "insert" && (!role || role.everyone) ? "No such role." : null),
      () => (role && Number(role.position) >= me.highest ? "You can only hand out roles below your highest role." : null),
    );
  },

  "roles/roles_bans": (c, me, roles) => {
    const row = c.after ?? c.before!;
    const target = standing(roles, Number(row.user_id), c.owner);
    return first(
      () => need(me, "ban_members"),
      () => fixed(c, "user_id"),
      () => (target.owner ? "The owner can't be banned." : null),
      () => (target.highest >= me.highest ? "You can only ban members below your highest role." : null),
      () => (c.op.kind === "insert" ? authored(c, "banned_by") : null),
    );
  },

  "roles/roles_mutes": (c, me, roles) => {
    const row = c.after ?? c.before!;
    const target = standing(roles, Number(row.user_id), c.owner);
    return first(
      () => need(me, "mute_members"),
      () => fixed(c, "user_id", "kind"),
      () => (isMuteKind(row.kind) ? null : "Mutes are for voice or chat."),
      () => (target.owner ? "The owner can't be muted." : null),
      () => (target.highest >= me.highest ? "You can only mute members below your highest role." : null),
      () => (c.op.kind === "insert" ? authored(c, "muted_by") : null),
    );
  },

  "chat/chat_messages": (c, me, roles) => {
    if (c.op.kind === "insert") {
      // A bot's host posts for it; the bot's own roles decide where it may write.
      const bot = c.after && c.rows("bots", "bots_bots", { user_id: c.after.author_id })[0];
      if (bot && bot.host === c.author && bot.enabled === true && bot.status === "enabled") {
        const user = Number(bot.user_id);
        const asBot = standing(roles, user, c.owner);
        if (asBot.banned) return "This bot is banned from this workspace.";
        const channel = channelOf(c);
        if (channel && hiddenChannel(c, roles, channel, user)) return "The bot can't see that channel.";
        return need(channel ? inChannel(c, roles, asBot, channel, user) : asBot, "send_messages");
      }
      return first(() => need(me, "send_messages"), () => authored(c, "author_id"), () => slowMode(c, me, channelOf(c)));
    }
    return first(
      () => fixed(c, "author_id", "channel_id", "thread_id", "kind", "created_at"),
      () => {
        if (c.before!.author_id === c.author) return null;
        const onlyDeleted = c.op.kind === "update" && Object.keys(c.op.values ?? {}).every((k) => k === "deleted");
        return onlyDeleted ? need(me, "manage_messages") : "You can only edit your own messages.";
      },
    );
  },
  // A channel's keys (ADR 0021): the next epoch, made by a member who can read the channel, at the commit's time.
  "chat/chat_keys": (c, _me, roles) => {
    if (c.op.kind !== "insert") return "Chat keys can't be changed.";
    const row = c.after!;
    const channelId = Number(row.channel_id);
    if (row.created_by !== c.author) return "You can only make a chat key as yourself.";
    if (!(Math.abs(Date.parse(String(row.created_at)) - c.time) <= clockSlackMs)) return "A chat key must carry the time it was made.";
    if (typeof row.check !== "string" || row.check.length > 64) return "That chat key is malformed.";
    const rows = rowsOf(c);
    if (!mayReadChannel(rows, roles, c.owner, c.author, channelId)) return "You can't read that channel.";
    if (Number(row.epoch) !== (epochsOf(rows, channelId).at(-1)?.epoch ?? 0) + 1) return "A chat key must be the channel's next epoch.";
    return null;
  },
  // A key sealed to one member who may read its epoch, once per member who gives it.
  "chat/chat_key_grants": (c, _me, roles) => {
    if (c.op.kind !== "insert") return "Chat key grants can't be changed.";
    const row = c.after!;
    const channelId = Number(row.channel_id);
    const rows = rowsOf(c);
    if (row.granted_by !== c.author || !mayReadChannel(rows, roles, c.owner, c.author, channelId)) return "You can't give that channel's keys.";
    const epoch = epochsOf(rows, channelId).find((e) => e.epoch === Number(row.epoch));
    if (!epoch) return "That chat key doesn't exist.";
    if (!mayRead(rows, roles, c.owner, Number(row.user_id), epoch)) return "That member may not read that chat key.";
    if (c.rows("chat", "chat_key_grants", { channel_id: channelId, epoch: epoch.epoch, user_id: row.user_id as number, granted_by: c.author }).length > 0)
      return "You already gave them that key.";
    try {
      const sealed: unknown = typeof row.sealed === "string" && row.sealed.length <= 4096 ? JSON.parse(row.sealed) : null;
      if (!isSealed(sealed) || userNumberOf(sealed.from) !== c.author || userNumberOf(sealed.to) !== Number(row.user_id))
        return "A chat key must be sealed to its member.";
    } catch {
      return "A chat key must be sealed to its member.";
    }
    return null;
  },
  "chat/chat_reactions": userMark,
  "chat/chat_poll_votes": userMark,
  "chat/chat_attachments": messagePart,
  "chat/chat_pins": (c, me) => first(
    () => need(me, "manage_messages"),
    () => fixed(c, "message_id", "channel_id"),
    () => (c.op.kind === "insert" ? authored(c, "pinned_by") : null),
  ),
  "chat/chat_polls": messagePart,
  "chat/chat_poll_options": messagePart,

  // Removing a row is deleting it for good (system/files.ts `purge`: the nodes and members' devices let its content
  // go, nothing restores it): your own uploads, anyone's with "Manage workspace". Hiding one (`deleted`) is an update.
  "files/files_entries": (c, me, roles) =>
    (c.op.kind === "delete" ? ownOr(c, me, c.before!.author_id, "manage_workspace") : authoredContent(c, me, roles)),
  "artboard/artboard_items": authoredContent,
  "browser/browser_pages": content,
  "browser/browser_bookmarks": authoredContent,
  "browser/browser_history": authoredContent,
  "browser/browser_extensions": (_c, me) => need(me, "manage_plugins"),
  "browser/browser_channel_extensions": (_c, me) => need(me, "manage_channels"),
  "design/design_nodes": authoredContent,
  "docs/docs_pages": authoredContent,
  "docs/docs_updates": authoredContent,
  "code/code_files": authoredContent,
  "code/code_updates": authoredContent,
  "code/code_runs": runConfig,
  "sheets/sheets_sheets": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "channel_id")),
  "sheets/sheets_cells": (c, me) => first(
    () => need(me, "edit_content"),
    () => fixed(c, "sheet_id"),
    () => authored(c, "author_id"),
  ),
  "sheets/sheets_rules": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "sheet_id")),
  "design/design_pages": content,
  "diagram/diagram_pages": content,
  "diagram/diagram_shapes": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "page_id")),
  "diagram/diagram_edges": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "page_id")),
  "diagram/diagram_rows": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "shape_id")),
  "design/design_colors": content,
  "design/design_palettes": content,
  "design/design_color_values": content,
  "tasks/tasks_tasks": authoredContent,
  "tasks/tasks_columns": content,
  "git/git_repos": content,
  "git/git_branches": content,
  "git/git_commits": content,
  "git/git_builds": runConfig,
  "tasks/tasks_tags": content,
  "tasks/tasks_task_tags": content,
  "tasks/tasks_assignees": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "task_id", "user_id")),
  "tasks/tasks_reactions": userMark,
  "tasks/tasks_dependencies": (c, me) => first(() => need(me, "edit_content"), () => fixed(c, "task_id", "depends_on_id")),
  // A history row is written as yourself and never changed.
  "tasks/tasks_history": (c, me) => first(
    () => need(me, "edit_content"),
    () => authored(c, "actor_id"),
    () => (c.op.kind === "insert" ? null : "History can't be changed."),
  ),
  // A member with "Manage nodes" adds a node (paired with it, p2p/pair.ts): its row, authorized, with the key its user
  // id comes from. Before 2026-10-16 a node added its own row, waiting, after joining with an invite; those rows
  // still replay. A node describes itself (address, place); only "Manage nodes" decides on it and sets its page.
  "nodes/nodes_nodes": (c, me) => {
    const row = c.after ?? c.before!;
    if (c.op.kind === "delete") return ownOr(c, me, row.user_id, "manage_nodes");
    if (c.op.kind === "insert") {
      if (row.user_id === c.author) return row.status !== "pending" ? "A new node waits for authorization." : null;
      return first(
        () => need(me, "manage_nodes"),
        () => (row.status === "authorized" && row.decided_by === c.author ? null : "A node you add is authorized by you."),
        () => (typeof row.key_x === "string" && typeof row.key_y === "string"
          && userNumberOf(accountIdOf({ x: row.key_x, y: row.key_y })) === row.user_id ? null : "That node's key doesn't match it."),
        () => (validPage(row.page) ? null : pagePathRule),
      );
    }
    if (c.before!.user_id === c.author) return fixed(c, "user_id", "name", "status", "decided_by", "key_x", "key_y");
    return first(
      () => need(me, "manage_nodes"),
      () => (Object.keys(c.op.values ?? {}).every((k) => k === "status" || k === "decided_by" || k === "page") ? null : "Only a node describes itself."),
      () => (["pending", "authorized", "ignored"].includes(String(c.after!.status)) ? null : "Unknown node status."),
      () => ((c.after!.status === c.before!.status && c.after!.decided_by === c.before!.decided_by) || c.after!.decided_by === c.author
        ? null : "You can only decide as yourself."),
      () => (validPage(c.after!.page) ? null : pagePathRule),
    );
  },
  // How many nodes keep each file: "Manage nodes".
  "nodes/nodes_settings": (_c, me) => need(me, "manage_nodes"),
  // A big file's piece list: added as yourself, one per file (the first stays, so a later one can't make nodes refuse
  // the right pieces), never changed; removed by its author or "Manage nodes".
  "nodes/nodes_pieces": (c, me) => {
    if (c.op.kind === "delete") return ownOr(c, me, c.before!.author_id, "manage_nodes");
    if (c.op.kind !== "insert") return "A piece list can't be changed.";
    return first(
      () => need(me, "send_messages"),
      () => authored(c, "author_id"),
      () => (c.rows("nodes", "nodes_pieces", { content: String(c.after!.content) }).length > 0 ? "That file already has a piece list." : null),
    );
  },
  // A watch party (system/watch.ts): planned as yourself in its voice channel. Anyone who may talk there plays,
  // pauses and seeks it, as themselves; only its host announces it, and its host or "Manage messages" starts it
  // early or ends it.
  "watch/watch_parties": (c, me) => {
    if (c.op.kind === "insert") return first(() => need(me, "send_messages"), () => authored(c, "host_id"), () => authored(c, "changed_by"));
    if (c.op.kind === "delete") return ownOr(c, me, c.before!.host_id, "manage_messages");
    const changed = (column: string) => c.after![column] !== c.before![column];
    return first(
      () => need(me, "send_messages"),
      () => fixed(c, "channel_id", "chat_channel_id", "host_id", "title", "created_at"),
      // Started early, never put off.
      () => (changed("starts_at")
        ? (Date.parse(String(c.after!.starts_at)) < Date.parse(String(c.before!.starts_at)) ? ownOr(c, me, c.before!.host_id, "manage_messages") : "A party can only start earlier.")
        : null),
      () => (changed("message_id") && c.before!.host_id !== c.author ? "Only the host announces the party." : null),
      () => (changed("ended") ? (c.after!.ended === true ? ownOr(c, me, c.before!.host_id, "manage_messages") : "An ended party stays ended.") : null),
      () => (c.before!.ended === true && !changed("ended") ? "That watch party has ended." : null),
      () => (c.after!.changed_by !== c.author && changed("changed_at") ? "You can only change things as yourself." : null),
    );
  },
  "watch/watch_items": (c) => {
    const partyId = (c.after ?? c.before)!.party_id as number;
    const host = c.rows("watch", "watch_parties", { id: partyId })[0]?.host_id;
    if (c.op.kind === "update") return "A playlist entry can't be changed.";
    return host === c.author ? null : "Only the host picks the videos.";
  },
  "watch/watch_guests": (c, me) => {
    const row = c.after ?? c.before!;
    if (c.op.kind === "delete") return ownOr(c, me, row.user_id, "manage_messages");
    if (c.op.kind === "update") return "Can't be changed.";
    return authored(c, "user_id");
  },
  "tasks/tasks_comments": (c, me) => {
    if (c.op.kind === "insert") return first(() => need(me, "send_messages"), () => authored(c, "author_id"));
    return first(() => fixed(c, "author_id", "task_id"), () => ownOr(c, me, c.before!.author_id, "manage_messages"));
  },
};
