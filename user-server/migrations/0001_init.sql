-- Accounts: what others look people up by, and for password accounts the locked key they sign in with.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  profile TEXT NOT NULL,
  -- JSON {salt, iterations, locked}: the login salt and the private key locked with the password.
  login TEXT,
  -- SHA-256 of the key derived from the password for signing in; the password itself never arrives here.
  verifier TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Private messages waiting for their recipient, end-to-end encrypted. Deleted once the recipient confirms them.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_by_recipient ON messages (recipient, created_at);

-- Failed sign-ins per username, to slow down password guessing.
CREATE TABLE failures (
  username TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  since INTEGER NOT NULL
);
