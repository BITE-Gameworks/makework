// The owner moves a member who lost their account to their new one (which joined the workspace first): everything
// that names the old account now names the new one (roles, authorship, assignees, reactions, votes, mutes,
// visibility rules), the new profile gets the old nickname and about text if it has none, and the old account is
// banned. Past commits stay signed by the old account; `members_moves` makes the app show the new person for it
// there, in mentions and in rows the old account wrote somewhere else meanwhile (core/members.ts `member`).
import type { ApiValue } from "../api/types";
import { newRowId, type Ledger } from "../p2p/ledger";
import type { Op } from "../p2p/log";
import { personColumns, subjectColumns } from "../p2p/people";
import { memberMoveAction } from "../p2p/policy";
import { welcomeChannel } from "../p2p/workspaces";
import { workspaceLedger } from "./serverless";

const opsPerCommit = 400;
// Local tables, not part of the workspace's data.
const localPlugins = new Set(["voice"]);

export async function moveMember(workspaceId: string, fromId: number, toId: number, oldName: string): Promise<number> {
  const ledger = workspaceLedger(workspaceId);
  if (!ledger) throw new Error("Only serverless workspaces can move members.");
  return moveMemberIn(ledger, fromId, toId, oldName);
}

// Returns how many changes it made.
export async function moveMemberIn(ledger: Ledger, fromId: number, toId: number, oldName: string): Promise<number> {
  if (ledger.me !== ledger.owner) throw new Error("Only the owner can move a member to another account.");
  const now = new Date().toISOString();
  const ops: Op[] = [{
    ext: "members", table: "members_moves", kind: "insert", id: newRowId(),
    values: { from_id: fromId, to_id: toId, name: oldName.slice(0, 64), moved_by: ledger.me, created_at: now },
  }];
  ops.push(...handOver(ledger, fromId, toId));

  const [oldProfile] = ledger.select("members", "members_profiles", { user_id: fromId });
  const [newProfile] = ledger.select("members", "members_profiles", { user_id: toId });
  if (oldProfile) {
    const keep: Record<string, ApiValue> = {};
    if (!newProfile?.nickname && oldProfile.nickname) keep.nickname = oldProfile.nickname;
    if (!newProfile?.bio && oldProfile.bio) keep.bio = oldProfile.bio;
    if (newProfile && Object.keys(keep).length) ops.push({ ext: "members", table: "members_profiles", kind: "update", id: newProfile.id, values: keep });
    ops.push({ ext: "members", table: "members_profiles", kind: "delete", id: oldProfile.id });
  }
  if (ledger.select("roles", "roles_bans", { user_id: fromId }).length === 0) ops.push({
    ext: "roles", table: "roles_bans", kind: "insert", id: newRowId(),
    values: { user_id: fromId, name: oldName.slice(0, 64), reason: "Moved to another account", banned_by: ledger.me, created_at: now },
  });
  const welcome = welcomeChannel(ledger);
  if (welcome !== null) ops.push({
    ext: "chat", table: "chat_messages", kind: "insert", id: newRowId(),
    values: {
      channel_id: welcome, author_id: ledger.me, thread_id: null, kind: "move",
      body: JSON.stringify({ from_id: fromId, to_id: toId, name: oldName.slice(0, 64) }), created_at: now,
      edited_at: null, deleted: false,
    },
  });

  for (let i = 0; i < ops.length; i += opsPerCommit)
    ledger.transact(memberMoveAction, () => ops.slice(i, i + opsPerCommit).forEach((op) => ledger.write(op)));
  await ledger.flush();
  return ops.length;
}

// Every row naming the old account, changed to the new one; a row that would then equal one the new account
// already has (the same role, reaction or vote) is deleted instead.
function handOver(ledger: Ledger, fromId: number, toId: number): Op[] {
  const ops: Op[] = [];
  for (const manifest of ledger.allManifests()) {
    if (localPlugins.has(manifest.name)) continue;
    for (const table of manifest.tables) {
      const key = `${manifest.name}/${table.name}`;
      if (key === "members/members_profiles" || key === "members/members_moves") continue;
      const kept = subjectColumns[key] ?? [];
      const columns = Object.keys(table.columns).filter((c) => personColumns.has(c) && !kept.includes(c));
      const memberRules = key === "channels/channels_visibility";
      if (columns.length === 0 && !memberRules) continue;
      const rows = ledger.select(manifest.name, table.name, {});
      const shape = (row: Record<string, ApiValue>) => JSON.stringify(Object.keys(table.columns).map((c) => row[c] ?? null));
      const existing = new Set(rows.map(shape));
      for (const row of rows) {
        const values: Record<string, ApiValue> = {};
        for (const column of columns) if (row[column] === fromId) values[column] = toId;
        if (memberRules && row.subject === "member" && row.subject_id === fromId) values.subject_id = toId;
        if (Object.keys(values).length === 0) continue;
        const after = shape({ ...row, ...values });
        if (existing.has(after)) ops.push({ ext: manifest.name, table: table.name, kind: "delete", id: row.id });
        else {
          existing.add(after);
          ops.push({ ext: manifest.name, table: table.name, kind: "update", id: row.id, values });
        }
      }
    }
  }
  return ops;
}
