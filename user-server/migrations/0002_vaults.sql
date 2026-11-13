-- Small encrypted documents only their account can read (the app encrypts them), e.g. the servers it joined.
-- `rev` goes up with every write, so two computers writing at once don't overwrite each other.
CREATE TABLE vaults (
  account TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account, name)
);
