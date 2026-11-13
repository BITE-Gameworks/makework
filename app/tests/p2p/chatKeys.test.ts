import { describe, expect, it } from "vitest";
import type { ApiValue } from "../../src/api/types";
import { epochOf, keyCheck, newChannelKey, openText, sealText } from "../../src/p2p/chatCrypto";
import { keyPlan, mayRead, type Epoch } from "../../src/p2p/chatKeys";
import { guestsFrom, roleTablesFrom, standing, type Row } from "../../src/p2p/permissions";

// Rows of a few plugin tables, read like a ledger's select.
function world(tables: Record<string, Record<string, ApiValue>[]>) {
  return (plugin: string, table: string, where: Record<string, ApiValue> = {}) =>
    (tables[`${plugin}/${table}`] ?? []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)) as Row[];
}

const owner = 1;
const joined = Date.parse("2026-10-28T10:00:00Z");
const base = () => ({
  "channels/channels_channels": [{ id: 50, category_id: null }],
  "members/members_profiles": [{ id: 1, user_id: 1 }, { id: 2, user_id: 2 }, { id: 3, user_id: 3 }],
  "members/members_invites": [{ id: 7, guest: true }, { id: 8 }],
  "members/members_invite_joins": [
    { id: 1, invite_id: 8, user_id: 2, joined_at: "2026-10-01T10:00:00Z" },
    { id: 2, invite_id: 7, user_id: 3, joined_at: new Date(joined).toISOString() },
  ],
  "roles/roles_roles": [
    { id: 1, name: "everyone", everyone: true, position: 0, permissions: "send_messages,edit_content" },
    { id: 2, name: "Guest", guest: true, position: 1, permissions: "send_messages" },
  ],
}) as Record<string, Record<string, ApiValue>[]>;

describe("chat sealing", () => {
  it("opens only with the same key, channel and author", () => {
    const key = newChannelKey();
    const sealed = sealText(key, 3, 50, 2, "hello");
    expect(epochOf(sealed)).toBe(3);
    expect(openText(key, 50, 2, sealed)).toBe("hello");
    expect(openText(key, 51, 2, sealed)).toBeNull();
    expect(openText(key, 50, 9, sealed)).toBeNull();
    expect(openText(newChannelKey(), 50, 2, sealed)).toBeNull();
    expect(epochOf("plain text")).toBeNull();
  });
});

describe("guests", () => {
  it("are guests from their guest join until promoted, with the Guest role's permissions only", () => {
    const tables = base();
    const rows = world(tables);
    expect([...guestsFrom(rows)]).toEqual([[3, joined]]);
    const roles = roleTablesFrom(rows);
    expect([...standing(roles, 3, owner).permissions]).toEqual(["send_messages"]);
    expect(standing(roles, 2, owner).permissions.has("edit_content")).toBe(true);
    tables["members/members_promotions"] = [{ id: 1, user_id: 3, created_at: new Date(joined + 1000).toISOString() }];
    expect(guestsFrom(world(tables)).size).toBe(0);
  });
});

describe("chat keys", () => {
  const epoch = (n: number, createdAt: number): Epoch => ({ channelId: 50, epoch: n, check: `c${n}`, createdBy: 1, createdAt });
  const key = (e: Epoch) => ({ id: e.epoch, channel_id: 50, epoch: e.epoch, check: e.check, created_by: 1, created_at: new Date(e.createdAt).toISOString() });

  it("lets a guest read only epochs made after they joined", () => {
    const rows = world(base());
    const roles = roleTablesFrom(rows);
    expect(mayRead(rows, roles, owner, 3, epoch(1, joined - 1))).toBe(false);
    expect(mayRead(rows, roles, owner, 3, epoch(2, joined + 1))).toBe(true);
    expect(mayRead(rows, roles, owner, 2, epoch(1, joined - 1))).toBe(true);
  });

  it("makes a new epoch for a guest, and when a holder lost access; otherwise gives what it holds", () => {
    const old = epoch(1, joined - 1);
    const tables: Record<string, Record<string, ApiValue>[]> = {
      ...base(), "chat/chat_keys": [key(old)], "chat/chat_key_grants": [{ id: 1, channel_id: 50, epoch: 1, user_id: 1 }],
    };
    expect(keyPlan(world(tables), roleTablesFrom(world(tables)), owner, 50, () => true).rotate).toBe("guest");

    const fresh = epoch(2, joined + 1);
    tables["chat/chat_keys"] = [key(old), key(fresh)];
    tables["chat/chat_key_grants"] = [
      { id: 1, channel_id: 50, epoch: 1, user_id: 1 }, { id: 2, channel_id: 50, epoch: 2, user_id: 1 }, { id: 3, channel_id: 50, epoch: 2, user_id: 3 },
    ];
    const plan = keyPlan(world(tables), roleTablesFrom(world(tables)), owner, 50, () => true);
    expect(plan.rotate).toBeNull();
    expect(plan.grants).toEqual([{ userId: 2, epoch: 1 }, { userId: 2, epoch: 2 }]);

    tables["members/members_profiles"] = tables["members/members_profiles"].filter((p) => p.user_id !== 3);
    expect(keyPlan(world(tables), roleTablesFrom(world(tables)), owner, 50, () => true).rotate).toBe("lost-access");
  });

  it("keeps a key's check short and stable", () => {
    const k = newChannelKey();
    expect(keyCheck(k)).toBe(keyCheck(k));
    expect(keyCheck(k)).toHaveLength(22);
  });
});
