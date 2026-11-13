// Who is out of a server (src/p2p/permissions.ts `kickedBy`): the one rule the ledger's policy, the member's own app
// and a node's calls all apply. Kicked means a kick row and no profile: a profile sent again (joining with an invite)
// lifts it, and the latest kick says who did it.
import { describe, expect, it } from "vitest";
import { kickedBy, type Row } from "../../src/p2p/permissions";

// Rows by plugin/table, filtered by `where` the way a ledger's select is.
function rowsOf(tables: Record<string, Row[]>) {
  return (plugin: string, table: string, where: Record<string, unknown> = {}): Row[] =>
    (tables[`${plugin}/${table}`] ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
}

describe("kickedBy", () => {
  it("is the latest kick of a member who has no profile", () => {
    const rows = rowsOf({
      "members/members_kicks": [{ id: 1, user_id: 7, kicked_by: 2 }, { id: 2, user_id: 7, kicked_by: 3 }],
    });
    expect(kickedBy(rows, 7)?.kicked_by).toBe(3);
  });

  it("is nobody for a member with a profile again, or never kicked", () => {
    const rows = rowsOf({
      "members/members_kicks": [{ id: 1, user_id: 7, kicked_by: 2 }],
      "members/members_profiles": [{ id: 5, user_id: 7 }, { id: 6, user_id: 8 }],
    });
    expect(kickedBy(rows, 7)).toBeNull();
    expect(kickedBy(rows, 8)).toBeNull();
  });
});
