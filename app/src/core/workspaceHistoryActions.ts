import type { ApiValue } from "../api/types";
import { retainContent } from "./content";
import { member } from "./members";
import { userNumberOf, replayCommit, type Commit, type Op } from "../p2p/log";
import type { Ledger, StoredCheckpoint } from "../p2p/ledger";
import { rowParents } from "../p2p/policy";

type RowState = { values: Record<string, ApiValue>; creator: number };
type RowKey = `${string}/${string}/${number}`;

export interface UndoPlan {
  commit: Commit;
  latestHash: string;
  operations: Op[];
  conflicts: string[];
}

export interface RevertPlan {
  latestHash: string;
  channelId: number | null;
  operations: Op[];
  contentHashes: Set<string>;
}

function rows(state: StoredCheckpoint): Map<RowKey, RowState> {
  const result = new Map<RowKey, RowState>();
  for (const [table, entries] of state.tables) {
    for (const [id, row] of entries) result.set(`${table}/${id}` as RowKey, row);
  }
  return result;
}

function keyOf(ext: string, table: string, id: number): RowKey {
  return `${ext}/${table}/${id}`;
}

function fieldsBetween(before: RowState | undefined, after: RowState | undefined): string[] {
  if (!before) return after ? Object.keys(after.values) : ["row"];
  if (!after) return Object.keys(before.values);
  return [...new Set([...Object.keys(before.values), ...Object.keys(after.values)])]
    .filter((field) => before.values[field] !== after.values[field]);
}

export async function planWorkspaceUndo(ledger: Ledger, hash: string): Promise<UndoPlan> {
  await ledger.flush();
  const log = ledger.log();
  const index = log.findIndex(({ commit }) => commit.hash === hash);
  if (index <= 0) throw new Error("That history entry can't be undone.");
  const { commit, rejected } = log[index];
  if (rejected) throw new Error("A refused change didn't change the workspace.");
  if (commit.action === "workspace.snapshot") throw new Error("History snapshots can't be undone.");
  const [beforeState, afterState, currentState] = await Promise.all([
    ledger.stateAt(index), ledger.stateAt(index + 1), ledger.snapshotState(),
  ]);
  const before = rows(beforeState);
  const after = rows(afterState);
  const current = rows(currentState);
  const changed = new Map<RowKey, string[]>();
  for (const op of replayCommit(commit).ops) {
    const key = keyOf(op.ext, op.table, op.id);
    const fields = fieldsBetween(before.get(key), after.get(key));
    if (fields.length) changed.set(key, [...new Set([...(changed.get(key) ?? []), ...fields])]);
  }

  const conflicts = new Map<string, Set<string>>();
  const later = log.slice(index + 1).filter((entry) => !entry.rejected);
  for (const [key, fields] of changed) {
    const [ext, table, idText] = key.split("/");
    const id = Number(idText);
    for (const entry of later) {
      for (const op of replayCommit(entry.commit).ops) {
        if (keyOf(op.ext, op.table, op.id) !== key) continue;
        const overlap = op.kind === "update" && fields[0] !== "row"
          ? (Object.keys(op.values ?? {}).filter((field) => fields.includes(field)))
          : fields;
        if (!overlap.length) continue;
        const who = member(ledger.workspaceId, userNumberOf(entry.commit.author)).displayName;
        const label = `${who}: ${overlap.join(", ")}`;
        const messages = conflicts.get(`${ext}/${table}/${id}`) ?? conflicts.set(`${ext}/${table}/${id}`, new Set()).get(`${ext}/${table}/${id}`)!;
        messages.add(label);
      }
    }
  }

  const operations: Op[] = [];
  for (const [key, fields] of changed) {
    const [ext, table, idText] = key.split("/");
    const id = Number(idText);
    const oldRow = before.get(key);
    const newRow = after.get(key);
    const now = current.get(key);
    if (!oldRow && newRow) {
      if (now) operations.push({ ext, table, kind: "delete", id });
    } else if (oldRow && !newRow) {
      if (!now) operations.push({ ext, table, kind: "insert", id, values: oldRow.values });
      else {
        const values = Object.fromEntries(Object.keys(oldRow.values)
          .filter((field) => oldRow.values[field] !== now.values[field])
          .map((field) => [field, oldRow.values[field]]));
        if (Object.keys(values).length) operations.push({ ext, table, kind: "update", id, values });
      }
    } else if (oldRow && newRow) {
      if (!now) operations.push({ ext, table, kind: "insert", id, values: oldRow.values });
      else {
        const values = Object.fromEntries(fields.filter((field) => field !== "row")
          .filter((field) => oldRow.values[field] !== now.values[field])
          .map((field) => [field, oldRow.values[field]]));
        if (Object.keys(values).length) operations.push({ ext, table, kind: "update", id, values });
      }
    }
  }

  const latestHash = log.at(-1)?.commit.hash;
  if (!latestHash) throw new Error("Workspace history isn't ready.");
  return {
    commit, latestHash, operations,
    conflicts: [...conflicts].map(([row, changes]) => `${row}: ${[...changes].join("; ")}`),
  };
}

export async function applyWorkspaceUndo(ledger: Ledger, plan: UndoPlan, overwrite: boolean): Promise<void> {
  if (!overwrite && plan.conflicts.length)
    throw new Error("Later changes overlap this history entry.");
  await ledger.flush();
  if (ledger.log().at(-1)?.commit.hash !== plan.latestHash)
    throw new Error("The workspace changed while undo was being reviewed. Review the undo again.");
  if (plan.operations.length === 0) throw new Error("There is nothing left to undo.");
  ledger.transact("history.undo", () => {
    for (const operation of plan.operations) ledger.write(operation);
  });
  await ledger.flush();
}

export async function applyWorkspaceCommitAgain(ledger: Ledger, hash: string): Promise<void> {
  await ledger.flush();
  const entry = ledger.log().find(({ commit }) => commit.hash === hash);
  if (!entry?.rejected || entry.commit.author !== ledger.author)
    throw new Error("That change isn't one of your refused history entries.");
  if (entry.commit.action === "workspace.snapshot") throw new Error("A history snapshot can't be applied again.");
  const operations = replayCommit(entry.commit).ops;
  if (!operations.length) throw new Error("This history entry has no changes to apply.");
  ledger.transact("history.apply-again", () => {
    for (const operation of operations) ledger.write(operation);
  });
  await ledger.flush();
}

function rowAtChannel(rows: Map<RowKey, RowState>, key: RowKey, id: number, channelId: number): boolean {
  const [ext, table] = key.split("/");
  if (ext === "channels" && table === "channels_channels") return id === channelId;
  let row = rows.get(key);
  for (let depth = 0; row && depth < 8; depth++) {
    if (typeof row.values.channel_id === "number") return row.values.channel_id === channelId;
    if (ext === "channels" && table === "channels_visibility"
      && row.values.target === "channel" && row.values.target_id === channelId) return true;
    const parent = rowParents[`${ext}/${table}`];
    if (!parent || typeof row.values[parent.column] !== "number") return false;
    const parentId = row.values[parent.column] as number;
    if (parent.ext === "channels" && parent.table === "channels_channels") return parentId === channelId;
    row = rows.get(keyOf(parent.ext, parent.table, parentId));
  }
  return false;
}

function depthOf(ext: string, table: string): number {
  let depth = 0;
  let key = `${ext}/${table}`;
  while (rowParents[key] && depth < 8) {
    const parent = rowParents[key];
    key = `${parent.ext}/${parent.table}`;
    depth++;
  }
  return depth;
}

export async function planWorkspaceRevert(ledger: Ledger, index: number, channelId: number | null = null): Promise<RevertPlan> {
  const log = ledger.log();
  if (!Number.isSafeInteger(index) || index < 0 || index >= log.length)
    throw new RangeError("History position is outside the workspace log.");
  if (log[index].rejected) throw new Error("A refused change didn't change the workspace.");
  const [targetState, currentState] = await Promise.all([ledger.stateAt(index + 1), ledger.snapshotState()]);
  const target = rows(targetState);
  const current = rows(currentState);
  const keys = new Set([...target.keys(), ...current.keys()]);
  const deletes: { op: Op; depth: number }[] = [];
  const updates: { op: Op; depth: number }[] = [];
  const inserts: { op: Op; depth: number }[] = [];
  const contentHashes = new Set<string>();
  for (const key of keys) {
    if (key.startsWith("members/members_snapshots/")) continue;
    const [ext, table, idText] = key.split("/");
    const id = Number(idText);
    const oldRow = current.get(key);
    const targetRow = target.get(key);
    if (channelId !== null && !rowAtChannel(target, key, id, channelId)
      && !rowAtChannel(current, key, id, channelId)) continue;
    const depth = depthOf(ext, table);
    if (targetRow) for (const value of Object.values(targetRow.values))
      if (typeof value === "string" && value.startsWith("mwc:")) contentHashes.add(value.slice(4));
    if (!oldRow && targetRow) inserts.push({ op: { ext, table, kind: "insert", id, values: targetRow.values }, depth });
    else if (oldRow && !targetRow) deletes.push({ op: { ext, table, kind: "delete", id }, depth });
    else if (oldRow && targetRow) {
      const values = Object.fromEntries([...new Set([...Object.keys(oldRow.values), ...Object.keys(targetRow.values)])]
        .filter((field) => oldRow.values[field] !== targetRow.values[field])
        .map((field) => [field, targetRow.values[field]]));
      if (Object.keys(values).length) updates.push({ op: { ext, table, kind: "update", id, values }, depth });
    }
  }
  deletes.sort((a, b) => b.depth - a.depth);
  updates.sort((a, b) => a.depth - b.depth);
  inserts.sort((a, b) => a.depth - b.depth);
  const latestHash = log.at(-1)?.commit.hash;
  if (!latestHash) throw new Error("Workspace history isn't ready.");
  return { latestHash, channelId, operations: [...deletes, ...updates, ...inserts].map(({ op }) => op), contentHashes };
}

export async function applyWorkspaceRevert(ledger: Ledger, plan: RevertPlan): Promise<void> {
  if (plan.channelId === null && ledger.me !== ledger.owner)
    throw new Error("Only the workspace owner can revert the whole workspace.");
  await ledger.flush();
  if (ledger.log().at(-1)?.commit.hash !== plan.latestHash)
    throw new Error("The workspace changed while the revert was being reviewed. Review it again.");
  if (!plan.operations.length) throw new Error("This history entry already matches the current data.");
  const releaseContent = retainContent(ledger.workspaceId, plan.contentHashes);
  let completed = 0;
  let latestHash = plan.latestHash;
  try {
    for (let offset = 0; offset < plan.operations.length; offset += 100) {
      if (ledger.log().at(-1)?.commit.hash !== latestHash)
        throw new Error("New changes arrived while reverting.");
      const batch = plan.operations.slice(offset, offset + 100);
      ledger.transact("history.revert", () => {
        for (const operation of batch) ledger.write(operation);
      });
      await ledger.flush();
      completed += batch.length;
      latestHash = ledger.log().at(-1)?.commit.hash ?? latestHash;
    }
  } catch (error) {
    throw new Error(`Revert stopped after ${completed} of ${plan.operations.length} changes: ${(error as Error).message}`, { cause: error });
  } finally {
    releaseContent();
  }
}
