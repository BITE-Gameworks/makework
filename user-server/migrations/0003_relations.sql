-- Whether people who aren't friends may leave messages; friends only by default.
ALTER TABLE accounts ADD COLUMN allow_strangers INTEGER NOT NULL DEFAULT 0;

-- Friendship is mutual: one row each way.
CREATE TABLE friends (
  account TEXT NOT NULL,
  friend TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (account, friend)
);

CREATE TABLE friend_requests (
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sender, recipient)
);
CREATE INDEX friend_requests_by_recipient ON friend_requests (recipient);

CREATE TABLE blocks (
  account TEXT NOT NULL,
  blocked TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account, blocked)
);
