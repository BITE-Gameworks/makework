import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client";
import { loadMembers, matchMembers, publishProfile } from "../../src/core/members";

// A workspace's members plugin: its profile rows, who "I" am, and the set-profile calls made.
function workspace(rows: Record<string, unknown>[], me = 7) {
  const calls: Record<string, unknown>[] = [];
  const api = {
    plugin: () => ({
      read: async (table: string) => (table === "members_profiles" ? rows : []),
      call: async (name: string, args: Record<string, unknown>) => {
        if (name === "whoami") return { user_id: me };
        calls.push(args);
        return { updated: true, created: false };
      },
      onEvent: () => () => {},
    }),
  } as unknown as ApiClient;
  return { api, calls };
}

describe("publishProfile", () => {
  const profile = { username: "ada", displayName: "Ada", color: "#123456", avatar: "gen:new" };
  const row = { user_id: 7, username: "ada", display_name: "Ada", color: "#123456", avatar: "gen:old" };

  it("sends the profile only where this account is a member and its copy differs", async () => {
    const stale = workspace([row]);
    const current = workspace([{ ...row, avatar: "gen:new" }]);
    const notMember = workspace([{ ...row, user_id: 8 }]);
    await loadMembers("stale", stale.api);
    await loadMembers("current", current.api);
    await loadMembers("not-member", notMember.api);

    await publishProfile(profile);

    expect(stale.calls).toEqual([{ username: "ada", display_name: "Ada", color: "#123456", avatar: "gen:new" }]);
    expect(current.calls).toEqual([]);
    expect(notMember.calls).toEqual([]);
  });
});

describe("matchMembers", () => {
  const people = [
    { displayName: "Bob Ann", username: "bob" },
    { displayName: "Annie", username: "annie" },
    { displayName: "Carl", username: "anders" },
    { displayName: "Dave", username: "dave" },
  ];

  it("finds by display name or username, the ones starting with the text first, then by name", () => {
    expect(matchMembers(people, "an").map((m) => m.displayName)).toEqual(["Annie", "Carl", "Bob Ann"]);
    expect(matchMembers(people, " ANN ").map((m) => m.displayName)).toEqual(["Annie", "Bob Ann"]);
  });

  it("lists everyone by name for empty text", () => {
    expect(matchMembers(people, "").map((m) => m.displayName)).toEqual(["Annie", "Bob Ann", "Carl", "Dave"]);
  });
});
