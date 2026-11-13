-- People sign in by email; usernames are display names anyone may share (told apart by a tag from the id).
-- Rebuilt because SQLite can't drop the UNIQUE on username in place.
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  public_key TEXT NOT NULL,
  profile TEXT NOT NULL,
  login TEXT,
  verifier TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  allow_strangers INTEGER NOT NULL DEFAULT 0,
  -- Lowercase, confirmed with an emailed code.
  email TEXT UNIQUE,
  -- The account key encrypted with this server's RECOVERY_SECRET, for password resets; null once the owner turns it off.
  recovery_copy TEXT,
  -- 1 once the owner turned the copy off, so other devices don't make a new one.
  recovery_off INTEGER NOT NULL DEFAULT 0,
  -- The account key locked with the owner's recovery key, which this server never sees.
  recovery_locked TEXT
);
INSERT INTO accounts_new (id, username, public_key, profile, login, verifier, created_at, updated_at, allow_strangers)
  SELECT id, username, public_key, profile, login, verifier, created_at, updated_at, allow_strangers FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE INDEX accounts_by_username ON accounts (username);

-- Codes sent by email to confirm an address or start a password reset. Only a hash is kept.
CREATE TABLE email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  -- Sends in the current hour, to keep the server from being used to flood an inbox.
  sent INTEGER NOT NULL,
  sent_since INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);

-- A started password reset: whoever holds the token proved they read the account's email.
CREATE TABLE reset_tokens (
  token_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- A reset waiting for a device that is still signed in to hand over the key, sealed to the requester's key.
CREATE TABLE reset_requests (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL,
  sealed TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX reset_requests_by_account ON reset_requests (account, created_at);
