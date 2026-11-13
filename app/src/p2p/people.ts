// Columns that name a member (a user id), in every plugin's tables. Used where people change places: moving a
// member to another account (core/memberMove.ts) and keeping authors on channel import (core/channelArchive.ts).
export const personColumns = new Set([
  "author_id", "user_id", "assignee_id", "pinned_by", "banned_by", "muted_by", "kicked_by", "imported_by", "updated_by",
]);

// Columns that say whom a row is about rather than who did something; a moved member's bans and kicks stay theirs.
export const subjectColumns: Record<string, string[]> = {
  "roles/roles_bans": ["user_id"],
  "members/members_kicks": ["user_id"],
};
