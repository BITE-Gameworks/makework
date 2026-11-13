-- Ids of deleted accounts, so a device still signed in can't publish one again. The id alone says nothing about its owner.
CREATE TABLE deleted_accounts (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
