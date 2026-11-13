import { describe, expect, it } from "vitest";
import { canSee } from "../../src/p2p/visibility";
import type { RoleTables } from "../../src/p2p/permissions";

const roles: RoleTables = {
  roles: [
    { id: 1, name: "everyone", everyone: true, position: 0, permissions: "send_messages" },
    { id: 2, name: "staff", everyone: false, position: 10, permissions: "" },
    { id: 3, name: "muted", everyone: false, position: 5, permissions: "" },
    { id: 4, name: "admin", everyone: false, position: 20, permissions: "administrator" },
  ],
  members: [
    { id: 1, role_id: 2, user_id: 20 },
    { id: 2, role_id: 3, user_id: 20 },
    { id: 3, role_id: 3, user_id: 30 },
    { id: 4, role_id: 4, user_id: 40 },
  ],
  bans: [],
};
let next = 1;
const rule = (target: string, targetId: number, subject: string, subjectId: number, visible: boolean) =>
  ({ id: next++, target, target_id: targetId, subject, subject_id: subjectId, visible });

describe("canSee", () => {
  const rules = [
    rule("category", 100, "role", 1, false),
    rule("category", 100, "role", 2, true),
    rule("category", 100, "role", 3, false),
    rule("channel", 7, "member", 30, true),
    rule("channel", 8, "role", 1, true),
  ];
  const see = (userId: number, channelId?: number) => canSee(rules, roles, 1, userId, { channelId, categoryId: 100 });

  it("hides a category from everyone but the roles shown it", () => {
    expect(see(10)).toBe(false);
    expect(see(20)).toBe(true);
    expect(see(30)).toBe(false);
  });

  it("lets a channel's rules and member rules come first", () => {
    expect(see(30, 7)).toBe(true);
    expect(see(10, 7)).toBe(false);
    expect(see(10, 8)).toBe(true);
  });

  it("shows everything to the owner and administrators, and anything without rules", () => {
    expect(see(1)).toBe(true);
    expect(see(40)).toBe(true);
    expect(canSee(rules, roles, 1, 10, { categoryId: 200 })).toBe(true);
  });

  it("falls back to the roles' defaults for channels without rules", () => {
    const hidden: RoleTables = {
      ...roles,
      roles: roles.roles.map((r) => (r.everyone ? { ...r, channels: "hide" } : r.id === 2 ? { ...r, channels: "show" } : r)),
    };
    const open = [rule("channel", 9, "role", 1, true)];
    expect(canSee([], hidden, 1, 10, { channelId: 5, categoryId: 200 })).toBe(false);
    expect(canSee([], hidden, 1, 20, { channelId: 5, categoryId: 200 })).toBe(true);
    expect(canSee([], hidden, 1, 40, { channelId: 5, categoryId: 200 })).toBe(true);
    expect(canSee(open, hidden, 1, 10, { channelId: 9, categoryId: 200 })).toBe(true);
  });
});

describe("ruleSource", () => {
  it("names the rule that decides: the channel's before the category's, the member's before roles", async () => {
    const { ruleSource } = await import("../../src/p2p/visibility");
    const rules = [
      rule("category", 100, "member", 50, true),
      rule("channel", 9, "role", 1, false),
      rule("category", 100, "role", 2, true),
    ];
    const tables = { ...roles, mutes: [] };
    // The channel's own @everyone rule hides it, though the member's category rule shows the category.
    expect(ruleSource("visible", rules, tables, 50, { channelId: 9, categoryId: 100 })).toEqual({ value: false, subject: "everyone", at: "channel" });
    expect(ruleSource("visible", rules, tables, 50, { channelId: 10, categoryId: 100 })).toEqual({ value: true, subject: "member", at: "category" });
    expect(ruleSource("visible", rules, tables, 20, { channelId: 10, categoryId: 100 })).toEqual({ value: true, subject: "role", roleId: 2, at: "category" });
    expect(ruleSource("edit", rules, tables, 20, { channelId: 10, categoryId: 100 })).toBeUndefined();
  });
});
