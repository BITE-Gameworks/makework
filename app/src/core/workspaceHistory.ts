// A serverless workspace's history, read from its signed log: who changed what and when, as readable lines. Runs of
// the same change by the same person (a folder upload, a burst of messages) are grouped into one line.
import { openChatText } from "../p2p/chatKeyring";
import type { ApiValue } from "../api/types";
import { decodeEmoji } from "../markdown/emoji";
import type { Commit, Op } from "../p2p/log";
import { replayCommit, userNumberOf } from "../p2p/log";
import { member } from "./members";

export type HistoryKind = "workspace" | "channels" | "roles" | "members" | "messages" | "files" | "tasks" | "artboards" | "designs" | "docs" | "browser" | "other";

export const historyKinds: { id: HistoryKind; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "channels", label: "Channels" },
  { id: "roles", label: "Roles, bans and mutes" },
  { id: "members", label: "Members" },
  { id: "messages", label: "Messages" },
  { id: "files", label: "Files" },
  { id: "tasks", label: "Tasks" },
  { id: "artboards", label: "Artboards" },
  { id: "designs", label: "Designs" },
  { id: "docs", label: "Docs" },
  { id: "browser", label: "Browsers" },
  { id: "other", label: "Other" },
];

export interface HistoryLine {
  id: string;
  time: number;
  until: number;
  // Who made it: a bot when the commit was made for one; `host` is then the member whose device ran it.
  userId: number;
  host?: number;
  kind: HistoryKind;
  text: string;
  count: number;
  rejected: string | null;
}

type Values = Record<string, ApiValue>;

// What a commit did, in words. `many` words a group of the same change; `group` says which commits may join it.
interface Described {
  kind: HistoryKind;
  one: string;
  many?: (n: number) => string;
  group?: string;
}

const kindOf: Record<string, HistoryKind> = {
  channels: "channels", roles: "roles", members: "members", chat: "messages", files: "files",
  tasks: "tasks", artboard: "artboards", design: "designs", docs: "docs",
  browser: "browser",
};

// Every row's last known values, so a line can still name a channel or role that was deleted since.
class RowIndex {
  private readonly rows = new Map<string, Values>();

  get(ext: string, table: string, id: unknown): Values | undefined {
    return this.rows.get(`${ext}/${table}/${id}`);
  }

  // The newest move record whose new account is one of `ids`.
  moveTo(ids: Set<ApiValue>): Values | undefined {
    let found: Values | undefined;
    for (const [key, row] of this.rows) if (key.startsWith("members/members_moves/") && ids.has(row.to_id)) found = row;
    return found;
  }

  apply(ops: Op[]) {
    for (const op of ops) {
      const key = `${op.ext}/${op.table}/${op.id}`;
      if (op.kind === "insert") this.rows.set(key, op.values ?? {});
      else if (op.kind === "update") this.rows.set(key, { ...this.rows.get(key), ...op.values });
    }
  }
}

export function workspaceHistory(workspaceId: string, log: { commit: Commit; rejected: string | null }[]): HistoryLine[] {
  const index = new RowIndex();
  const lines: (HistoryLine & { group?: string; many?: (n: number) => string })[] = [];
  for (const { commit, rejected } of log) {
    const applied = replayCommit(commit);
    const described = describe(workspaceId, applied, index);
    if (!rejected) index.apply(applied.ops);
    const host = userNumberOf(commit.author);
    const userId = commit.as ?? host;
    const last = lines.at(-1);
    // Grouped while nothing else happened in between, within ten minutes of each other.
    if (last && described.group && last.group === described.group && last.userId === userId && !rejected && !last.rejected
      && commit.time - last.until < 10 * 60_000) {
      last.count++;
      last.until = commit.time;
      last.text = described.many!(last.count);
      continue;
    }
    lines.push({
      id: commit.hash, time: commit.time, until: commit.time, userId, ...(commit.as ? { host } : {}), kind: described.kind, text: described.one, count: 1,
      rejected, group: described.group, many: described.many,
    });
  }
  return lines.map(({ group: _, many: __, ...line }) => line).reverse();
}

const rowCount = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;
const areaNames: Record<string, string> = {
  channels: "channels", members: "members", roles: "roles", chat: "chat", files: "files", tasks: "tasks", sheets: "sheets", design: "design",
  diagram: "diagram", docs: "docs", code: "code", git: "version control", browser: "browser", bots: "bots", nodes: "nodes", emoji: "emoji", watch: "watch party",
};

function describe(workspaceId: string, commit: Commit, index: RowIndex): Described {
  const [ext, fn = ""] = commit.action.split(".");
  const ops = commit.ops;
  const op = (table: string, kind?: Op["kind"]) => ops.find((o) => o.table === table && (!kind || o.kind === kind));
  // The values a row has after this commit, or had before it (for deletes and partial updates).
  const row = (o: Op | undefined): Values => (o ? { ...index.get(o.ext, o.table, o.id), ...o.values } : {});
  const who = (userId: ApiValue) => member(workspaceId, Number(userId)).displayName;
  const channel = (id: ApiValue) => {
    const ch = index.get("channels", "channels_channels", id) ?? ops.find((o) => o.table === "channels_channels" && o.id === id)?.values;
    return ch ? `#${ch.name}` : "a deleted channel";
  };
  const role = (id: ApiValue) => {
    const r = index.get("roles", "roles_roles", id) ?? ops.find((o) => o.table === "roles_roles" && o.id === id)?.values;
    return r ? (r.everyone ? "@everyone" : String(r.name)) : "a deleted role";
  };
  // `m`: the message the text is from, whose channel key opens it (ADR 0021); sealed text without its key isn't quoted.
  const opened = (text: ApiValue, m?: Record<string, ApiValue>) =>
    (m ? openChatText(workspaceId, Number(m.channel_id), Number(m.author_id), String(text ?? "")) : String(text ?? "")) ?? "";
  const quote = (text: ApiValue, m?: Record<string, ApiValue>) => {
    const plain = decodeEmoji(opened(text, m)).replace(/<@(\d+)>/g, (_, id: string) => `@${who(Number(id))}`).replace(/\s+/g, " ").trim();
    return plain ? ` "${plain.length > 60 ? `${plain.slice(0, 60)}...` : plain}"` : "";
  };
  const kind = kindOf[ext] ?? "other";
  const same = (one: string, many: (n: number) => string, group = commit.action): Described => ({ kind, one, many, group });

  switch (commit.action) {
    case "git.set-branches": return same("updated the branches of a repository", (n) => `updated repository branches ${n} times`);
    case "git.import-commits": return same("imported commits from a repository", (n) => `imported commits ${n} times`);
    case "channels.update": return same("changed the workspace's settings", (n) => `changed the workspace's settings ${n} times`);
    case "workspace.create": return { kind: "workspace", one: "created the workspace" };
    case "workspace.import": return { kind: "workspace", one: `imported the workspace's data (${rowCount(ops.length)})`, many: () => "imported the workspace's data", group: "import" };
    case "workspace.snapshot": return { kind: "workspace", one: "made a signed history snapshot" };
    case "channels.import-channel": {
      const ch = op("channels_channels", "insert");
      return ch
        ? { kind: "channels", one: `imported #${ch.values?.name} from a .zip (${rowCount(ops.length - 1)})`, many: () => `imported #${ch.values?.name} from a .zip`, group: `import:${ch.id}` }
        : { kind: "channels", one: "imported a channel" };
    }
    case "channels.add-channel": {
      const ch = row(op("channels_channels"));
      const category = index.get("channels", "channels_categories", ch.category_id);
      return { kind, one: `added #${ch.name}${category ? ` to ${category.name}` : ""}` };
    }
    case "channels.set-visibility":
    case "channels.set-edit": {
      const rule = row(op("channels_visibility"));
      const what = rule.target === "channel" ? channel(rule.target_id ?? null)
        : index.get("channels", "channels_categories", rule.target_id)?.name ?? "a category";
      const text = commit.action === "channels.set-edit" ? `changed who may edit ${what}` : `changed who sees ${what}`;
      return same(text, () => text, `${commit.action}:${rule.target}:${rule.target_id}`);
    }
    case "channels.add-category": return { kind, one: `added the category ${row(op("channels_categories")).name}` };
    case "channels.rename-channel": {
      const o = op("channels_channels");
      const before = o ? index.get("channels", "channels_channels", o.id) : undefined;
      return { kind, one: `renamed #${before?.name ?? "?"} to #${o?.values?.name}` };
    }
    case "channels.rename-category": {
      const o = op("channels_categories");
      const before = o ? index.get("channels", "channels_categories", o.id) : undefined;
      return { kind, one: `renamed the category ${before?.name ?? "?"} to ${o?.values?.name}` };
    }
    case "channels.move-channel": {
      const moved = ops.find((o) => o.table === "channels_channels" && o.values && "category_id" in o.values);
      return same(`moved ${channel(moved?.id ?? null)}`, (n) => `moved channels ${n} times`);
    }
    case "channels.delete-channel": return { kind, one: `deleted ${channel(op("channels_channels")?.id ?? null)}` };
    case "channels.delete-category": {
      const category = row(op("channels_categories"));
      const channels = ops.filter((o) => o.table === "channels_channels").length;
      return { kind, one: `deleted the category ${category.name ?? "?"}${channels ? ` and ${channels === 1 ? "its channel" : `its ${channels} channels`}` : ""}` };
    }
    case "members.set-profile": {
      const p = op("members_profiles");
      if (p?.kind === "insert") return { kind: "members", one: "joined the workspace" };
      return same("updated their profile", () => "updated their profile");
    }
    case "members.kick": {
      const kicked = op("members_kicks")?.values?.user_id ?? row(op("members_profiles")).user_id;
      return { kind: "members", one: `kicked ${who(kicked ?? null)}` };
    }
    case "chat.post-leave": return { kind: "members", one: "left the workspace" };
    case "members.set-workspace-profile": {
      const values = op("members_profiles")?.values ?? {};
      if ("nickname" in values && !("bio" in values)) return { kind, one: values.nickname ? `changed their nickname to ${values.nickname}` : "removed their nickname" };
      return { kind, one: "updated their workspace profile" };
    }
    case "roles.ensure-everyone": return { kind, one: "set up the @everyone role" };
    case "roles.ensure-guest-role": return { kind, one: "set up the Guest role" };
    case "members.promote-guest": return { kind, one: `made ${who(row(op("members_promotions")).user_id)} a full member` };
    case "chat.add-chat-key": return same(`made a new chat key for ${channel(row(op("chat_keys")).channel_id)}`, (n) => `made ${n} new chat keys`);
    case "chat.grant-chat-keys": return same("gave chat keys to members", (n) => `gave chat keys to members ${n} times`);
    case "roles.create-role": return { kind, one: `created the role ${row(op("roles_roles")).name}` };
    case "roles.edit-role": {
      const o = op("roles_roles");
      const before = o ? index.get("roles", "roles_roles", o.id) ?? {} : {};
      const changes = Object.keys(o?.values ?? {});
      const permissions = changes.includes("permissions") ? permissionChange(before.permissions, o!.values!.permissions) : "";
      const name = role(o?.id ?? null);
      if (changes.includes("name") && before.name !== undefined && before.name !== o!.values!.name)
        return { kind, one: `renamed the role ${before.name} to ${o!.values!.name}` };
      return same(`edited the role ${name}${permissions}`, () => `edited the role ${name}`, `${commit.action}:${o?.id}`);
    }
    case "roles.move-role": return { kind, one: `moved the role ${role(op("roles_roles")?.id ?? null)}` };
    case "roles.delete-role": return { kind, one: `deleted the role ${role(op("roles_roles")?.id ?? null)}` };
    case "roles.assign-role": {
      const o = op("roles_members");
      const r = row(o);
      return o?.kind === "delete"
        ? { kind, one: `took ${role(r.role_id)} from ${who(r.user_id)}` }
        : { kind, one: `gave ${who(r.user_id)} the role ${role(r.role_id)}` };
    }
    case "roles.ban": {
      const r = row(op("roles_bans"));
      return { kind, one: `banned ${r.name || who(r.user_id)}${r.reason ? `: ${r.reason}` : ""}` };
    }
    case "roles.unban": {
      const r = row(op("roles_bans"));
      return { kind, one: `lifted the ban on ${r.name || who(r.user_id)}` };
    }
    case "members.move-member": {
      // A big move spans several commits; the later ones find the record the first one added.
      const record = op("members_moves")?.values
        ?? index.moveTo(new Set(ops.flatMap((o) => Object.values(o.values ?? {}))));
      const text = record ? `moved ${record.name || "a member"} to ${who(record.to_id)}'s account` : "moved a member to another account";
      return { kind: "members", one: text, many: () => text, group: `move:${record?.to_id ?? ""}` };
    }
    case "roles.mute": {
      const r = row(op("roles_mutes"));
      return { kind, one: `muted ${who(r.user_id)} in ${r.kind === "voice" ? "calls" : "chat"}` };
    }
    case "roles.unmute": {
      const r = row(op("roles_mutes"));
      return { kind, one: `unmuted ${who(r.user_id)} in ${r.kind === "voice" ? "calls" : "chat"}` };
    }
    case "chat.post-message": case "chat.post-poll": {
      const m = row(op("chat_messages"));
      const where = channel(m.channel_id);
      const poll = commit.action === "chat.post-poll";
      return same(`${poll ? "posted a poll" : "wrote"} in ${where}:${quote(m.body, m)}`, (n) => `wrote ${n} messages in ${where}`,
        `chat.post:${m.channel_id}`);
    }
    case "chat.edit-message": {
      const m = row(op("chat_messages"));
      return same(`edited a message in ${channel(m.channel_id)}`, (n) => `edited ${n} messages in ${channel(m.channel_id)}`, `${commit.action}:${m.channel_id}`);
    }
    case "chat.delete-message": {
      const m = row(op("chat_messages"));
      const theirs = m.author_id !== undefined && m.author_id !== (commit.as ?? userNumberOf(commit.author));
      return { kind, one: `deleted ${theirs ? `${who(m.author_id)}'s` : "a"} message in ${channel(m.channel_id)}${theirs ? quote(m.body, m) : ""}` };
    }
    case "chat.attach": {
      const a = row(op("chat_attachments"));
      const m = index.get("chat", "chat_messages", a.message_id) ?? {};
      return same(`attached ${opened(a.name, m) || "a file"} in ${channel(m.channel_id ?? null)}`, (n) => `attached ${n} files in ${channel(m.channel_id ?? null)}`, `${commit.action}:${m.channel_id}`);
    }
    case "chat.detach": {
      const a = row(op("chat_attachments"));
      return { kind, one: `removed the attachment ${opened(a.name, index.get("chat", "chat_messages", a.message_id) ?? {}) || "a file"}` };
    }
    case "chat.react": {
      const o = op("chat_reactions");
      const r = row(o);
      const m = index.get("chat", "chat_messages", r.message_id) ?? {};
      return same(`${o?.kind === "delete" ? "took back the reaction" : "reacted"} ${decodeEmoji(String(r.code ?? ""))} in ${channel(m.channel_id ?? null)}`,
        (n) => `reacted ${n} times in ${channel(m.channel_id ?? null)}`, `${commit.action}:${m.channel_id}`);
    }
    case "chat.pin-message": {
      const o = op("chat_pins");
      const pin = row(o);
      const m = index.get("chat", "chat_messages", pin.message_id) ?? {};
      return { kind, one: `${o?.kind === "delete" ? "unpinned" : "pinned"} a message in ${channel(pin.channel_id ?? m.channel_id ?? null)}${quote(m.body, m)}` };
    }
    case "chat.vote": return same("voted in a poll", (n) => `voted ${n} times in polls`);
    case "files.add-file": case "files.add-folder": {
      const f = row(op("files_entries"));
      const folder = commit.action === "files.add-folder";
      // Uploading a folder adds files and folders in turns; they make one group.
      return same(`added the ${folder ? "folder" : "file"} ${f.name} to ${channel(f.channel_id)}`,
        (n) => `added ${n} files and folders to ${channel(f.channel_id)}`, `files.add:${f.channel_id}`);
    }
    case "files.rename": {
      const o = op("files_entries");
      const before = o ? index.get("files", "files_entries", o.id) ?? {} : {};
      return { kind, one: `renamed ${before.name ?? "a file"} to ${o?.values?.name}` };
    }
    case "files.move": return same(`moved ${row(op("files_entries")).name}`, (n) => `moved ${n} files`);
    case "files.remove": return same(`deleted ${row(op("files_entries")).name}`, (n) => `deleted ${n} files and folders`);
    case "files.restore": return { kind, one: `restored ${row(op("files_entries")).name}` };
    case "tasks.add-task": {
      const t = row(op("tasks_tasks"));
      const what = t.kind === "issue" ? "issue" : "task";
      return same(`added the ${what} "${t.title}" in ${channel(t.channel_id)}`, (n) => `added ${n} ${what}s in ${channel(t.channel_id)}`, `${commit.action}:${t.channel_id}`);
    }
    case "tasks.edit-task": return same(`edited the task "${row(op("tasks_tasks")).title}"`, (n) => `edited ${n} tasks`);
    case "tasks.move-task": {
      const o = op("tasks_tasks");
      const t = row(o);
      const column = index.get("tasks", "tasks_columns", t.column_id);
      return same(`moved the task "${t.title}"${column ? ` to ${column.name}` : ""}`, (n) => `moved ${n} tasks`);
    }
    case "tasks.remove-task": return { kind, one: `deleted the task "${row(op("tasks_tasks")).title}"` };
    case "tasks.restore-task": return { kind, one: `restored the task "${row(op("tasks_tasks")).title}"` };
    case "tasks.archive-task": return { kind, one: `archived the task "${row(op("tasks_tasks")).title}"` };
    case "tasks.unarchive-task": return { kind, one: `brought back the archived task "${row(op("tasks_tasks")).title}"` };
    case "tasks.set-keep-done": {
      const c = row(op("tasks_columns"));
      return { kind, one: `set ${c.name ?? "a column"} to keep ${Number(c.keep_done) === 0 ? "all" : c.keep_done} done tasks` };
    }
    case "tasks.add-comment": {
      const c = row(op("tasks_comments"));
      const t = index.get("tasks", "tasks_tasks", c.task_id) ?? {};
      return same(`commented on "${t.title ?? "a task"}":${quote(c.body)}`, (n) => `commented ${n} times on "${t.title ?? "a task"}"`, `${commit.action}:${c.task_id}`);
    }
    case "tasks.edit-comment": {
      const c = row(op("tasks_comments"));
      const t = index.get("tasks", "tasks_tasks", c.task_id) ?? {};
      return same(`edited a comment on "${t.title ?? "a task"}"`, (n) => `edited ${n} comments on "${t.title ?? "a task"}"`, `${commit.action}:${c.task_id}`);
    }
    case "tasks.remove-comment": {
      const c = row(op("tasks_comments"));
      const t = index.get("tasks", "tasks_tasks", c.task_id) ?? {};
      const theirs = c.author_id !== undefined && c.author_id !== (commit.as ?? userNumberOf(commit.author));
      return { kind, one: `deleted ${theirs ? `${who(c.author_id)}'s` : "a"} comment on "${t.title ?? "a task"}"${theirs ? quote(c.body) : ""}` };
    }
    case "tasks.add-column": return { kind, one: `added the column ${row(op("tasks_columns")).name}` };
    case "tasks.edit-column": return { kind, one: `edited the column ${row(op("tasks_columns")).name}` };
    case "tasks.move-column": return { kind, one: `moved the column ${row(op("tasks_columns")).name}` };
    case "tasks.remove-column": return { kind, one: `deleted the column ${row(op("tasks_columns")).name}` };
    case "tasks.add-tag": return { kind, one: `added the tag ${row(op("tasks_tags")).name}` };
    case "tasks.tag-task": return same("tagged a task", (n) => `changed tags ${n} times`);
    case "tasks.assign-task": {
      // The last row op is the change asked for; an earlier insert only moves an old single assignee into a row.
      const o = ops.findLast((x) => x.table === "tasks_assignees");
      const a = row(o);
      const t = index.get("tasks", "tasks_tasks", a.task_id) ?? {};
      return same(o?.kind === "delete" ? `unassigned ${who(a.user_id)} from "${t.title ?? "a task"}"` : `assigned ${who(a.user_id)} to "${t.title ?? "a task"}"`,
        (n) => `changed assignees ${n} times`);
    }
    case "tasks.set-status": {
      const t = row(op("tasks_tasks"));
      return { kind, one: `set the issue "${t.title}" to ${String(t.status).replace("_", " ")}` };
    }
    case "tasks.convert-task": {
      const t = row(op("tasks_tasks"));
      return { kind, one: `turned "${t.title}" into ${t.kind === "issue" ? "an issue" : "a task"}` };
    }
    case "tasks.set-severity": {
      const t = row(op("tasks_tasks"));
      return { kind, one: `set the severity of the issue "${t.title}" to ${t.severity}` };
    }
    case "tasks.set-dependency": {
      const o = ops.findLast((x) => x.table === "tasks_dependencies");
      const d = row(o);
      const title = (id: unknown) => String(index.get("tasks", "tasks_tasks", id)?.title ?? "a task");
      return { kind, one: `${o?.kind === "delete" ? "removed" : "added"} the dependency of "${title(d.task_id)}" on "${title(d.depends_on_id)}"` };
    }
    case "tasks.react": return same("reacted to a task", (n) => `reacted to tasks ${n} times`);
    case "artboard.add-item": {
      const item = row(op("artboard_items"));
      return same(`added ${item.name || "an image"} to ${channel(item.channel_id)}`, (n) => `added ${n} images to ${channel(item.channel_id)}`, `${commit.action}:${item.channel_id}`);
    }
    case "artboard.place-item": case "artboard.raise-item": {
      const item = row(op("artboard_items"));
      return same(`arranged ${item.name || "an image"} in ${channel(item.channel_id)}`, (n) => `arranged images ${n} times in ${channel(item.channel_id)}`,
        `artboard.arrange:${item.channel_id}`);
    }
    case "browser.set-page": {
      const page = row(op("browser_pages"));
      return same(`opened ${page.title || page.url} in ${channel(page.channel_id)}`, (n) => `opened ${n} pages in ${channel(page.channel_id)}`,
        `${commit.action}:${page.channel_id}`);
    }
    case "browser.add-bookmark": return { kind, one: `bookmarked ${row(op("browser_bookmarks")).title || row(op("browser_bookmarks")).url}` };
    case "browser.remove-bookmark": return { kind, one: `removed the bookmark ${row(op("browser_bookmarks")).title || row(op("browser_bookmarks")).url}` };
    case "artboard.remove-item": return same(`removed ${row(op("artboard_items")).name || "an image"} from an artboard`, (n) => `removed ${n} images from artboards`);
    case "docs.add-page": return { kind, one: `added the page ${row(op("docs_pages")).title} to ${channel(row(op("docs_pages")).channel_id)}` };
    case "docs.update-page": case "docs.add-update": {
      const o = op("docs_pages", "update");
      const p = row(o);
      return same(`edited page "${p.title ?? "a page"}" of docs in ${channel(p.channel_id)}`,
        (n) => `edited page "${p.title ?? "a page"}" of docs in ${channel(p.channel_id)} (${n} saves)`, `docs.edit:${o?.id}`);
    }
    case "docs.move-page": return same(`moved the page ${row(op("docs_pages")).title}`, (n) => `moved pages ${n} times`);
    case "docs.remove-pages": return same(`deleted the page ${row(op("docs_pages")).title}`, (n) => `deleted pages ${n} times`);
    case "docs.restore-pages": return same(`restored the page ${row(op("docs_pages")).title}`, (n) => `restored pages ${n} times`);
    case "design.add-nodes": {
      const added = ops.filter((o) => o.table === "design_nodes" && o.kind === "insert");
      const first = row(added[0]);
      const what = added.length === 1 ? `the layer ${first.name}` : `${added.length} layers`;
      return same(`added ${what} to ${channel(first.channel_id)}`, (n) => `added layers ${n} times to ${channel(first.channel_id)}`, `${commit.action}:${first.channel_id}`);
    }
    case "design.update-nodes": {
      const changed = row(op("design_nodes"));
      return same(`edited ${channel(changed.channel_id)}`, (n) => `edited ${channel(changed.channel_id)} ${n} times`, `${commit.action}:${changed.channel_id}`);
    }
    case "design.remove-nodes": return same(`deleted layers from ${channel(row(op("design_nodes")).channel_id)}`, (n) => `deleted layers ${n} times`);
    case "design.set-page": case "design.add-color": case "design.rename-color": case "design.remove-color": case "design.restore-color":
    case "design.add-palette": case "design.rename-palette": case "design.remove-palette": case "design.restore-palette":
    case "design.set-color": {
      const changed = ops.find((o) => o.table.startsWith("design_"));
      const ch = changed ? row(changed).channel_id : undefined;
      return same(`changed the palettes of ${channel(ch ?? null)}`, (n) => `changed palettes ${n} times`, `design.palettes:${ch}`);
    }
    case "design.restore-nodes": return same(`restored layers in ${channel(row(op("design_nodes")).channel_id)}`, (n) => `restored layers ${n} times`);
    case "artboard.restore-item": return { kind, one: `restored ${row(op("artboard_items")).name || "an image"} on an artboard` };
  }
  // Anything else: the function name in words, e.g. "files: restore".
  const words = fn.replaceAll("-", " ") || "changed something";
  const area = areaNames[ext] ?? ext;
  return same(`${words} (${area})`, (n) => `${words} (${area}, ${n} times)`);
}

function permissionChange(before: ApiValue | undefined, after: ApiValue): string {
  const had = new Set(String(before ?? "").split(",").filter(Boolean));
  const has = new Set(String(after ?? "").split(",").filter(Boolean));
  const added = [...has].filter((p) => !had.has(p)).map((p) => p.replaceAll("_", " "));
  const removed = [...had].filter((p) => !has.has(p)).map((p) => p.replaceAll("_", " "));
  const parts = [added.length ? `+${added.join(", +")}` : "", removed.length ? `-${removed.join(", -")}` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}
