-- Sign in with GitHub: the GitHub user id an account is linked to (one account per GitHub user).
ALTER TABLE accounts ADD COLUMN github_id TEXT;
ALTER TABLE accounts ADD COLUMN github_login TEXT;
CREATE UNIQUE INDEX accounts_by_github ON accounts (github_id);

-- A GitHub sign-in in progress: the app polls with its session id while the person is on GitHub.
CREATE TABLE oauth_sessions (
  session_hash TEXT PRIMARY KEY,
  state TEXT NOT NULL UNIQUE,
  result TEXT,
  created_at INTEGER NOT NULL
);

-- Proof of a GitHub sign-in, for linking that GitHub user to an account (a new one, or one signed in already).
CREATE TABLE github_tokens (
  token_hash TEXT PRIMARY KEY,
  github_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
